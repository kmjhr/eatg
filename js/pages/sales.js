/* ==========================================================================
   一咕（EATG）· 卖出订单列表（js/pages/sales.js）
   实现：《页面线框与UI规范》P08 列表 +《业务规则》§3/§4
   路由：#/sales
   内容：卖出订单卡片（名称/日期/渠道/总售价/手续费/邮费/实收/盈利合计）；
        渠道/时间筛选；点击卡片进入编辑；右上「+ 新建卖出订单」。
   口径：金额「分」整数；net_total = total_price − total_fee − total_shipping；
        盈利合计 = Σ(各件 filled 口径 profit)，估算盈利单列标注。
   ========================================================================== */
(function (global) {
  'use strict';

  var EATG = (global.EATG = global.EATG || {});
  var S = EATG.storage;
  var A = EATG.agg;
  var U = EATG.utils;
  var UI = EATG.ui;

  EATG.pages = EATG.pages || {};

  var TIME_OPTIONS = [['', '全部时间'], ['7', '近7天'], ['30', '近30天'], ['90', '近90天'], ['365', '近一年']];

  var state = null;
  var dom = {};
  var offs = [];

  function on(el, ev, fn, opt) { if (!el) return; el.addEventListener(ev, fn, opt); offs.push([el, ev, fn, opt]); }
  function clearOffs() { offs.forEach(function (t) { t[0].removeEventListener(t[1], t[2], t[3]); }); offs = []; }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function money(c) { return U.fmtMoney(c, 'CNY'); }

  function resetState() {
    state = {
      destroyed: false,
      orders: [],
      itemsByOrder: {},
      purchasesById: {},
      goodsById: {},
      enums: { channel: [] },
      filters: { channel: '', time: '' }
    };
  }

  /** 订单统计：实收、盈利（filled）、估算盈利、件数 */
  function orderStats(o) {
    var items = state.itemsByOrder[o.id] || [];
    var profit = 0, estProfit = 0, count = 0;
    items.forEach(function (it) {
      count += num(it.quantity);
      var p = state.purchasesById[it.purchase_item_id];
      if (!p) return;
      if (it.cost_settled && it.cost_base != null) {
        profit += A.saleNet(it) - num(it.cost_base);
        return;
      }
      if (p.price_status === 'unknown') return;
      var pr = A.saleNet(it) - A.proratedPurchaseCost(p, it.quantity);
      if (p.price_status === 'filled') profit += pr;
      else estProfit += pr;
    });
    return {
      net: num(o.net_total),
      profit: profit,
      estProfit: estProfit,
      count: count
    };
  }

  function inChannel(o) { return !state.filters.channel || o.channel === state.filters.channel; }
  function inTime(o) {
    if (!state.filters.time) return true;
    var d = o.sale_date;
    if (!d) return false;
    var days = Number(state.filters.time);
    var t = new Date(d).getTime();
    if (isNaN(t)) return false;
    return (Date.now() - t) <= days * 86400000;
  }
  function filtered() {
    return state.orders.filter(function (o) { return inChannel(o) && inTime(o); })
      .sort(function (a, b) { return String(b.sale_date || '').localeCompare(String(a.sale_date || '')) || (Number(b.id) - Number(a.id)); });
  }

  function load() {
    return Promise.all([
      S.getAll('sale_orders'),
      S.getAll('sale_items'),
      S.getAll('purchase_items'),
      S.getAll('goods'),
      S.get('enums', 'channel')
    ]).then(function (r) {
      state.orders = r[0] || [];
      var items = r[1] || [];
      state.itemsByOrder = {};
      items.forEach(function (it) {
        if (it.sale_order_id == null) return;
        (state.itemsByOrder[it.sale_order_id] = state.itemsByOrder[it.sale_order_id] || []).push(it);
      });
      state.purchasesById = {};
      (r[2] || []).forEach(function (p) { state.purchasesById[p.id] = p; });
      state.goodsById = {};
      (r[3] || []).forEach(function (g) { state.goodsById[g.id] = g; });
      state.enums.channel = (r[4] && r[4].values) || [];
    });
  }

  function toolbarHTML() {
    var channels = state.enums.channel.map(function (c) {
      return '<option value="' + UI.esc(c) + '"' + (c === state.filters.channel ? ' selected' : '') + '>' + UI.esc(c) + '</option>';
    }).join('');
    var times = TIME_OPTIONS.map(function (t) {
      return '<option value="' + t[0] + '"' + (t[0] === state.filters.time ? ' selected' : '') + '>' + t[1] + '</option>';
    }).join('');
    return '<div class="order-filter">' +
      '<select id="f-channel" class="order-filter-sel"><option value="">全部渠道</option>' + channels + '</select>' +
      '<select id="f-time" class="order-filter-sel">' + times + '</select>' +
      '</div>';
  }

  function cardHTML(o) {
    var st = orderStats(o);
    var profitCls = st.profit > 0 ? 'up' : (st.profit < 0 ? 'down' : '');
    var estTag = st.estProfit ? '<span class="tag tag--est">估算 ' + money(st.estProfit) + '</span>' : '';
    return '<article class="order-card order-card--list" data-oid="' + o.id + '">' +
      '<div class="order-head">' +
        '<span class="order-name">' + UI.esc(o.sale_order_name || ('卖出订单 #' + o.id)) + '</span>' +
        '<span class="order-meta">' + UI.esc(o.sale_date || '—') + ' · ' + UI.esc(o.channel || '—') + '</span>' +
      '</div>' +
      '<div class="order-body">' +
        '<div class="order-row"><span class="order-sub">总售价</span><span class="num">' + money(num(o.total_price)) + '</span></div>' +
        '<div class="order-row"><span class="order-sub">手续费</span><span class="num">' + money(num(o.total_fee)) + '</span></div>' +
        '<div class="order-row"><span class="order-sub">邮费</span><span class="num">' + money(num(o.total_shipping)) + '</span></div>' +
        '<div class="order-row"><span class="order-sub">实收</span><span class="num">' + money(st.net) + '</span></div>' +
        '<div class="order-row"><span class="order-sub">件数</span><span class="num">' + st.count + '</span></div>' +
        '<div class="order-row"><span class="order-sub">盈利</span><span class="num profit ' + profitCls + '">' + money(st.profit) + '</span>' + estTag + '</div>' +
      '</div>' +
    '</article>';
  }

  function listHTML() {
    var list = filtered();
    if (!list.length) {
      return '<p class="empty-line">暂无卖出订单，点击右上「+」新建</p>';
    }
    return list.map(cardHTML).join('');
  }

  function pageHTML() {
    return '<div class="page-inner">' + toolbarHTML() + '<div id="so-list" class="lib-list">' + listHTML() + '</div></div>';
  }

  function cacheDom() {
    dom.page = document.getElementById('sales-page');
    dom.list = document.getElementById('so-list');
    dom.fChannel = document.getElementById('f-channel');
    dom.fTime = document.getElementById('f-time');
  }

  function renderList() {
    if (dom.list) dom.list.innerHTML = listHTML();
  }

  function bind(ctx) {
    on(dom.fChannel, 'change', function () { state.filters.channel = dom.fChannel.value; renderList(); });
    on(dom.fTime, 'change', function () { state.filters.time = dom.fTime.value; renderList(); });
    on(dom.page, 'click', function (e) {
      var card = e.target.closest('.order-card--list');
      if (card) { go('#/sale/edit?id=' + card.dataset.oid); return; }
    });
    ctx.navActions.innerHTML = '<button id="so-add" type="button" class="icon-btn icon-btn--accent" title="新建卖出订单">＋</button>';
    var addBtn = document.getElementById('so-add');
    if (addBtn) on(addBtn, 'click', function () { go('#/sale/edit?mode=new'); });
  }

  function go(hash) {
    if (EATG.app && EATG.app.navigate) EATG.app.navigate(hash);
  }

  function mount(container, ctx) {
    resetState();
    dom = { container: container };
    container.innerHTML = '<div id="sales-page" class="page-scroll"></div>';
    var page = document.getElementById('sales-page');
    page.innerHTML = pageHTML();
    ctx.setTitle('卖出订单');
    ctx.setBack(false);
    ctx.setActiveTab('mine');
    cacheDom();
    bind(ctx);
    return load().then(function () {
      if (state.destroyed) return;
      page.innerHTML = pageHTML();
      cacheDom();
      bind(ctx);
      if (ctx && ctx.restoreScroll) ctx.restoreScroll();
    }).catch(function (err) {
      if (!(err && err.expected)) console.error('[EATG] 卖出订单列表加载失败', err);
      UI.toast('加载失败：' + (err && err.message || err), 'error');
    });
  }

  function unmount() {
    if (state) state.destroyed = true;
    clearOffs();
  }

  EATG.pages['sales'] = { key: 'sales', mount: mount, unmount: unmount };

})(window);
