/* ==========================================================================
   一咕（EATG）· 收藏库首页（js/pages/library.js）
   实现：《详细开发指南》第2步 +《页面线框与UI规范》P02（#/library）
   内容：1 谷子款聚合卡片列表（缩略图/名称/IP角色标签/状态角标/数量/总投入/盈利）
        2 统计摘要条（总件数/总投入/总盈利/在手/在途/未计价，来源 goods.agg）
        3 搜索（名称/角色，300ms 防抖）+ 筛选底部抽屉（多选 + 重置/确定）
        4 排序（购入时间/价格/角色/最近更新）
        5 分组切换（按谷子款 / 按订单）
        6 左滑快捷（到手/转出）+ 长按批量编辑（批量改状态，二次确认）
        7 点击卡片 → #/goods/detail?id=；点击「+」→ #/goods/edit?mode=add
   约束：数据 CRUD 一律走 EATG.storage；金额「分」；空态/文案遵循 §5 文案规范。
   ========================================================================== */
(function (global) {
  'use strict';

  var EATG = (global.EATG = global.EATG || {});
  var S = EATG.storage;
  var A = EATG.agg;
  var U = EATG.utils;
  var UI = EATG.ui;

  EATG.pages = EATG.pages || {};

  var SWIPE_OPEN = -132;  // 左滑展开位移（px）
  var TAP_MOVE_TOL = 8;   // 判定为点击的最大位移
  var LONG_PRESS_MS = 500;

  var SORT_LABELS = {
    purchase_time: '购入时间',
    price: '价格',
    character: '角色',
    updated: '最近更新'
  };

  // ---- 运行时状态 ----

  var state = null;     // 见 resetState()
  var dom = {};         // 本页 DOM 引用
  var offs = [];        // 待卸载的监听（[el, ev, fn, opt]）
  var swipe = {};       // 左滑/长按手势临时状态

  function resetState() {
    state = {
      model: null,
      view: 'goods',                 // 'goods' | 'order'
      keyword: '',
      sort: 'purchase_time',
      filters: { ip: [], char: [], type: [], status: [], channel: [], price: [], bag: [], loc: [] },
      enums: {},
      batchMode: false,
      selected: [],
      index: { goodsById: {}, charById: {}, facets: {}, charNames: {} }
    };
    swipe = { card: null, row: null, startX: 0, startY: 0, dx: 0, base: 0, dragging: false, moved: false, t0: 0, timer: null, opened: null, consumed: false };
  }

  function on(el, ev, fn, opt) { el.addEventListener(ev, fn, opt); offs.push([el, ev, fn, opt]); }

  function clearOffs() {
    offs.forEach(function (t) { t[0].removeEventListener(t[1], t[2], t[3]); });
    offs = [];
  }

  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function money(cents) { return U.fmtMoney(cents, 'CNY'); }

  // ---- 索引构建（过滤/分组用） ----

  function buildIndex() {
    var m = state.model;
    var goodsById = {}, charById = {}, facets = {}, charNames = {};
    (m.characters || []).forEach(function (c) { charById[c.id] = c; });
    (m.goods || []).forEach(function (g) {
      goodsById[g.id] = g;
      var names = [];
      (g.character_ids || []).forEach(function (cid) {
        var c = charById[cid];
        if (c) names.push(c.name);
      });
      charNames[g.id] = names;
      facets[g.id] = facetsOf(g);
    });
    state.index = { goodsById: goodsById, charById: charById, facets: facets, charNames: charNames };
  }

  function facetsOf(g) {
    var items = state.model.byGoods[g.id] || [];
    var statuses = [], channels = [], prices = [], bags = [], locs = [];
    var statusesRemaining = false;
    items.forEach(function (p) {
      statuses.push(p.status);
      if (p.channel) channels.push(p.channel);
      prices.push(p.price_status);
      if (p.has_bag != null) bags.push(p.has_bag ? '1' : '0');
      if (p.location) locs.push(p.location);
      if (num(p.quantity) - num(p.sold_quantity) > 0) statusesRemaining = true;
    });
    if (!statusesRemaining && items.length) statuses = ['sold_out'];
    return { status: statuses, channel: channels, price: prices, bag: bags, loc: locs };
  }

  // ---- 过滤 / 搜索 / 排序 ----

  function matchFilters(g) {
    var f = state.filters;
    if (f.ip.length && f.ip.indexOf(g.ip) === -1) return false;
    if (f.type.length && f.type.indexOf(g.goods_type) === -1) return false;
    if (f.char.length) {
      var ids = g.character_ids || [];
      if (!ids.some(function (id) { return f.char.indexOf(id) !== -1; })) return false;
    }
    var fac = state.index.facets[g.id] || { status: [], channel: [], price: [], bag: [], loc: [] };
    if (f.status.length && !f.status.some(function (s) { return fac.status.indexOf(s) !== -1; })) return false;
    if (f.channel.length && !f.channel.some(function (c) { return fac.channel.indexOf(c) !== -1; })) return false;
    if (f.price.length && !f.price.some(function (p) { return fac.price.indexOf(p) !== -1; })) return false;
    if (f.bag.length && !f.bag.some(function (b) { return fac.bag.indexOf(b) !== -1; })) return false;
    if (f.loc.length && !f.loc.some(function (l) { return fac.loc.indexOf(l) !== -1; })) return false;
    return true;
  }

  function matchKeyword(g) {
    var kw = state.keyword.trim().toLowerCase();
    if (!kw) return true;
    if ((g.name || '').toLowerCase().indexOf(kw) !== -1) return true;
    var names = state.index.charNames[g.id] || [];
    return names.some(function (n) { return String(n).toLowerCase().indexOf(kw) !== -1; });
  }

  function lastBuyDate(g) {
    var items = state.model.byGoods[g.id] || [];
    var d = '';
    items.forEach(function (p) { if (p.buy_date && p.buy_date > d) d = p.buy_date; });
    return d;
  }

  function sortGoods(list) {
    var sort = state.sort;
    var arr = list.slice();
    arr.sort(function (a, b) {
      if (sort === 'price') {
        return num(b.agg && b.agg.total_cost) - num(a.agg && a.agg.total_cost);
      }
      if (sort === 'character') {
        var na = (state.index.charNames[a.id] || [])[0] || '';
        var nb = (state.index.charNames[b.id] || [])[0] || '';
        return na.localeCompare(nb, 'zh-Hans-CN') || (b.updated_at || 0) - (a.updated_at || 0);
      }
      if (sort === 'updated') {
        return (b.updated_at || 0) - (a.updated_at || 0);
      }
      // purchase_time（默认）：最近购入在前
      return (lastBuyDate(b) || '').localeCompare(lastBuyDate(a) || '') ||
        (b.updated_at || 0) - (a.updated_at || 0);
    });
    return arr;
  }

  function visibleGoods() {
    return sortGoods(state.model.goods.filter(function (g) {
      return matchFilters(g) && matchKeyword(g);
    }));
  }

  function hasActiveFilters() {
    var f = state.filters;
    return f.ip.length + f.char.length + f.type.length + f.status.length + f.channel.length + f.price.length + f.bag.length + f.loc.length > 0;
  }

  // ---- 视图：骨架 / 摘要条 / 工具栏 ----

  function skeletonHTML() {
    var one = '<div class="skeleton-card"><div class="skeleton skeleton-thumb"></div>' +
      '<div class="skeleton-lines"><div class="skeleton skeleton-line" style="width:70%"></div>' +
      '<div class="skeleton skeleton-line" style="width:45%"></div>' +
      '<div class="skeleton skeleton-line" style="width:60%"></div></div></div>';
    return '<div class="skeleton skeleton-bar" style="width:46%;height:22px;margin-bottom:12px"></div>' +
      one + one + one;
  }

  function renderShell() {
    dom.container.innerHTML =
      '<section class="page page--library">' +
        '<div id="lib-summary" class="summary-bar"></div>' +
        '<div class="lib-toolbar">' +
          '<div class="seg" role="tablist" aria-label="分组方式">' +
            '<button type="button" class="seg-btn" data-view="goods" role="tab">按谷子款</button>' +
            '<button type="button" class="seg-btn" data-view="order" role="tab">按订单</button>' +
          '</div>' +
          '<button type="button" class="tool-btn" id="lib-sort-btn"></button>' +
        '</div>' +
        '<div id="lib-list" class="lib-list"></div>' +
        '<div id="lib-batch" class="batch-bar" hidden></div>' +
      '</section>';

    dom.summary = dom.container.querySelector('#lib-summary');
    dom.toolbar = dom.container.querySelector('.lib-toolbar');
    dom.list = dom.container.querySelector('#lib-list');
    dom.batch = dom.container.querySelector('#lib-batch');
    dom.sortBtn = dom.container.querySelector('#lib-sort-btn');

    on(dom.toolbar, 'click', function (e) {
      var seg = e.target.closest('.seg-btn');
      if (seg) { setView(seg.dataset.view); return; }
      if (e.target.closest('#lib-sort-btn')) openSortSheet();
    });
  }

  function renderSummary() {
    var s = state.model.summary;
    var cells = [
      { label: '总件数', value: String(s.net_qty) },
      { label: '总投入', value: money(num(s.filled_cost) + num(s.estimated_cost)) },
      { label: '总盈利', value: money(s.total_profit), cls: s.total_profit > 0 ? 'up' : (s.total_profit < 0 ? 'down' : '') },
      { label: '在手', value: String(s.on_hand) },
      { label: '在途', value: String(s.in_transit) },
      { label: '未计价', value: String(s.unpriced) }
    ];
    dom.summary.innerHTML = cells.map(function (c) {
      return '<div class="summary-cell">' +
        '<div class="summary-num num ' + (c.cls || '') + '">' + UI.esc(c.value) + '</div>' +
        '<div class="summary-label">' + UI.esc(c.label) + '</div>' +
        '</div>';
    }).join('');
  }

  function renderToolbar() {
    var btns = dom.toolbar.querySelectorAll('.seg-btn');
    for (var i = 0; i < btns.length; i++) {
      var isOn = btns[i].dataset.view === state.view;
      btns[i].classList.toggle('is-active', isOn);
      btns[i].setAttribute('aria-selected', isOn ? 'true' : 'false');
    }
    dom.sortBtn.innerHTML = '排序：' + UI.esc(SORT_LABELS[state.sort]) + ' <span class="caret">▾</span>';
    updateFilterIndicator();
  }

  // ---- 视图：列表（按谷子款 / 按订单） ----

  function renderList() {
    swipe.opened = null;   // DOM 重建后失效
    if (!state.model.goods.length) {
      renderEmptyAdd();
      return;
    }
    if (state.view === 'order') { renderOrderView(); return; }
    var list = visibleGoods();
    if (!list.length) { renderEmptyFilter(); return; }
    dom.list.innerHTML = list.map(cardHTML).join('');
  }

  function renderEmptyAdd() {
    dom.list.innerHTML =
      '<div class="empty">' +
        emptyArt() +
        '<p class="empty-title">还没有谷子，去添加第一件</p>' +
        '<button type="button" class="btn btn--primary" data-act="add">＋ 添加谷子</button>' +
      '</div>';
    var b = dom.list.querySelector('[data-act="add"]');
    if (b) on(b, 'click', function () { navigate('#/goods/edit?mode=add'); });
  }

  function renderEmptyFilter() {
    dom.list.innerHTML =
      '<div class="empty">' +
        emptyArt() +
        '<p class="empty-title">没有符合条件的谷子</p>' +
        '<button type="button" class="btn btn--secondary" data-act="reset">重置筛选</button>' +
      '</div>';
    var b = dom.list.querySelector('[data-act="reset"]');
    if (b) on(b, 'click', function () { clearFilters(); renderList(); renderToolbar(); });
  }

  function emptyArt() {
    // 纯内联 SVG 空态插画（谷子元素，无外链）
    return '<svg class="empty-art" viewBox="0 0 120 90" aria-hidden="true">' +
      '<ellipse cx="60" cy="76" rx="40" ry="6" fill="#F0F0F0"/>' +
      '<rect x="34" y="26" width="52" height="44" rx="8" fill="#FFDD88" opacity="0.85"/>' +
      '<rect x="40" y="34" width="40" height="6" rx="3" fill="#FFFFFF"/>' +
      '<rect x="40" y="46" width="28" height="6" rx="3" fill="#FFFFFF"/>' +
      '<circle cx="82" cy="24" r="8" fill="#27AE60" opacity="0.6"/>' +
      '<circle cx="34" cy="22" r="6" fill="#8E44AD" opacity="0.5"/>' +
      '</svg>';
  }

  // 单张谷子款卡片
  function cardHTML(g) {
    var agg = g.agg || {};
    var thumb = (g.images && g.images[0])
      ? '<img class="thumb-img" src="' + g.images[0] + '" alt="">'
      : '<div class="thumb-ph"><span>' + UI.esc(g.goods_type || '谷子') + '</span></div>';

    var badge = agg.status
      ? '<span class="badge badge--' + agg.status + '">' + UI.esc(A.STATUS_LABELS[agg.status]) + '</span>'
      : '<span class="badge badge--none">未购入</span>';

    var chips = '<span class="chip">' + UI.esc(g.ip || '—') + '</span>';
    (g.character_ids || []).forEach(function (cid) {
      var c = state.index.charById[cid];
      if (c) chips += '<span class="chip chip--char' + (c.is_favorite ? ' is-fav' : '') + '">' + UI.esc(c.name) + '</span>';
    });
    if (g.goods_type) chips += '<span class="chip chip--type">' + UI.esc(g.goods_type) + '</span>';

    var qty = '×' + num(agg.total_qty);
    if (num(agg.total_sold) > 0) qty += ' <span class="muted">已出' + num(agg.total_sold) + '</span>';

    var isBatchSel = state.batchMode && state.selected.indexOf(g.id) !== -1;
    var pick = state.batchMode
      ? '<span class="pick' + (isBatchSel ? ' is-on' : '') + '" aria-hidden="true"></span>'
      : '';

    var actions = '';
    if (canQuick(agg.status)) {
      if (agg.status !== 'on_hand') actions += '<button type="button" class="swipe-btn swipe-btn--hand" data-act="hand">到手</button>';
      if (agg.status !== 'sold_out') actions += '<button type="button" class="swipe-btn swipe-btn--out" data-act="out">转出</button>';
    }

    return '<article class="goods-card' + (isBatchSel ? ' is-selected' : '') + '" data-id="' + g.id + '">' +
      '<div class="swipe-actions">' + actions + '</div>' +
      '<div class="card-main">' +
        (pick ? pick : '') +
        '<div class="thumb">' + thumb + '</div>' +
        '<div class="info">' +
          '<div class="title-row">' +
            '<span class="name">' + UI.esc(g.name || '未命名谷子') + '</span>' + badge +
          '</div>' +
          '<div class="chip-row">' + chips + '</div>' +
          '<div class="metric-row">' +
            '<span class="metric qty num">' + qty + '</span>' +
            '<span class="metric money" title="' + (num(agg.estimated_cost) ? ('含估算 ' + money(agg.estimated_cost)) : '总投入（已填写）') + '">' + money(num(agg.filled_only_cost) + num(agg.estimated_cost)) + '</span>' +
            profitCellHTML(agg) +
          '</div>' +
        '</div>' +
      '</div>' +
    '</article>';
  }

  function canQuick(status) {
    return !!status && status !== 'sold_out';
  }

  function profitCellHTML(agg) {
    var parts = [];
    var sold = num(agg.total_sold);
    if (!sold) {
      parts.push('<span class="metric metric--muted">未售出</span>');
    } else {
      var cls = agg.total_profit > 0 ? 'up' : (agg.total_profit < 0 ? 'down' : '');
      parts.push('<span class="metric money ' + cls + '">' + money(agg.total_profit) + '</span>');
    }
    if (num(agg.estimated_profit) !== 0) {
      parts.push('<span class="tag tag--est">估算 ' + money(agg.estimated_profit) + '</span>');
    }
    if (num(agg.unknown_qty) > 0) {
      parts.push('<span class="tag tag--unknown">成本未知，暂不计盈利</span>');
    }
    return parts.join('');
  }

  // 按订单分组视图
  function renderOrderView() {
    var m = state.model;
    var groups = {}, loose = [];
    m.purchases.forEach(function (p) {
      if (p.order_id == null) loose.push(p);
      else (groups[p.order_id] = groups[p.order_id] || []).push(p);
    });

    var blocks = [];
    // 正式订单：按 order_date 倒序
    var orderList = (m.orders || []).slice().sort(function (a, b) {
      return String(b.order_date || '').localeCompare(String(a.order_date || ''));
    });
    orderList.forEach(function (o) {
      // 空订单（未关联谷子）也显示：录了实付即算入账单
      var items = filterItems(groups[o.id] || []);
      blocks.push(orderCardHTML(o, items));
    });
    // 散买
    var looseItems = filterItems(loose);
    if (looseItems.length) blocks.push(orderCardHTML(null, looseItems));

    if (!blocks.length) {
      dom.list.innerHTML =
        '<div class="empty">' + emptyArt() +
        '<p class="empty-title">没有符合条件的谷子</p>' +
        '<button type="button" class="btn btn--secondary" data-act="reset">重置筛选</button></div>';
      var b = dom.list.querySelector('[data-act="reset"]');
      if (b) on(b, 'click', function () { clearFilters(); renderList(); renderToolbar(); });
      return;
    }
    dom.list.innerHTML = blocks.join('');
  }

  function filterItems(items) {
    return items.filter(function (p) {
      var g = state.index.goodsById[p.goods_id];
      if (!g) return false;
      if (!matchFilters(g)) return false;
      // 关键字：匹配谷子名或角色
      var kw = state.keyword.trim().toLowerCase();
      if (!kw) return true;
      if ((g.name || '').toLowerCase().indexOf(kw) !== -1) return true;
      var names = state.index.charNames[g.id] || [];
      return names.some(function (n) { return String(n).toLowerCase().indexOf(kw) !== -1; });
    });
  }

  function orderCardHTML(order, items) {
    var name = order ? (order.order_name || ('订单 #' + order.id)) : '散买（未归入订单）';
    var meta = order
      ? [order.order_date || '', order.channel || ''].filter(Boolean).join(' · ')
      : '未关联订单的购入记录';
    var totalQty = items.reduce(function (a, p) { return a + num(p.quantity); }, 0);
    var paid = order ? num(order.paid_total) : items.reduce(function (a, p) {
      return a + (p.unit_price == null ? 0 : num(p.unit_price) * num(p.quantity)) + num(p.shipping_share);
    }, 0);

    var thumbs = items.map(function (p) {
      var g = state.index.goodsById[p.goods_id];
      if (!g) return '';
      var img = (g.images && g.images[0]) ? '<img src="' + g.images[0] + '" alt="">' : '<span class="oi-ph"></span>';
      return '<div class="order-thumb" data-gid="' + g.id + '">' +
        '<div class="oi-img">' + img + '</div>' +
        '<div class="oi-name">' + UI.esc(g.name || '') + '</div>' +
        '<div class="oi-qty num">×' + num(p.quantity) + '</div>' +
        '</div>';
    }).join('');

    var emptyFlag = items.length ? '' : '<div class="order-flags"><span class="tag tag--est">未关联谷子</span></div>';

    return '<div class="order-card"' + (order ? ' data-oid="' + order.id + '"' : '') + '>' +
      '<div class="order-head">' +
        '<span class="order-name">' + UI.esc(name) + '</span>' +
        '<span class="order-meta">' + UI.esc(meta) + '</span>' +
      '</div>' +
      '<div class="order-stats">' +
        '<span class="num">' + totalQty + ' 件</span>' +
        '<span class="money">实付 ' + money(paid) + '</span>' +
      '</div>' +
      emptyFlag +
      '<div class="order-thumbs">' + thumbs + '</div>' +
    '</div>';
  }

  // ---- 左滑 / 长按 / 点击 ----

  function bindListGestures() {
    on(dom.list, 'pointerdown', onDown);
    on(dom.list, 'click', onListClick);
  }

  function onListClick(e) {
    // 左滑动作按钮
    var btn = e.target.closest('.swipe-btn');
    if (btn) {
      var card = btn.closest('.goods-card');
      if (card) quickStatus(card.dataset.id, btn.dataset.act);
      return;
    }
    // 订单视图：谷子缩略 → 详情；订单卡片 → 订单详情
    var thumb = e.target.closest('.order-thumb');
    if (thumb) { navigate('#/goods/detail?id=' + thumb.dataset.gid); return; }
    var ocard = e.target.closest('.order-card');
    if (ocard && ocard.dataset.oid) { navigate('#/order/edit?id=' + ocard.dataset.oid); return; }
  }

  function onDown(e) {
    if (e.button && e.button !== 0) return;
    var card = e.target.closest('.goods-card');
    if (!card || e.target.closest('.swipe-btn')) return;
    if (state.view === 'order') return;

    swipe.card = card;
    swipe.row = card.querySelector('.card-main');
    swipe.startX = e.clientX;
    swipe.startY = e.clientY;
    swipe.dx = 0;
    swipe.moved = false;
    swipe.dragging = false;
    swipe.consumed = false;
    swipe.t0 = Date.now();
    swipe.base = (swipe.opened === card) ? SWIPE_OPEN : 0;

    swipe.timer = setTimeout(function () {
      swipe.timer = null;
      if (swipe.card === card && !swipe.moved) {
        swipe.consumed = true;
        enterBatch(card.dataset.id);
        resetSwipe();
      }
    }, LONG_PRESS_MS);

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  }

  function onMove(e) {
    if (!swipe.card) return;
    var dx = e.clientX - swipe.startX, dy = e.clientY - swipe.startY;
    if (!swipe.dragging) {
      if (Math.abs(dx) < TAP_MOVE_TOL && Math.abs(dy) < TAP_MOVE_TOL) return;
      swipe.moved = true;
      if (swipe.timer) { clearTimeout(swipe.timer); swipe.timer = null; }
      if (Math.abs(dx) > Math.abs(dy) * 1.2) {
        swipe.dragging = true;
        swipe.row.style.transition = 'none';
      } else {
        // 纵向意图 → 放弃手势，交给页面滚动
        resetSwipe();
        return;
      }
    }
    if (swipe.dragging) {
      var off = Math.max(SWIPE_OPEN - 8, Math.min(0, swipe.base + dx));
      swipe.dx = off;
      swipe.row.style.transform = 'translateX(' + off + 'px)';
      if (e.cancelable) e.preventDefault();
    }
  }

  function onUp() {
    if (swipe.timer) { clearTimeout(swipe.timer); swipe.timer = null; }
    if (!swipe.card) { resetSwipe(); return; }
    var card = swipe.card, row = swipe.row;

    if (swipe.consumed) { resetSwipe(); return; }

    if (swipe.dragging) {
      var open = swipe.dx < SWIPE_OPEN / 2;
      if (open) {
        if (swipe.opened && swipe.opened !== card) closeCard(swipe.opened);
        openCard(card);
        swipe.opened = card;
      } else {
        closeCard(card);
        if (swipe.opened === card) swipe.opened = null;
      }
      // 手势收尾（保留已展开态）
      row.style.transition = '';
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      swipe.card = null; swipe.row = null; swipe.moved = false; swipe.dragging = false;
      return;
    }

    // 点击（未移动、未长按）
    if (!swipe.moved) {
      if (state.batchMode) toggleSelect(card.dataset.id);
      else if (swipe.opened === card) { closeCard(card); swipe.opened = null; }
      else navigate('#/goods/detail?id=' + card.dataset.id);
    }
    resetSwipe();
  }

  function openCard(card) {
    var row = card.querySelector('.card-main');
    if (row) { row.style.transition = ''; row.style.transform = 'translateX(' + SWIPE_OPEN + 'px)'; }
  }
  function closeCard(card) {
    var row = card && card.querySelector('.card-main');
    if (row) { row.style.transition = ''; row.style.transform = ''; }
  }

  function resetSwipe() {
    if (swipe.timer) { clearTimeout(swipe.timer); swipe.timer = null; }
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
    swipe.card = null; swipe.row = null; swipe.moved = false; swipe.dragging = false; swipe.consumed = false;
  }

  function closeOpened() {
    if (swipe.opened) { closeCard(swipe.opened); swipe.opened = null; }
  }

  // ---- 快捷操作：到手 / 转出 ----

  function quickStatus(id, act) {
    var target = act === 'hand' ? 'on_hand' : 'sold_out';
    applyStatus([Number(id)], target).then(function (n) {
      if (!n) { UI.toast('没有可流转的购入记录', 'error'); return; }
      UI.toast('已' + (act === 'hand' ? '置为到手' : '置为已出荷'), 'success');
      closeOpened();
      return reload();
    }).catch(function (err) {
      console.error('[EATG] 快捷状态更新失败', err);
      UI.toast('更新失败：' + (err && err.message || err), 'error');
    });
  }

  /**
   * 批量/单件：将指定谷子款中「仍有剩余件」的购入记录置为目标状态，
   * 并重算写回 goods.agg（走 storage.bulk 原子事务）。
   * @returns {Promise<number>} 实际更新的购入记录条数
   */
  function applyStatus(ids, target) {
    var m = state.model;
    var ops = [], goodsOps = [], count = 0;
    ids.forEach(function (id) {
      var items = m.byGoods[id] || [];
      var changedMap = {};
      var modified = items.map(function (p) {
        if (num(p.quantity) - num(p.sold_quantity) <= 0) return p;
        var rec = {};
        for (var k in p) { if (Object.prototype.hasOwnProperty.call(p, k)) rec[k] = p[k]; }
        rec.status = target;
        changedMap[p.id] = rec;
        count++;
        return rec;
      });
      if (!Object.keys(changedMap).length) return;
      modified.forEach(function (p) { if (changedMap[p.id]) ops.push({ action: 'put', store: 'purchase_items', value: p }); });

      var g = state.index.goodsById[id];
      if (g) {
        var gRec = {};
        for (var k2 in g) { if (Object.prototype.hasOwnProperty.call(g, k2)) gRec[k2] = g[k2]; }
        gRec.agg = A.computeGoodsAgg(gRec, modified, m.salesByGoods[id] || []);
        goodsOps.push({ action: 'put', store: 'goods', value: gRec });
      }
    });
    if (!count) return Promise.resolve(0);
    return S.bulk(['purchase_items', 'goods'], ops.concat(goodsOps)).then(function () { return count; });
  }

  // ---- 批量编辑 ----

  function enterBatch(initialId) {
    closeOpened();
    state.batchMode = true;
    state.selected = initialId ? [Number(initialId)] : [];
    renderList();
    renderBatchBar();
  }

  function exitBatch() {
    state.batchMode = false;
    state.selected = [];
    renderList();
    renderBatchBar();
  }

  function toggleSelect(id) {
    var nid = Number(id);
    var i = state.selected.indexOf(nid);
    if (i === -1) state.selected.push(nid); else state.selected.splice(i, 1);
    renderList();
    renderBatchBar();
  }

  function renderBatchBar() {
    if (!state.batchMode) { dom.batch.hidden = true; dom.batch.innerHTML = ''; return; }
    dom.batch.hidden = false;
    var n = state.selected.length;
    dom.batch.innerHTML =
      '<button type="button" class="batch-exit" data-act="exit">退出</button>' +
      '<span class="batch-count">已选 <b class="num">' + n + '</b></span>' +
      '<button type="button" class="batch-all" data-act="all">全选</button>' +
      '<button type="button" class="btn btn--primary batch-apply" data-act="status"' + (n ? '' : ' disabled') + '>批量改状态</button>';
  }

  function bindBatchBar() {
    on(dom.batch, 'click', function (e) {
      var act = e.target.closest('[data-act]');
      if (!act) return;
      var a = act.dataset.act;
      if (a === 'exit') exitBatch();
      else if (a === 'all') {
        var vis = visibleGoods();
        state.selected = (state.selected.length === vis.length) ? [] : vis.map(function (g) { return g.id; });
        renderList(); renderBatchBar();
      } else if (a === 'status') batchChangeStatus();
    });
  }

  function batchChangeStatus() {
    var ids = state.selected.slice();
    if (!ids.length) { UI.toast('请先选择谷子', 'error'); return; }
    openStatusSheet('批量改状态', function (status) {
      UI.confirmDialog({
        title: '批量改状态',
        message: '将 ' + ids.length + ' 个谷子款的购入记录状态改为「' + A.STATUS_LABELS[status] + '」，确认？',
        confirmText: '确定'
      }).then(function (ok) {
        if (!ok) return;
        applyStatus(ids, status).then(function (n) {
          UI.toast(n ? ('已更新 ' + n + ' 条购入记录') : '没有可流转的购入记录', n ? 'success' : 'error');
          exitBatch();
          return reload();
        }).catch(function (err) {
          console.error('[EATG] 批量改状态失败', err);
          UI.toast('更新失败：' + (err && err.message || err), 'error');
        });
      });
    });
  }

  function openStatusSheet(title, onPick) {
    var bodyHTML = '<div class="chip-select">' + A.STATUS_ORDER.map(function (s) {
      return '<button type="button" class="opt-chip" data-status="' + s + '">' + UI.esc(A.STATUS_LABELS[s]) + '</button>';
    }).join('') + '</div>';
    var ref = UI.sheet({ title: title, bodyHTML: bodyHTML });
    ref.body.addEventListener('click', function (e) {
      var b = e.target.closest('[data-status]');
      if (!b) return;
      ref.close();
      onPick(b.dataset.status);
    });
  }

  // ---- 排序菜单 ----

  function openSortSheet() {
    var bodyHTML = '<div class="opt-list">' + Object.keys(SORT_LABELS).map(function (key) {
      return '<button type="button" class="opt-row' + (state.sort === key ? ' is-on' : '') + '" data-sort="' + key + '">' +
        '<span>' + UI.esc(SORT_LABELS[key]) + '</span><span class="opt-check">✓</span></button>';
    }).join('') + '</div>';
    var ref = UI.sheet({ title: '排序方式', bodyHTML: bodyHTML });
    ref.body.addEventListener('click', function (e) {
      var b = e.target.closest('[data-sort]');
      if (!b) return;
      state.sort = b.dataset.sort;
      ref.close();
      closeOpened();
      renderToolbar();
      renderList();
    });
  }

  // ---- 筛选抽屉 ----

  function optionSets() {
    var m = state.model;
    var enums = state.enums;
    function uniq(arr) { var seen = {}, out = []; arr.forEach(function (v) { if (v != null && !seen[v]) { seen[v] = 1; out.push(v); } }); return out; }

    var ipOpts = uniq((enums.ip || []).concat(m.goods.map(function (g) { return g.ip; }).filter(Boolean)));
    var typeOpts = uniq((enums.goods_type || []).concat(m.goods.map(function (g) { return g.goods_type; }).filter(Boolean)));
    var channelOpts = uniq((enums.channel || []).concat(m.purchases.map(function (p) { return p.channel; }).filter(Boolean)));
    var charOpts = (m.characters || []).map(function (c) { return { id: c.id, name: c.name, fav: !!c.is_favorite }; })
      .sort(function (a, b) { return (b.fav ? 1 : 0) - (a.fav ? 1 : 0) || String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'); });

    return {
      ip: { title: 'IP', type: 'value', opts: ipOpts },
      char: { title: '角色', type: 'char', opts: charOpts },
      type: { title: '类型', type: 'value', opts: typeOpts },
      status: { title: '状态', type: 'status', opts: A.STATUS_ORDER },
      channel: { title: '渠道', type: 'value', opts: channelOpts },
      price: { title: '价格状态', type: 'price', opts: A.PRICE_ORDER },
      bag: { title: '原袋', type: 'value', opts: ['1', '0'] },
      loc: { title: '位置', type: 'value', opts: ['home', 'school', 'other'] }
    };
  }

  function labelOf(cat, v) {
    if (cat === 'status') return A.STATUS_LABELS[v];
    if (cat === 'price') return A.PRICE_LABELS[v];
    if (cat === 'bag') return v === '1' ? '有原袋' : '无原袋';
    if (cat === 'loc') return { home: '在家', school: '在校', other: '其他' }[v] || v;
    return v;
  }

  function openFilterSheet() {
    var sets = optionSets();
    var draft = {
      ip: state.filters.ip.slice(), char: state.filters.char.slice(), type: state.filters.type.slice(),
      status: state.filters.status.slice(), channel: state.filters.channel.slice(), price: state.filters.price.slice(),
      bag: state.filters.bag.slice(), loc: state.filters.loc.slice()
    };
    var html = Object.keys(sets).map(function (cat) {
      var cfg = sets[cat];
      var chips = cfg.opts.map(function (o) {
        var val = cfg.type === 'char' ? o.id : o;
        var label = cfg.type === 'char' ? o.name : labelOf(cat, o);
        var cls = cfg.type === 'char' && o.fav ? ' is-fav' : '';
        return '<button type="button" class="opt-chip' + cls + '" data-cat="' + cat + '" data-val="' + UI.esc(val) + '">' + UI.esc(label) + '</button>';
      }).join('');
      return '<div class="filter-group"><div class="filter-group-title">' + UI.esc(cfg.title) + '</div>' +
        '<div class="chip-select">' + (chips || '<span class="muted">暂无选项</span>') + '</div></div>';
    }).join('');

    var ref = UI.sheet({
      title: '筛选',
      bodyHTML: html,
      footerHTML: '<button type="button" class="btn btn--secondary" data-act="reset">重置</button>' +
        '<button type="button" class="btn btn--primary" data-act="apply">确定</button>'
    });

    function syncChips() {
      ref.body.querySelectorAll('.opt-chip').forEach(function (chip) {
        var cat = chip.dataset.cat, val = chip.dataset.val;
        var arr = draft[cat];
        var isOn;
        if (cat === 'char') isOn = arr.indexOf(Number(val)) !== -1;
        else isOn = arr.indexOf(val) !== -1;
        chip.classList.toggle('is-on', !!isOn);
      });
    }
    syncChips();

    ref.body.addEventListener('click', function (e) {
      var chip = e.target.closest('.opt-chip');
      if (!chip) return;
      var cat = chip.dataset.cat, val = chip.dataset.val;
      var arr = draft[cat];
      if (cat === 'char') val = Number(val);
      var i = arr.indexOf(val);
      if (i === -1) arr.push(val); else arr.splice(i, 1);
      syncChips();
    });

    if (ref.foot) {
      ref.foot.addEventListener('click', function (e) {
        var b = e.target.closest('[data-act]');
        if (!b) return;
        if (b.dataset.act === 'reset') {
          draft = { ip: [], char: [], type: [], status: [], channel: [], price: [], bag: [], loc: [] };
          syncChips();
        } else if (b.dataset.act === 'apply') {
          state.filters = draft;
          ref.close();
          closeOpened();
          renderToolbar();
          renderList();
        }
      });
    }
  }

  function clearFilters() {
    state.filters = { ip: [], char: [], type: [], status: [], channel: [], price: [], bag: [], loc: [] };
  }

  function setView(view) {
    if (view === state.view) return;
    closeOpened();
    state.view = view;
    renderToolbar();
    renderList();
    updateAddBtn();
  }

  // ---- 顶部导航（搜索 + 筛选 + 新增） ----

  function buildNav(ctx) {
    ctx.navActions.innerHTML =
      '<div class="nav-search">' +
        '<svg class="nav-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
          '<circle cx="11" cy="11" r="6"/><path d="M20 20l-3.5-3.5"/></svg>' +
        '<input type="search" id="lib-search" placeholder="搜索名称/角色" autocomplete="off" />' +
      '</div>' +
      '<button type="button" class="icon-btn" id="lib-filter" aria-label="筛选">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M3 5h18l-7 8v6l-4 2v-8z"/></svg>' +
        '<span class="icon-badge" hidden></span>' +
      '</button>' +
      '<button type="button" class="icon-btn icon-btn--accent" id="lib-add" aria-label="新增谷子">＋</button>';

    if (ctx.nav) ctx.nav.classList.add('top-nav--search');

    var searchEl = ctx.navActions.querySelector('#lib-search');
    var filterEl = ctx.navActions.querySelector('#lib-filter');
    var addEl = ctx.navActions.querySelector('#lib-add');
    dom.searchEl = searchEl;
    dom.filterEl = filterEl;
    dom.addEl = addEl;
    updateAddBtn();

    dom.searchTimer = null;
    on(searchEl, 'input', function () {
      if (dom.searchTimer) clearTimeout(dom.searchTimer);
      dom.searchTimer = setTimeout(function () {
        state.keyword = searchEl.value || '';
        closeOpened();
        renderList();
      }, 300);
    });

    on(filterEl, 'click', openFilterSheet);
    on(addEl, 'click', function () {
      if (state.view === 'order') navigate('#/order/edit?mode=new');
      else navigate('#/goods/edit?mode=add');
    });
  }

  /** 按当前视图更新新增键（按订单 → 新建订单） */
  function updateAddBtn() {
    if (!dom.addEl) return;
    if (state.view === 'order') {
      dom.addEl.setAttribute('aria-label', '新建订单');
      dom.addEl.title = '新建订单';
    } else {
      dom.addEl.setAttribute('aria-label', '新增谷子');
      dom.addEl.title = '新增谷子';
    }
  }

  function updateFilterIndicator() {
    if (!dom.filterEl) return;
    var n = state.filters.ip.length + state.filters.char.length + state.filters.type.length +
      state.filters.status.length + state.filters.channel.length + state.filters.price.length + state.filters.bag.length + state.filters.loc.length;
    var badge = dom.filterEl.querySelector('.icon-badge');
    dom.filterEl.classList.toggle('is-active', n > 0);
    if (badge) { badge.hidden = n === 0; badge.textContent = String(n); }
  }

  // ---- 加载 / 重载 ----

  function reload() {
    return A.buildModel().then(function (model) {
      state.model = model;
      state.enums = model.enums || {};
      buildIndex();
      renderSummary();
      renderToolbar();
      renderList();
      renderBatchBar();
    }, function (err) {
      console.error('[EATG] 收藏库重载失败', err);
      UI.toast('数据加载失败：' + (err && err.message || err), 'error');
    });
  }

  function mount(container, ctx) {
    resetState();
    dom = { container: container, ctx: ctx };
    container.innerHTML = skeletonHTML();
    ctx.setTitle('收藏库');
    ctx.setBack(false);
    buildNav(ctx);

    return A.buildModel().then(function (model) {
      state.model = model;
      state.enums = model.enums || {};
      buildIndex();
      renderShell();
      renderSummary();
      renderToolbar();
      renderList();
      bindListGestures();
      bindBatchBar();
    }, function (err) {
      console.error('[EATG] 收藏库加载失败', err);
      UI.toast('数据加载失败：' + (err && err.message || err), 'error');
      container.innerHTML = '<div class="empty"><p class="empty-title">加载失败，请刷新重试</p></div>';
    });
  }

  function unmount() {
    resetSwipe();
    if (dom.searchTimer) { clearTimeout(dom.searchTimer); dom.searchTimer = null; }
    clearOffs();
    var nav = dom.ctx && dom.ctx.nav;
    if (nav) nav.classList.remove('top-nav--search');
    var root = document.getElementById('modal-root');
    if (root) { root.innerHTML = ''; root.hidden = true; }
    dom = {};
  }

  function navigate(hash) {
    if (global.location.hash === hash) { if (EATG.app && EATG.app.render) EATG.app.render(); }
    else global.location.hash = hash;
  }

  EATG.pages.library = { key: 'library', mount: mount, unmount: unmount };

})(window);
