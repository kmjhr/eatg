/* ==========================================================================
   一咕（EATG）· 谷子款详情页（js/pages/goods_detail.js）
   实现：《详细开发指南》第4步 +《页面线框与UI规范》P03
   路由：#/goods/detail?id=<goods_id>
   内容：1 图片轮播（最多9张，点击全屏查看）
        2 信息区（名称/IP/角色/类型标签、状态角标→状态流转菜单、市场参考价）
        3 聚合区（总数量/总投入(含邮费)/均价/首次与最近购入价/累计盈利·估算标注）
        4 购入记录时间线（倒序）→ 点击进编辑（P05 复用 #/goods/edit?mode=edit&id=&pid=）
        5 卖出记录区块（日期/卖价/手续费/实收/盈利·估算标注）+ 新增卖出记录（校验剩余数量）
        6 行情区块（最近行情 + 走势缩略图 + 添加行情入口）
        7 底部操作：编辑 / 删除（二次确认 + 级联清理，《业务规则》§11）
   口径：金额「分」整数；换算与统计一律走《业务规则》§4/§5/§8；状态流转按《数据字典》§4。
   数据：一律走 EATG.storage；聚合走 EATG.agg（goods.agg 写回仅在本页发生改动时进行）。
   ========================================================================== */
(function (global) {
  'use strict';

  var EATG = (global.EATG = global.EATG || {});
  var S = EATG.storage;
  var A = EATG.agg;
  var U = EATG.utils;
  var UI = EATG.ui;

  EATG.pages = EATG.pages || {};

  var state = null;
  var dom = {};
  var offs = [];

  function on(el, ev, fn, opt) { if (!el) return; el.addEventListener(ev, fn, opt); offs.push([el, ev, fn, opt]); }
  function clearOffs() { offs.forEach(function (t) { t[0].removeEventListener(t[1], t[2], t[3]); }); offs = []; }
  function clone(o) { var r = {}; for (var k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = o[k]; } return r; }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function money(cents, cur) { return U.fmtMoney(cents, cur || 'CNY'); }
  function expectedError(msg) { var e = new Error(msg); e.expected = true; return e; }
  function cnyCents(cents, cur) { var r = U.toCnyCents(cents, cur); return (r == null || !isFinite(r)) ? 0 : r; }

  // 金额：元（字符串）<-> 分（整数），严格无浮点误差
  function yuanToCents(s) {
    s = String(s == null ? '' : s).trim();
    if (!s) return null;
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
    return Math.round(Number(s) * 100);
  }
  function centsToYuan(c) {
    if (c == null || !isFinite(Number(c))) return '';
    var fixed = (Number(c) / 100).toFixed(2);
    return fixed.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  }

  function resetState() {
    state = {
      destroyed: false,
      goodsId: null,
      goods: null,
      purchases: [],
      sales: [],
      prices: [],
      characters: [],
      byChar: {},
      enums: {},
      agg: null,
      viewer: null
    };
  }

  // ---- 派生计算（与 agg.js 同口径） ----

  function remaining(p) { return num(p.quantity) - num(p.sold_quantity); }

  function purchaseCostCny(p) {
    if (!p || p.price_status === 'unknown' || p.unit_price == null) return 0;
    return cnyCents(num(p.unit_price) * num(p.quantity), p.currency) + cnyCents(num(p.shipping_share), p.currency);
  }
  function saleNetCny(s) {
    if (!s) return 0;
    return cnyCents(num(s.unit_price) * num(s.quantity), s.currency) - cnyCents(num(s.fee), s.currency) - cnyCents(num(s.shipping_cost), s.currency);
  }
  function lineProfitCny(s) {
    var p = null;
    state.purchases.forEach(function (it) { if (Number(it.id) === Number(s.purchase_item_id)) p = it; });
    if (!p || p.price_status === 'unknown') return { value: null, kind: 'unknown' };
    var cost = A.proratedPurchaseCost(p, s.quantity);
    var v = saleNetCny(s) - cost;
    return { value: v, kind: p.price_status === 'estimated' ? 'estimated' : 'filled' };
  }

  function sortedPurchases() {
    return state.purchases.slice().sort(function (a, b) {
      return String(b.buy_date || '').localeCompare(String(a.buy_date || '')) || (Number(b.id) - Number(a.id));
    });
  }
  function sortedSales() {
    return state.sales.slice().sort(function (a, b) {
      return String(b.sale_date || '').localeCompare(String(a.sale_date || '')) || (Number(b.id) - Number(a.id));
    });
  }
  function pricesAsc() {
    return state.prices.slice().sort(function (a, b) {
      return String(a.record_date || '').localeCompare(String(b.record_date || '')) || (Number(a.id) - Number(b.id));
    });
  }

  /** 首次 / 最近购入（按 buy_date，取含单价的记录） */
  function firstLastPrice() {
    var withPrice = sortedPurchases().slice().reverse().filter(function (p) { return p.unit_price != null; });
    if (!withPrice.length) return null;
    return { first: withPrice[0], last: withPrice[withPrice.length - 1] };
  }

  /** filled 口径件数（用于均价） */
  function filledQty() {
    var q = 0;
    state.purchases.forEach(function (p) { if (p.price_status === 'filled' && p.unit_price != null) q += num(p.quantity); });
    return q;
  }

  function charNames(ids) {
    var out = [];
    (ids || []).forEach(function (cid) {
      var c = state.byChar[cid];
      if (c) out.push(c);
    });
    return out;
  }

  // ---- 数据加载 ----

  function fetchAll() {
    var id = state.goodsId;
    return Promise.all([
      S.get('goods', id),
      S.query('purchase_items', 'goods_id', id),
      S.query('sale_items', 'goods_id', id),
      S.query('price_records', 'goods_id', id),
      S.getAll('characters'),
      S.getAll('enums')
    ]).then(function (r) {
      if (!r[0]) throw expectedError('未找到该谷子款（id=' + id + '）');
      state.goods = r[0];
      state.purchases = r[1] || [];
      state.sales = r[2] || [];
      state.prices = r[3] || [];
      state.characters = r[4] || [];
      state.byChar = {};
      state.characters.forEach(function (c) { state.byChar[Number(c.id)] = c; });
      var em = {};
      (r[5] || []).forEach(function (row) { em[row.key] = row.values || []; });
      state.enums = em;
      state.agg = A.computeGoodsAgg(state.goods, state.purchases, state.sales);
    });
  }

  // ---- 模板 ----

  function skeletonHTML() {
    return '<div class="skeleton skeleton-bar" style="width:100%;height:200px;margin-bottom:12px"></div>' +
      '<div class="skeleton skeleton-bar" style="width:55%;height:22px;margin-bottom:8px"></div>' +
      '<div class="skeleton skeleton-bar" style="width:100%;height:88px;margin-bottom:12px"></div>' +
      '<div class="skeleton skeleton-bar" style="width:100%;height:160px"></div>';
  }

  function badgeHTML(status) {
    if (!status) return '<span class="badge badge--none">未录入</span>';
    return '<span class="badge badge--' + status + '">' + UI.esc(A.STATUS_LABELS[status] || status) + '</span>';
  }

  function carouselHTML() {
    var imgs = (state.goods.images || []);
    var g = state.goods;
    if (!imgs.length) {
      return '<div class="carousel"><div class="carousel-ph">' + UI.esc(g.goods_type || '暂无图片') + '</div></div>';
    }
    var slides = imgs.map(function (src, i) {
      return '<img class="carousel-slide" src="' + src + '" alt="" data-act="viewer-open" data-i="' + i + '">';
    }).join('');
    var dots = imgs.length > 1 ? '<div class="carousel-dots" id="d-dots">' + imgs.map(function (_, i) {
      return '<span class="carousel-dot' + (i === 0 ? ' is-on' : '') + '" data-dot="' + i + '"></span>';
    }).join('') + '</div>' : '';
    return '<div class="carousel">' +
      '<div class="carousel-track" id="d-track">' + slides + '</div>' +
      (imgs.length > 1 ? '<div class="carousel-count num" id="d-count">1 / ' + imgs.length + '</div>' : '') +
      dots +
      '</div>';
  }

  function infoHTML() {
    var g = state.goods;
    var chars = charNames(g.character_ids);
    var chips = '<span class="chip">' + UI.esc(g.ip || '—') + '</span>' +
      chars.map(function (c) { return '<span class="chip chip--char' + (c.is_favorite ? ' is-fav' : '') + '">' + UI.esc(c.name) + '</span>'; }).join('') +
      (g.goods_type ? '<span class="chip chip--type">' + UI.esc(g.goods_type) + '</span>' : '');
    var tags = (g.tags || []).map(function (t) { return '<span class="tag">' + UI.esc(t) + '</span>'; }).join('');
    var mp = (g.market_price == null) ? '<span class="muted">未设置</span>' : '<span class="num market-price">' + money(g.market_price) + '</span>';

    return '<section class="detail-info">' +
      '<div class="detail-title-row">' +
        '<h1 class="detail-name">' + UI.esc(g.name || '未命名') + '</h1>' +
        '<button type="button" class="badge-btn" data-act="status" aria-label="状态流转">' + badgeHTML(state.agg.status) + '</button>' +
      '</div>' +
      '<div class="chip-row">' + chips + '</div>' +
      (tags ? '<div class="chip-row detail-tags">' + tags + '</div>' : '') +
      '<div class="detail-market-row"><span class="muted">市场参考价</span>' + mp + '</div>' +
      (g.note ? '<p class="detail-note">' + UI.esc(g.note) + '</p>' : '') +
      '</section>';
  }

  function aggHTML() {
    var agg = state.agg;
    var fq = filledQty();
    var avg = fq > 0 ? Math.round(agg.filled_only_cost / fq) : null;

    function profitCell() {
      var v = agg.total_profit;
      var cls = v > 0 ? 'up' : (v < 0 ? 'down' : '');
      var html = '<div class="agg-num num ' + cls + '">' + money(v) + '</div>';
      if (agg.estimated_profit) {
        html += '<div class="est-tag">另估算 ' + money(agg.estimated_profit) + '</div>';
      }
      return html;
    }

    var fl = firstLastPrice();
    var pricePair = '<div class="price-pair">' +
      '<div class="price-pair-item"><span class="muted">首次购入价</span><span class="num">' +
        (fl && fl.first.unit_price != null ? money(fl.first.unit_price, fl.first.currency) : '--') + '</span></div>' +
      '<div class="price-pair-item"><span class="muted">最近购入价</span><span class="num">' +
        (fl && fl.last.unit_price != null ? money(fl.last.unit_price, fl.last.currency) : '--') + '</span></div>' +
      '</div>';

    return '<section class="block agg-block">' +
      '<div class="agg-grid">' +
        '<div class="agg-cell"><div class="agg-num num">' + num(agg.total_qty) + '</div><div class="agg-label">总数量</div></div>' +
        '<div class="agg-cell"><div class="agg-num num">' + money(agg.filled_only_cost) + '</div><div class="agg-label">总投入（含邮费）</div>' +
          (agg.estimated_cost ? '<div class="est-tag">另估算 ' + money(agg.estimated_cost) + '</div>' : '') + '</div>' +
        '<div class="agg-cell"><div class="agg-num num">' + (avg == null ? '--' : money(avg)) + '</div><div class="agg-label">均价（已填写）</div></div>' +
        '<div class="agg-cell"><div class="agg-label">累计盈利</div>' + profitCell() + '</div>' +
      '</div>' +
      pricePair +
      (agg.unknown_qty ? '<p class="hint">价格未知 ' + num(agg.unknown_qty) + ' 件：成本未知，暂不计盈利。</p>' : '') +
      '</section>';
  }

  function timelineHTML() {
    var list = sortedPurchases();
    var head = '<div class="block-head"><h3 class="block-title">购入记录（' + list.length + '）</h3>' +
      '<button type="button" class="block-action" data-act="add-purchase">＋ 新增购入记录</button></div>';
    if (!list.length) {
      return '<section class="block">' + head + '<p class="empty-line">暂无购入记录</p></section>';
    }
    var items = list.map(function (p) {
      var ps = p.price_status || 'unknown';
      var priceTag = ps === 'estimated' ? '<span class="tag tag--est">估算</span>'
        : (ps === 'unknown' ? '<span class="tag tag--unknown">价格未知</span>' : '');
      var unit = p.unit_price == null ? '<span class="muted">单价未知</span>' : '<span class="num">' + money(p.unit_price, p.currency) + '</span>';
      var ship = num(p.shipping_share) ? '<span class="muted">邮费 ' + money(p.shipping_share, p.currency) + '</span>' : '<span class="muted">未分摊邮费</span>';
      var qty = '×' + num(p.quantity) + (num(p.sold_quantity) ? '（已卖 ' + num(p.sold_quantity) + '）' : '');
      return '<article class="tl-item" data-act="edit-purchase" data-pid="' + p.id + '">' +
        '<div class="tl-dot badge--' + UI.esc(p.status || 'on_hand') + '"></div>' +
        '<div class="tl-body">' +
          '<div class="tl-head">' +
            '<span class="tl-date num">' + UI.esc(p.buy_date || '—') + '</span>' +
            badgeHTML(p.status) + priceTag +
          '</div>' +
          '<div class="tl-row"><span class="tl-qty num">' + qty + '</span>' + unit + ship + '</div>' +
          '<div class="tl-row muted"><span>渠道：' + UI.esc(p.channel || '—') + '</span>' +
            '<span>价格状态：' + UI.esc(A.PRICE_LABELS[ps] || ps) + '</span></div>' +
          (p.deposit != null || p.balance != null || p.payment_deadline
            ? '<div class="tl-row muted"><span>定金 ' + (p.deposit == null ? '--' : money(p.deposit, p.currency)) +
              ' · 尾款 ' + (p.balance == null ? '--' : money(p.balance, p.currency)) +
              (p.payment_deadline ? ' · 补款截止 ' + UI.esc(p.payment_deadline) : '') + '</span></div>' : '') +
          (p.note ? '<div class="tl-note">' + UI.esc(p.note) + '</div>' : '') +
          (p.order_id != null
            ? '<div class="tl-row"><button type="button" class="tl-order-link" data-act="goto-order" data-oid="' + p.order_id + '">来自订单 · 查看订单 ›</button></div>'
            : '') +
        '</div>' +
        '<span class="tl-edit">编辑 ›</span>' +
        '</article>';
    }).join('');
    return '<section class="block">' + head + '<div class="timeline">' + items + '</div></section>';
  }

  function salesHTML() {
    var list = sortedSales();
    var head = '<div class="block-head"><h3 class="block-title">卖出记录（' + list.length + '）</h3>' +
      '<div class="block-actions">' +
      '<button type="button" class="block-action" data-act="batch-sale">批量卖出</button>' +
      '<button type="button" class="block-action" data-act="add-sale">＋ 新增卖出记录</button>' +
      '</div></div>';
    if (!list.length) {
      return '<section class="block">' + head + '<p class="empty-line">暂无卖出记录</p></section>';
    }
    var items = list.map(function (s) {
      var net = (s.net_amount != null) ? s.net_amount : (num(s.unit_price) * num(s.quantity) - num(s.fee) - num(s.shipping_cost));
      var pf = lineProfitCny(s);
      var profit;
      if (pf.value == null) profit = '<span class="tag tag--unknown">成本未知，暂不计盈利</span>';
      else {
        var cls = pf.value > 0 ? 'up' : (pf.value < 0 ? 'down' : '');
        profit = '<span class="num profit ' + cls + '">' + money(pf.value) + '</span>' +
          (pf.kind === 'estimated' ? '<span class="tag tag--est">估算</span>' : '');
      }
      var orderLink = s.sale_order_id
        ? '<button type="button" class="tl-order-link" data-act="goto-sale-order" data-soid="' + s.sale_order_id + '">来自卖出订单 ›</button>'
        : '';
      return '<article class="sale-item" data-sid="' + s.id + '">' +
        '<div class="sale-head"><span class="num">' + UI.esc(s.sale_date || '—') + '</span><span class="muted">' + UI.esc(s.channel || '—') + '</span>' +
          '<div class="sale-actions">' +
            '<button type="button" class="icon-btn" data-act="edit-sale" data-sid="' + s.id + '" title="编辑">编辑</button>' +
            '<button type="button" class="icon-btn icon-btn--danger" data-act="del-sale" data-sid="' + s.id + '" title="删除">删除</button>' +
          '</div>' +
        '</div>' +
        '<div class="sale-row"><span class="muted">卖价</span><span class="num">' + money(num(s.unit_price) * num(s.quantity), s.currency) + '</span></div>' +
        '<div class="sale-row"><span class="muted">手续费</span><span class="num">' + money(num(s.fee), s.currency) + '</span></div>' +
        '<div class="sale-row"><span class="muted">实收</span><span class="num">' + money(net, s.currency) + '</span></div>' +
        '<div class="sale-row"><span class="muted">盈利</span>' + profit + '</div>' +
        (orderLink ? '<div class="tl-row">' + orderLink + '</div>' : '') +
        '</article>';
    }).join('');
    return '<section class="block">' + head + '<div class="sales-list">' + items + '</div></section>';
  }

  function marketHTML() {
    var asc = pricesAsc();
    var latest = asc.length ? asc[asc.length - 1] : null;
    var head = '<div class="block-head"><h3 class="block-title">行情</h3>' +
      '<button type="button" class="block-action" data-act="add-price">＋ 添加行情</button></div>';
    if (!latest) {
      return '<section class="block">' + head + '<p class="empty-line">暂无行情记录</p></section>';
    }
    return '<section class="block">' + head +
      '<div class="market-latest">' +
        '<span class="num market-price">' + money(latest.price, latest.currency) + '</span>' +
        '<span class="muted">' + UI.esc(latest.platform || '—') + ' · ' + UI.esc(latest.record_date || '') + '</span>' +
      '</div>' +
      '<canvas class="spark" id="d-spark"></canvas>' +
      '<p class="hint">' + (asc.length > 1 ? '近 ' + asc.length + ' 条行情走势' : '行情记录不足，暂无法绘制走势') + '</p>' +
      '</section>';
  }

  function actionsHTML() {
    return '<div class="detail-spacer" aria-hidden="true"></div>' +
      '<div class="detail-actions">' +
        '<button type="button" class="btn btn--secondary" data-act="edit-goods">编辑</button>' +
        '<button type="button" class="btn btn--danger" data-act="del-goods">删除</button>' +
      '</div>';
  }

  function pageHTML() {
    return '<section class="page page--detail">' +
      carouselHTML() + infoHTML() + aggHTML() + timelineHTML() + salesHTML() + marketHTML() + actionsHTML() +
      '</section>';
  }

  // ---- 渲染 ----

  function render() {
    dom.container.innerHTML = pageHTML();
    cacheDom();
    bindPageEvents();
    drawSpark();
    updateCarouselMeta();
  }

  function cacheDom() {
    var c = dom.container;
    dom.page = c.querySelector('.page--detail');
    dom.track = c.querySelector('#d-track');
    dom.count = c.querySelector('#d-count');
    dom.dots = c.querySelector('#d-dots');
    dom.spark = c.querySelector('#d-spark');
  }

  function updateCarouselMeta() {
    if (!dom.track) return;
    var slides = dom.track.querySelectorAll('.carousel-slide');
    if (!slides.length) return;
    var w = dom.track.clientWidth || 1;
    var idx = Math.round(dom.track.scrollLeft / w);
    if (dom.count) dom.count.textContent = (idx + 1) + ' / ' + slides.length;
    if (dom.dots) {
      var ds = dom.dots.querySelectorAll('.carousel-dot');
      for (var i = 0; i < ds.length; i++) ds[i].classList.toggle('is-on', i === idx);
    }
  }

  /** 行情走势缩略图（Canvas 自绘，无外部依赖） */
  function drawSpark() {
    var cv = dom.spark;
    if (!cv || !cv.getContext) return;
    var pts = pricesAsc();
    var dpr = global.devicePixelRatio || 1;
    var w = cv.clientWidth || 300;
    var h = 48;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (pts.length < 2) {
      ctx.fillStyle = '#8E8E8E';
      ctx.font = '11px sans-serif';
      ctx.fillText('数据不足', 8, h / 2 + 4);
      return;
    }
    var vals = pts.map(function (p) { return cnyCents(p.price, p.currency); });
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    var span = (max - min) || 1;
    var pad = 6;
    var stepX = (w - pad * 2) / (vals.length - 1);
    var xs = [], ys = [];
    vals.forEach(function (v, i) {
      xs.push(pad + i * stepX);
      ys.push(pad + (h - pad * 2) * (1 - (v - min) / span));
    });
    // 填充
    ctx.beginPath();
    ctx.moveTo(xs[0], h - pad);
    xs.forEach(function (x, i) { ctx.lineTo(x, ys[i]); });
    ctx.lineTo(xs[xs.length - 1], h - pad);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 221, 136, 0.35)';
    ctx.fill();
    // 折线
    ctx.beginPath();
    xs.forEach(function (x, i) { if (i === 0) ctx.moveTo(x, ys[i]); else ctx.lineTo(x, ys[i]); });
    ctx.strokeStyle = '#B99430';
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();
    // 末点
    ctx.beginPath();
    ctx.arc(xs[xs.length - 1], ys[ys.length - 1], 2.5, 0, Math.PI * 2);
    ctx.fillStyle = '#B99430';
    ctx.fill();
  }

  // ---- 事件 ----

  function bindPageEvents() {
    if (!dom.page) return;
    on(dom.page, 'click', function (e) {
      var act = e.target.closest('[data-act]');
      if (!act) return;
      var a = act.dataset.act;
      if (a === 'viewer-open') { openViewer(Number(act.dataset.i)); return; }
      if (a === 'status') { openStatusSheet(); return; }
      if (a === 'add-purchase') { go('#/goods/edit?mode=edit&id=' + state.goodsId + '&newp=1'); return; }
      if (a === 'edit-purchase') { go('#/goods/edit?mode=edit&id=' + state.goodsId + '&pid=' + act.dataset.pid); return; }
      if (a === 'goto-order') { go('#/order/edit?id=' + act.dataset.oid); return; }
      if (a === 'add-sale') { openSaleSheet(); return; }
      if (a === 'edit-sale') { go('#/sale/edit?sid=' + act.dataset.sid); return; }
      if (a === 'del-sale') { doDeleteSale(Number(act.dataset.sid)); return; }
      if (a === 'batch-sale') { go('#/sale/edit?mode=new&goods_id=' + state.goodsId); return; }
      if (a === 'goto-sale-order') { go('#/sale/edit?id=' + act.dataset.soid); return; }
      if (a === 'add-price') { go('#/market/add?goods_id=' + state.goodsId); return; }
      if (a === 'edit-goods') { go('#/goods/edit?mode=edit&id=' + state.goodsId); return; }
      if (a === 'del-goods') { doDelete(); return; }
    });

    if (dom.track) {
      on(dom.track, 'scroll', updateCarouselMeta);
    }
    if (dom.dots) {
      on(dom.dots, 'click', function (e) {
        var d = e.target.closest('[data-dot]');
        if (!d || !dom.track) return;
        var idx = Number(d.dataset.dot);
        var w = dom.track.clientWidth || 1;
        dom.track.scrollTo({ left: idx * w, behavior: 'smooth' });
      });
    }
    on(global, 'resize', function () { drawSpark(); updateCarouselMeta(); });
  }

  function go(hash) {
    if (EATG.app && EATG.app.navigate) EATG.app.navigate(hash);
    else global.location.hash = hash;
  }

  // ---- 全屏查看 ----

  function openViewer(index) {
    var imgs = state.goods.images || [];
    if (!imgs.length || index < 0 || index >= imgs.length) return;
    var root = document.getElementById('modal-root');
    if (!root) return;
    closeViewer();
    root.hidden = false;
    var i = index;
    var el = document.createElement('div');
    el.className = 'viewer';
    function paint() {
      el.innerHTML =
        '<img class="viewer-img" src="' + imgs[i] + '" alt="">' +
        '<button type="button" class="viewer-close" data-v="close" aria-label="关闭">✕</button>' +
        (imgs.length > 1 ? '<button type="button" class="viewer-nav viewer-nav--prev" data-v="prev" aria-label="上一张">‹</button>' +
          '<button type="button" class="viewer-nav viewer-nav--next" data-v="next" aria-label="下一张">›</button>' +
          '<span class="viewer-count num">' + (i + 1) + ' / ' + imgs.length + '</span>' : '');
    }
    paint();
    el.addEventListener('click', function (e) {
      var b = e.target.closest('[data-v]');
      if (b) {
        var v = b.dataset.v;
        if (v === 'close') { closeViewer(); return; }
        if (v === 'prev') { i = (i - 1 + imgs.length) % imgs.length; paint(); return; }
        if (v === 'next') { i = (i + 1) % imgs.length; paint(); return; }
      }
      if (e.target === el) closeViewer();
    });
    root.appendChild(el);
    state.viewer = el;
  }

  function closeViewer() {
    var el = state.viewer;
    if (el && el.parentNode) el.parentNode.removeChild(el);
    state.viewer = null;
    var root = document.getElementById('modal-root');
    if (root && !root.children.length) root.hidden = true;
  }

  // ---- 状态流转（《数据字典》§4：可前进 1 步；可回退到任意前序状态，需确认） ----

  function legalTargets(cur) {
    if (!cur) return [];
    var r = A.STATUS_RANK[cur];
    if (r == null) return [];
    var out = [];
    if (r + 1 < A.STATUS_ORDER.length) out.push({ v: A.STATUS_ORDER[r + 1], kind: 'forward' });
    A.STATUS_ORDER.forEach(function (s) {
      if (A.STATUS_RANK[s] < r) out.push({ v: s, kind: 'back' });
    });
    return out;
  }

  function applyStatus(target) {
    var ops = [], next = [], count = 0;
    state.purchases.forEach(function (p) {
      if (remaining(p) <= 0) { next.push(p); return; }
      var rec = clone(p);
      rec.status = target;
      next.push(rec);
      ops.push({ action: 'put', store: 'purchase_items', value: rec });
      count++;
    });
    if (!count) return Promise.resolve(0);
    var g = clone(state.goods);
    g.agg = A.computeGoodsAgg(g, next, state.sales);
    ops.push({ action: 'put', store: 'goods', value: g });
    return S.bulk(['purchase_items', 'goods'], ops).then(function () { return count; });
  }

  function openStatusSheet() {
    var cur = state.agg.status;
    if (!cur) { UI.toast('暂无购入记录可流转', 'error'); return; }
    var targets = legalTargets(cur);
    if (!targets.length) { UI.toast('当前状态无可流转的目标', 'error'); return; }
    var ref = UI.sheet({
      title: '状态流转',
      bodyHTML: '<p class="hint">当前：' + UI.esc(A.STATUS_LABELS[cur] || cur) +
        '；仅可前进 1 步，回退到前序状态需二次确认。「已出荷」不可再前进。</p>' +
        '<div class="opt-list">' + targets.map(function (t) {
          return '<button type="button" class="opt-row" data-target="' + t.v + '" data-kind="' + t.kind + '">' +
            '<span>' + UI.esc(A.STATUS_LABELS[t.v] || t.v) + '</span>' +
            '<span class="opt-kind">' + (t.kind === 'forward' ? '前进' : '回退') + '</span>' +
            '</button>';
        }).join('') + '</div>'
    });
    ref.body.addEventListener('click', function (e) {
      var row = e.target.closest('[data-target]');
      if (!row) return;
      var target = row.dataset.target;
      var kind = row.dataset.kind;
      ref.close();
      var run = function () { return applyStatus(target); };
      var chain = kind === 'back'
        ? UI.confirmDialog({
            title: '回退状态',
            message: '将「' + state.goods.name + '」的剩余件由「' + A.STATUS_LABELS[cur] + '」回退为「' +
              A.STATUS_LABELS[target] + '」？',
            confirmText: '回退'
          }).then(function (ok) { return ok ? run() : 0; })
        : run();
      chain.then(function (n) {
        if (!n) { UI.toast('没有可流转的购入记录', 'error'); return; }
        UI.toast('已置为「' + (A.STATUS_LABELS[target] || target) + '」', 'success');
        return refresh();
      }).catch(function (err) {
        if (!(err && err.expected)) console.error('[EATG] 状态流转失败', err);
        UI.toast('流转失败：' + (err && err.message || err), 'error');
      });
    });
  }

  // ---- 新增卖出记录（校验剩余数量） ----

  function saleFormHTML(avail, cur) {
    var opts = avail.map(function (p) {
      return '<option value="' + p.id + '">' +
        UI.esc((p.buy_date || '—') + ' · 剩 ' + remaining(p) + ' 件 · ' +
          (p.unit_price == null ? '单价未知' : centsToYuan(p.unit_price) + ' 元')) + '</option>';
    }).join('');
    var channels = (state.enums.sale_channel || []).map(function (c) {
      return '<option value="' + UI.esc(c) + '">' + UI.esc(c) + '</option>';
    }).join('');
    return '<div class="field">' +
        '<div class="field-head"><label class="field-label" for="s-pid">关联购入记录</label></div>' +
        '<select id="s-pid" class="input">' + opts + '</select>' +
        '<p class="hint" id="s-remain"></p>' +
      '</div>' +
      '<div class="field"><div class="field-head"><label class="field-label" for="s-date">卖出日期</label></div>' +
        '<input id="s-date" class="input" type="date"></div>' +
      '<div class="field"><div class="field-head"><label class="field-label" for="s-qty">数量</label></div>' +
        '<input id="s-qty" class="input" type="number" min="1" step="1" inputmode="numeric" placeholder="1"></div>' +
      '<div class="field"><div class="field-head"><label class="field-label" for="s-price">卖出单价</label></div>' +
        '<div class="money-input"><input id="s-price" class="input" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00">' +
        '<span class="unit">' + UI.esc(cur === 'JPY' ? '日元' : '元') + '</span></div></div>' +
      '<div class="field"><div class="field-head"><label class="field-label" for="s-currency">币种</label></div>' +
        '<select id="s-currency" class="input">' +
          ['CNY', 'JPY', '其他'].map(function (c) { return '<option value="' + c + '"' + (c === cur ? ' selected' : '') + '>' + c + '</option>'; }).join('') +
        '</select></div>' +
      '<div class="field"><div class="field-head"><label class="field-label" for="s-fee">手续费</label></div>' +
        '<div class="money-input"><input id="s-fee" class="input" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00"></div></div>' +
      '<div class="field"><div class="field-head"><label class="field-label" for="s-ship">卖家邮费</label></div>' +
        '<div class="money-input"><input id="s-ship" class="input" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00"></div></div>' +
      '<div class="field"><div class="field-head"><label class="field-label" for="s-channel">卖出渠道</label></div>' +
        '<select id="s-channel" class="input"><option value="">不填</option>' + channels + '</select></div>' +
      '<div class="field"><div class="field-head"><label class="field-label" for="s-note">备注</label></div>' +
        '<textarea id="s-note" class="textarea" placeholder="如：合卖折算、买家说明"></textarea></div>';
  }

  function openSaleSheet() {
    var avail = state.purchases.filter(function (p) { return remaining(p) > 0; });
    if (!avail.length) { UI.toast('暂无可卖出的购入记录（剩余件为 0）', 'error'); return; }
    var cur = avail[0].currency || (EATG.runtime && EATG.runtime.defaultCurrency) || 'CNY';
    var ref = UI.sheet({
      title: '新增卖出记录',
      bodyHTML: saleFormHTML(avail, cur),
      footerHTML: '<button type="button" class="btn btn--secondary" data-act="cancel">取消</button>' +
        '<button type="button" class="btn btn--primary" data-act="ok">保存</button>'
    });
    var body = ref.body;
    var selEl = body.querySelector('#s-pid');
    var dateEl = body.querySelector('#s-date');
    var qtyEl = body.querySelector('#s-qty');
    var priceEl = body.querySelector('#s-price');
    var curEl = body.querySelector('#s-currency');
    var feeEl = body.querySelector('#s-fee');
    var shipEl = body.querySelector('#s-ship');
    var chanEl = body.querySelector('#s-channel');
    var noteEl = body.querySelector('#s-note');
    var remainEl = body.querySelector('#s-remain');

    if (dateEl) dateEl.value = U.todayStr();
    if (qtyEl) qtyEl.value = '1';

    function currentPurchase() {
      var id = Number(selEl && selEl.value);
      var hit = null;
      avail.forEach(function (p) { if (Number(p.id) === id) hit = p; });
      return hit;
    }
    function syncRemain() {
      var p = currentPurchase();
      if (!p || !remainEl) return;
      remainEl.textContent = '该购入记录剩余 ' + remaining(p) + ' 件；卖出后将自动扣减，售完置「已出荷」。';
      if (qtyEl) qtyEl.setAttribute('max', String(remaining(p)));
    }
    selEl && selEl.addEventListener('change', syncRemain);
    syncRemain();

    ref.foot.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'cancel') { ref.close(); return; }
      // 保存
      var p = currentPurchase();
      if (!p) { UI.toast('请选择关联购入记录', 'error'); return; }
      var qty = Number(qtyEl.value);
      if (!isFinite(qty) || qty <= 0 || Math.floor(qty) !== qty) { UI.toast('数量必须为大于 0 的整数', 'error'); return; }
      if (qty > remaining(p)) { UI.toast('卖出数量超过剩余可卖（' + remaining(p) + ' 件）', 'error'); return; }
      var price = yuanToCents(priceEl.value);
      if (price == null || isNaN(price)) { UI.toast('请填写合法的卖出单价（最多两位小数）', 'error'); return; }
      var fee = yuanToCents(feeEl.value); if (isNaN(fee)) { UI.toast('手续费格式不正确', 'error'); return; }
      var ship = yuanToCents(shipEl.value); if (isNaN(ship)) { UI.toast('卖家邮费格式不正确', 'error'); return; }
      fee = fee == null ? 0 : fee;
      ship = ship == null ? 0 : ship;
      var curSel = curEl.value || p.currency || 'CNY';
      var net = price * qty - fee - ship;

      var saleRec = {
        goods_id: state.goodsId,
        purchase_item_id: Number(p.id),
        sale_date: dateEl.value || U.todayStr(),
        quantity: qty,
        unit_price: price,
        currency: curSel,
        fee: fee,
        shipping_cost: ship,
        net_amount: net,
        channel: chanEl.value || '',
        note: (noteEl.value || '').trim()
      };
      var pRec = clone(p);
      pRec.sold_quantity = num(p.sold_quantity) + qty;
      if (pRec.sold_quantity >= num(p.quantity)) pRec.status = 'sold_out';
      var nextPurchases = state.purchases.map(function (it) { return Number(it.id) === Number(p.id) ? pRec : it; });
      var g = clone(state.goods);
      g.agg = A.computeGoodsAgg(g, nextPurchases, state.sales.concat([saleRec]));

      ref.close();
      S.bulk(['sale_items', 'purchase_items', 'goods'], [
        { action: 'add', store: 'sale_items', value: saleRec },
        { action: 'put', store: 'purchase_items', value: pRec },
        { action: 'put', store: 'goods', value: g }
      ]).then(function () {
        UI.toast('已新增卖出记录', 'success');
        return refresh();
      }).catch(function (err) {
        if (!(err && err.expected)) console.error('[EATG] 新增卖出记录失败', err);
        UI.toast('保存失败：' + (err && err.message || err), 'error');
      });
    });
  }

  // ---- 删除单件卖出记录（还原购入记录：sold_quantity 减回、状态还原）----
  function doDeleteSale(saleId) {
    var s = null;
    state.sales.forEach(function (it) { if (Number(it.id) === saleId) s = it; });
    if (!s) { UI.toast('卖出记录不存在', 'error'); return; }
    UI.confirmDialog({
      title: '删除卖出记录',
      message: '确认删除该条卖出记录？将还原对应购入记录的剩余数量与状态。',
      confirmText: '删除',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      var p = null;
      state.purchases.forEach(function (it) { if (Number(it.id) === Number(s.purchase_item_id)) p = it; });
      var ops = [{ action: 'del', store: 'sale_items', key: saleId }];
      if (p) {
        var pRec = clone(p);
        pRec.sold_quantity = Math.max(0, num(p.sold_quantity) - num(s.quantity));
        // 状态还原：原非 sold_out 则还原为原状态；若曾因该笔卖出置 sold_out 且仍有剩余，还原
        if (pRec.sold_quantity < num(p.quantity)) {
          pRec.status = p._origStatus || p.status;
          // 若原本是 sold_out 但删除后有剩余，回退到 on_hand
          if (pRec.status === 'sold_out') pRec.status = 'on_hand';
        }
        ops.push({ action: 'put', store: 'purchase_items', value: pRec });
      }
      var g = clone(state.goods);
      var nextSales = state.sales.filter(function (it) { return Number(it.id) !== saleId; });
      var nextPurchases = p ? state.purchases.map(function (it) { return Number(it.id) === Number(p.id) ? (function(){ var r=clone(p); r.sold_quantity = Math.max(0, num(r.sold_quantity)-num(s.quantity)); if(r.sold_quantity<num(r.quantity)){ r.status = r._origStatus || r.status; if(r.status==='sold_out') r.status='on_hand'; } return r; })() : it; }) : state.purchases;
      g.agg = A.computeGoodsAgg(g, nextPurchases, nextSales);
      ops.push({ action: 'put', store: 'goods', value: g });
      S.bulk(['sale_items', 'purchase_items', 'goods'], ops).then(function () {
        UI.toast('已删除卖出记录', 'success');
        return refresh();
      }).catch(function (err) {
        if (!(err && err.expected)) console.error('[EATG] 删除卖出记录失败', err);
        UI.toast('删除失败：' + (err && err.message || err), 'error');
      });
    });
  }

  // ---- 删除（二次确认 + 级联清理，《业务规则》§11） ----

  function doDelete() {
    UI.confirmDialog({
      title: '删除谷子款',
      message: '将删除「' + state.goods.name + '」及其购入记录、卖出记录、行情记录；订单保留但解除关联。此操作不可撤销。',
      confirmText: '删除',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      var id = state.goodsId;
      Promise.all([
        S.query('purchase_items', 'goods_id', id),
        S.query('sale_items', 'goods_id', id),
        S.query('price_records', 'goods_id', id)
      ]).then(function (r) {
        var ops = [{ action: 'del', store: 'goods', key: id }];
        (r[0] || []).forEach(function (p) { ops.push({ action: 'del', store: 'purchase_items', key: p.id }); });
        (r[1] || []).forEach(function (s) { ops.push({ action: 'del', store: 'sale_items', key: s.id }); });
        (r[2] || []).forEach(function (p) { ops.push({ action: 'del', store: 'price_records', key: p.id }); });
        return S.bulk(['goods', 'purchase_items', 'sale_items', 'price_records'], ops);
      }).then(function () {
        UI.toast('已删除', 'success');
        go('#/library');
      }).catch(function (err) {
        if (!(err && err.expected)) console.error('[EATG] 删除失败', err);
        UI.toast('删除失败：' + (err && err.message || err), 'error');
      });
    });
  }

  // ---- 刷新 ----

  function refresh() {
    return fetchAll().then(function () {
      if (state.destroyed) return;
      render();
    });
  }

  // ---- 挂载 / 卸载 ----

  function mount(container, ctx) {
    resetState();
    dom = { container: container, ctx: ctx };
    var params = new URLSearchParams(ctx.query || '');
    var id = Number(params.get('id'));
    state.goodsId = (isFinite(id) && id) ? id : null;
    ctx.setTitle('谷子详情');
    ctx.setBack(true);
    container.innerHTML = skeletonHTML();

    var start = state.goodsId ? Promise.resolve() : Promise.reject(expectedError('缺少谷子款 id'));
    return start.then(fetchAll).then(function () {
      if (state.destroyed) return;
      ctx.setTitle(state.goods.name || '谷子详情');
      render();
    }, function (err) {
      if (!(err && err.expected)) console.error('[EATG] 谷子详情页加载失败', err);
      UI.toast('加载失败：' + (err && err.message || err), 'error');
      container.innerHTML = '<div class="empty"><p class="empty-title">加载失败，请返回重试</p>' +
        '<button type="button" class="btn btn--secondary" data-act="back">返回</button></div>';
      var b = container.querySelector('[data-act="back"]');
      if (b) on(b, 'click', function () {
        if (global.history.length > 1) global.history.back();
        else global.location.hash = '#/library';
      });
    });
  }

  function unmount() {
    state.destroyed = true;
    clearOffs();
    closeViewer();
    dom = {};
    state = null;
  }

  EATG.pages['goods/detail'] = { key: 'goods/detail', mount: mount, unmount: unmount };

})(window);
