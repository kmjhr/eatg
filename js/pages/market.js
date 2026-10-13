/* ==========================================================================
   一咕（EATG）· 行情首页（js/pages/market.js）
   实现：《页面线框与UI规范》P11
   路由：#/market
   内容：1 顶部：标题 + 搜索 + 「+录入」
        2 估值汇总条：市价总值 / 已估值件数
        3 列表：谷子名 / 平台 / 最近价 / 日期 / 品相，按最近行情倒序；无行情谷子标注「未估值」
   口径：市价总值 = Σ goods.market_price（仅非空）；已估值件数 = market_price 非空的谷子数。
   ========================================================================== */
(function (global) {
  'use strict';

  var EATG = (global.EATG = global.EATG || {});
  var S = EATG.storage;
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
  function esc(s) { return UI.esc(s == null ? '' : String(s)); }

  function resetState() {
    state = {
      destroyed: false,
      goods: [],
      pricesByGoods: {},   // goods_id -> price_records[]
      latestByGoods: {},   // goods_id -> latest price_record
      search: ''
    };
  }

  // ---- 数据加载 ----
  function load() {
    return Promise.all([S.getAll('goods'), S.getAll('price_records')]).then(function (r) {
      state.goods = r[0] || [];
      state.pricesByGoods = {};
      state.latestByGoods = {};
      (r[1] || []).forEach(function (p) {
        (state.pricesByGoods[p.goods_id] = state.pricesByGoods[p.goods_id] || []).push(p);
      });
      Object.keys(state.pricesByGoods).forEach(function (gid) {
        var list = state.pricesByGoods[gid].slice();
        // 最新：按 record_date 降序，同日期按 created_at 降序
        list.sort(function (a, b) {
          if (a.record_date !== b.record_date) return (b.record_date || '').localeCompare(a.record_date || '');
          return num(b.created_at) - num(a.created_at);
        });
        state.latestByGoods[gid] = list[0];
      });
    });
  }

  // ---- 估值汇总 ----
  function valuation() {
    var total = 0, counted = 0;
    state.goods.forEach(function (g) {
      if (g.market_price != null && isFinite(Number(g.market_price)) && Number(g.market_price) > 0) {
        total += num(g.market_price);
        counted++;
      }
    });
    return { total: total, counted: counted, totalGoods: state.goods.length };
  }

  // ---- 排序：有行情的在前（按最近日期倒序），无行情的在后 ----
  function sortedGoods() {
    var list = state.goods.slice();
    list.sort(function (a, b) {
      var la = state.latestByGoods[a.id];
      var lb = state.latestByGoods[b.id];
      if (la && !lb) return -1;
      if (!la && lb) return 1;
      if (!la && !lb) return num(b.updated_at || b.created_at) - num(a.updated_at || a.created_at);
      if (la.record_date !== lb.record_date) return (lb.record_date || '').localeCompare(la.record_date || '');
      return num(lb.created_at) - num(la.created_at);
    });
    return list;
  }

  function filteredGoods() {
    var q = state.search.trim().toLowerCase();
    var list = sortedGoods();
    if (!q) return list;
    return list.filter(function (g) {
      return String(g.name || '').toLowerCase().indexOf(q) >= 0 ||
        String(g.ip || '').toLowerCase().indexOf(q) >= 0;
    });
  }

  // ---- 渲染 ----
  function summaryHTML() {
    var v = valuation();
    return '<div class="mkt-summary">' +
      '<div class="mkt-sum-card">' +
        '<div class="mkt-sum-label">市价总值</div>' +
        '<div class="mkt-sum-value num">' + money(v.total) + '</div>' +
      '</div>' +
      '<div class="mkt-sum-card">' +
        '<div class="mkt-sum-label">已估值件数</div>' +
        '<div class="mkt-sum-value num">' + v.counted + ' / ' + v.totalGoods + '</div>' +
      '</div>' +
    '</div>';
  }

  function toolbarHTML() {
    return '<div class="mkt-toolbar">' +
      '<input id="mkt-search" class="input" type="text" placeholder="搜索谷子名称 / IP" value="' + esc(state.search) + '">' +
    '</div>';
  }

  function rowHTML(g) {
    var latest = state.latestByGoods[g.id];
    var has = !!latest;
    return '<div class="mkt-row" data-gid="' + g.id + '">' +
      '<div class="mkt-row-main">' +
        '<div class="mkt-row-name">' + esc(g.name || ('谷子#' + g.id)) + '</div>' +
        '<div class="mkt-row-meta">' +
          (g.ip ? '<span class="tag tag--ip">' + esc(g.ip) + '</span>' : '') +
          (has
            ? '<span class="muted">' + esc(latest.platform || '—') + ' · ' + esc(latest.condition || '—') + '</span>'
            : '<span class="mkt-unvalued">未估值</span>') +
        '</div>' +
      '</div>' +
      '<div class="mkt-row-right">' +
        (has ? '<span class="num mkt-price">' + money(latest.price) + '</span>' : '<span class="muted">—</span>') +
        (has ? '<div class="muted">' + esc(latest.record_date || '') + '</div>' : '') +
      '</div>' +
    '</div>';
  }

  function listHTML() {
    var list = filteredGoods();
    if (!list.length) {
      return '<p class="empty-line">没有匹配的谷子</p>';
    }
    return '<div class="mkt-list">' + list.map(rowHTML).join('') + '</div>';
  }

  function pageHTML() {
    return '<div class="page-scroll" id="market-page">' +
      summaryHTML() +
      toolbarHTML() +
      listHTML() +
    '</div>';
  }

  function go(hash) { if (EATG.app && EATG.app.navigate) EATG.app.navigate(hash); }

  function rerender() {
    var page = document.getElementById('market-page');
    if (!page) return;
    page.innerHTML = summaryHTML() + toolbarHTML() + listHTML();
    bindInner();
  }

  function bindInner() {
    var page = document.getElementById('market-page');
    if (!page) return;
    var search = document.getElementById('mkt-search');
    if (search) {
      on(search, 'input', function () { state.search = search.value; rerender(); });
    }
    on(page, 'click', function (e) {
      var row = e.target.closest('.mkt-row');
      if (row) {
        var gid = Number(row.dataset.gid);
        go('#/market/detail?goods_id=' + gid);
      }
    });
  }

  function mount(container, ctx) {
    resetState();
    dom = { container: container };
    container.innerHTML = '<div class="loading">加载中…</div>';
    ctx.setTitle('行情');
    ctx.setBack(false);
    ctx.setActiveTab('market');
    ctx.navActions.innerHTML = '<button id="mkt-add" type="button" class="icon-btn icon-btn--accent" title="录入行情">＋</button>';
    var addBtn = document.getElementById('mkt-add');
    if (addBtn) on(addBtn, 'click', function () { go('#/market/add'); });
    return load().then(function () {
      if (state.destroyed) return;
      container.innerHTML = pageHTML();
      bindInner();
    }).catch(function (err) {
      if (state.destroyed) return;
      if (!(err && err.expected)) console.error('[EATG] 行情首页加载失败', err);
      UI.toast('加载失败：' + (err && err.message || err), 'error');
    });
  }

  function unmount() {
    if (state) state.destroyed = true;
    clearOffs();
  }

  EATG.pages['market'] = { key: 'market', mount: mount, unmount: unmount };

})(window);
