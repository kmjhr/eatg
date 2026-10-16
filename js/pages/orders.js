/* ==========================================================================
   一咕（EATG）· 订单列表页（js/pages/orders.js）
   实现：《详细开发指南》第5步 +《页面线框与UI规范》P06
   路由：#/orders
   内容：1 顶部标题 + “＋新增订单”
        2 筛选：渠道 / 时间（近7/30/90天/一年）
        3 订单卡片：名称/日期/渠道/本体合计/邮费/实付总额/件数/状态（打包标识）
        4 批量到手：勾选订单 → 订单内预售/在途件全部置 on_hand（O-10）
   口径：金额「分」整数；状态流转按《数据字典》§4（仅对剩余数量>0 的记录生效）。
   数据：一律走 EATG.storage；聚合走 EATG.agg。
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
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function money(c) { return U.fmtMoney(c, 'CNY'); }

  var TIME_OPTIONS = [['', '全部时间'], ['7', '近7天'], ['30', '近30天'], ['90', '近90天'], ['365', '近一年']];

  function resetState() {
    state = {
      destroyed: false,
      orders: [],
      itemsByOrder: {},
      goodsById: {},
      salesByPid: {},
      enums: { channel: [] },
      filters: { channel: '', time: '' },
      selectMode: false,
      selected: {}
    };
  }

  // ---- 派生 ----

  function repStatus(items) {
    var st = null;
    (items || []).forEach(function (p) {
      if (num(p.quantity) - num(p.sold_quantity) <= 0) return;
      if (st == null || A.STATUS_RANK[p.status] < A.STATUS_RANK[st]) st = p.status;
    });
    if (st) return st;
    return (items && items.length) ? 'sold_out' : null;
  }

  function orderStats(o) {
    var items = state.itemsByOrder[o.id] || [];
    var ship = num(o.shipping_fee);
    var body = num(o.goods_total);
    var paid = (o.paid_total != null) ? num(o.paid_total) : (body + ship);
    var count = items.reduce(function (a, p) { return a + num(p.quantity); }, 0);
    // 已核销 = 已填单价的件（本体×数量） + 邮费分摊；余款 = 实付 − 已核销 − 未知价格谷子已卖出金额（未知池核销）
    var alloc = items.reduce(function (a, p) {
      var q = num(p.quantity);
      var b = (p.unit_price != null) ? num(p.unit_price) * q : 0;
      return a + b + num(p.shipping_share);
    }, 0);
    var unknownSold = 0;
    items.forEach(function (p) {
      if (p.unit_price != null) return;
      (state.salesByPid[Number(p.id)] || []).forEach(function (sl) { unknownSold += num(sl.unit_price) * num(sl.quantity); });
    });
    var remain = paid - alloc - unknownSold;
    var unknownQty = items.reduce(function (a, p) { return a + (p.unit_price == null ? num(p.quantity) : 0); }, 0);
    return { items: items, ship: ship, body: body, paid: paid, count: count, remain: remain,
      unknownQty: unknownQty, paidManual: !!o.paid_manual, status: repStatus(items), bundle: !!o.is_bundle,
      ps: o.price_status || 'filled'      // 订单实付价格状态
    };
  }

  function inChannel(o) {
    var c = state.filters.channel;
    if (!c) return true;
    return (o.channel || '') === c;
  }
  function inTime(o) {
    var t = state.filters.time;
    if (!t) return true;
    var d = o.order_date;
    if (!d) return true;
    var days = Number(t);
    if (!isFinite(days)) return true;
    var od = new Date(d + 'T00:00:00');
    if (isNaN(od.getTime())) return true;
    var diff = (Date.now() - od.getTime()) / 86400000;
    return diff >= -1 && diff <= days;
  }
  function filtered() {
    return state.orders.filter(inChannel).filter(inTime).slice().sort(function (a, b) {
      return String(b.order_date || '').localeCompare(String(a.order_date || '')) || (Number(b.id) - Number(a.id));
    });
  }

  // ---- 数据加载 ----

  function load() {
    return Promise.all([S.getAll('orders'), S.getAll('purchase_items'), S.getAll('goods'), S.getAll('enums'), S.getAll('sale_items')])
      .then(function (r) {
        state.orders = r[0] || [];
        var by = {};
        (r[1] || []).forEach(function (p) { if (p.order_id != null) (by[p.order_id] = by[p.order_id] || []).push(p); });
        state.itemsByOrder = by;
        var gm = {};
        (r[2] || []).forEach(function (g) { gm[Number(g.id)] = g; });
        state.goodsById = gm;
        var em = {};
        (r[3] || []).forEach(function (row) { em[row.key] = row.values || []; });
        state.enums = em;
        var spm = {};
        (r[4] || []).forEach(function (sl) {
          if (sl.purchase_item_id == null) return;
          (spm[Number(sl.purchase_item_id)] = spm[Number(sl.purchase_item_id)] || []).push(sl);
        });
        state.salesByPid = spm;
      });
  }

  // ---- 模板 ----

  function toolbarHTML() {
    var channels = state.enums.channel || [];
    var chOpts = '<option value="">全部渠道</option>' + channels.map(function (c) {
      return '<option value="' + UI.esc(c) + '"' + (state.filters.channel === c ? ' selected' : '') + '>' + UI.esc(c) + '</option>';
    }).join('');
    var tOpts = TIME_OPTIONS.map(function (t) {
      return '<option value="' + t[0] + '"' + (state.filters.time === t[0] ? ' selected' : '') + '>' + t[1] + '</option>';
    }).join('');
    return '<div class="order-filter">' +
      '<select id="f-channel" class="input order-filter-sel">' + chOpts + '</select>' +
      '<select id="f-time" class="input order-filter-sel">' + tOpts + '</select>' +
      '<button type="button" class="tool-btn" data-act="batch">' + (state.selectMode ? '取消' : '批量') + '</button>' +
      '</div>';
  }

  function badgeHTML(status) {
    if (!status) return '<span class="badge badge--none">未录入</span>';
    return '<span class="badge badge--' + status + '">' + UI.esc(A.STATUS_LABELS[status] || status) + '</span>';
  }

  function cardHTML(o) {
    var st = orderStats(o);
    var sel = !!state.selected[o.id];
    var pick = state.selectMode
      ? '<button type="button" class="pick' + (sel ? ' is-on' : '') + '" data-pick="' + o.id + '" aria-label="选择订单"></button>'
      : '';
    var psTag = st.ps === 'unknown' ? '<span class="tag tag--unknown">价格未知</span>'
      : (st.ps === 'estimated' ? '<span class="tag tag--est">估算</span>' : '');
    var flags = psTag + (st.bundle ? '<span class="tag tag--bund">打包</span>' : '') + badgeHTML(st.status);
    return '<article class="order-card order-card--list' + (sel ? ' is-selected' : '') + '" data-oid="' + o.id + '">' +
        '<div class="order-row">' + pick +
          '<div class="order-body">' +
            '<div class="order-head">' +
              '<span class="order-name">' + UI.esc(o.order_name || '未命名订单') + '</span>' +
              '<span class="order-meta num">' + UI.esc(o.order_date || '—') + '</span>' +
            '</div>' +
            '<div class="order-sub muted">' + UI.esc(o.channel || '未填渠道') + ' · ' + st.count + ' 件</div>' +
            '<div class="order-stats">' +
              '<span>本体 <b class="num">' + money(st.body) + '</b></span>' +
              '<span>邮费 <b class="num">' + money(st.ship) + '</b></span>' +
              '<span>实付 <b class="num">' + (st.ps === 'unknown' ? '—' : money(st.paid)) + '</b></span>' +
              (st.paidManual && st.ps !== 'unknown' ? '<span>余款 <b class="num">' + money(Math.max(0, st.remain)) + '</b></span>' : '') +
            '</div>' +
            (st.unknownQty > 0 ? '<div class="order-flags"><span class="tag tag--unknown">价格未知 ' + st.unknownQty + ' 件</span></div>' : '') +
            '<div class="order-flags">' + flags + '</div>' +
          '</div>' +
        '</div>' +
      '</article>';
  }

  function listHTML() {
    var list = filtered();
    if (!list.length) {
      var hasData = state.orders.length > 0;
      return '<div class="empty">' +
        '<p class="empty-title">' + (hasData ? '无符合筛选条件的订单' : '还没有订单，去新增第一笔合单') + '</p>' +
        (hasData ? '' : '<button type="button" class="btn btn--primary" data-act="add">＋ 新增订单</button>') +
        '</div>';
    }
    return '<div class="lib-list order-list">' + list.map(cardHTML).join('') + '</div>';
  }

  function batchBarHTML() {
    var n = Object.keys(state.selected).filter(function (k) { return state.selected[k]; }).length;
    return '<div class="batch-bar" id="order-batch">' +
      '<span class="batch-count">已选 ' + n + ' 个订单</span>' +
      '<span class="batch-all" data-act="all">全选</span>' +
      '<span class="batch-spacer"></span>' +
      '<span class="batch-exit" data-act="exit">退出</span>' +
      '<button type="button" class="btn btn--primary batch-apply" data-act="hand">批量到手</button>' +
      '</div>';
  }

  function pageHTML() {
    return '<section class="page page--orders">' +
      toolbarHTML() +
      '<div id="order-list-wrap">' + listHTML() + '</div>' +
      (state.selectMode ? batchBarHTML() : '') +
      '</section>';
  }

  function render() {
    dom.container.innerHTML = pageHTML();
    cacheDom();
    bind();
  }

  function cacheDom() {
    var c = dom.container;
    dom.page = c.querySelector('.page--orders');
    dom.wrap = c.querySelector('#order-list-wrap');
  }

  function renderList() {
    if (dom.wrap) dom.wrap.innerHTML = listHTML();
  }

  function exitBatch() {
    state.selectMode = false;
    state.selected = {};
    render();
  }

  // ---- 批量到手（O-10） ----

  function refreshAggs(ids) {
    ids = ids.filter(function (v, i, a) { return a.indexOf(v) === i; });
    return Promise.all(ids.map(function (gid) {
      return Promise.all([
        S.get('goods', gid),
        S.query('purchase_items', 'goods_id', gid),
        S.query('sale_items', 'goods_id', gid)
      ]).then(function (r) {
        if (!r[0]) return null;
        var g = r[0];
        g.agg = A.computeGoodsAgg(g, r[1] || [], r[2] || []);
        return { action: 'put', store: 'goods', value: g };
      });
    })).then(function (ops) {
      ops = ops.filter(Boolean);
      if (!ops.length) return;
      return S.bulk('goods', ops);
    });
  }

  function batchHand() {
    var ids = Object.keys(state.selected).filter(function (k) { return state.selected[k]; });
    if (!ids.length) { UI.toast('请先勾选订单', 'error'); return; }
    UI.confirmDialog({
      title: '批量置为到手',
      message: '将所选 ' + ids.length + ' 个订单内「定尾预售/全款预售/在途」的未售出件全部置为「现货在手」？',
      confirmText: '到手'
    }).then(function (ok) {
      if (!ok) return;
      var ops = [], affected = {};
      ids.forEach(function (oid) {
        (state.itemsByOrder[oid] || []).forEach(function (p) {
          if (num(p.quantity) - num(p.sold_quantity) <= 0) return;
          if (p.status === 'on_hand' || p.status === 'sold_out') return;
          var rec = {};
          for (var k in p) { if (Object.prototype.hasOwnProperty.call(p, k)) rec[k] = p[k]; }
          rec.status = 'on_hand';
          ops.push({ action: 'put', store: 'purchase_items', value: rec });
          affected[p.goods_id] = 1;
        });
      });
      if (!ops.length) { UI.toast('所选订单没有可流转的件', 'error'); return; }
      S.bulk('purchase_items', ops).then(function () {
        return refreshAggs(Object.keys(affected));
      }).then(function () {
        UI.toast('已批量置为到手', 'success');
        exitBatch();
      }).catch(function (err) {
        if (!(err && err.expected)) console.error('[EATG] 批量到手失败', err);
        UI.toast('操作失败：' + (err && err.message || err), 'error');
      });
    });
  }

  // ---- 事件 ----

  function bind() {
    if (dom.page) {
      on(dom.page, 'click', function (e) {
        var pick = e.target.closest('[data-pick]');
        if (pick) {
          var pid = pick.dataset.pick;
          if (state.selected[pid]) delete state.selected[pid];
          else state.selected[pid] = true;
          render();
          return;
        }
        var act = e.target.closest('[data-act]');
        if (act) {
          var a = act.dataset.act;
          if (a === 'add') { go('#/order/edit?mode=new'); return; }
          if (a === 'batch') { if (state.selectMode) exitBatch(); else { state.selectMode = true; state.selected = {}; render(); } return; }
          if (a === 'exit') { exitBatch(); return; }
          if (a === 'all') {
            var list = filtered();
            list.forEach(function (o) { state.selected[o.id] = true; });
            render();
            return;
          }
          if (a === 'hand') { batchHand(); return; }
        }
        var card = e.target.closest('[data-oid]');
        if (card) {
          if (state.selectMode) {
            var oid = card.dataset.oid;
            if (state.selected[oid]) delete state.selected[oid];
            else state.selected[oid] = true;
            render();
          } else {
            go('#/order/edit?id=' + card.dataset.oid);
          }
        }
      });
    }
    var chSel = dom.container.querySelector('#f-channel');
    var tSel = dom.container.querySelector('#f-time');
    on(chSel, 'change', function () { state.filters.channel = chSel.value; renderList(); });
    on(tSel, 'change', function () { state.filters.time = tSel.value; renderList(); });
  }

  function go(hash) {
    if (EATG.app && EATG.app.navigate) EATG.app.navigate(hash);
    else global.location.hash = hash;
  }

  // ---- 挂载 / 卸载 ----

  function mount(container, ctx) {
    resetState();
    dom = { container: container, ctx: ctx };
    ctx.setTitle('订单');
    ctx.setBack(false);
    ctx.setActiveTab('library');
    if (ctx.navActions) {
      ctx.navActions.innerHTML = '<button type="button" class="icon-btn icon-btn--accent" id="order-add" aria-label="新增订单">＋</button>';
    }
    container.innerHTML = '<div class="skeleton skeleton-bar" style="width:100%;height:120px;margin-bottom:12px"></div>' +
      '<div class="skeleton skeleton-bar" style="width:100%;height:120px"></div>';

    return load().then(function () {
      if (state.destroyed) return;
      render();
      var addBtn = ctx.navActions ? ctx.navActions.querySelector('#order-add') : null;
      on(addBtn, 'click', function () { go('#/order/edit?mode=new'); });
    }, function (err) {
      if (!(err && err.expected)) console.error('[EATG] 订单列表加载失败', err);
      UI.toast('加载失败：' + (err && err.message || err), 'error');
      container.innerHTML = '<div class="empty"><p class="empty-title">加载失败，请返回重试</p></div>';
    });
  }

  function unmount() {
    state && (state.destroyed = true);
    clearOffs();
    dom = {};
    state = null;
  }

  EATG.pages['orders'] = { key: 'orders', mount: mount, unmount: unmount };

})(window);
