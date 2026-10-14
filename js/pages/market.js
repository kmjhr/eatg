/* ==========================================================================
   一咕（EATG）· 行情首页（js/pages/market.js）
   实现：《页面线框与UI规范》P11
   路由：#/market
   内容：1 顶部导航：搜索（名称/角色/IP，300ms防抖）+ 筛选抽屉（多选chip，同收藏库）+ 「+录入」
        2 估值汇总条：市价总值 / 已估值件数
        3 列表：谷子名 / 平台 / 最近价 / 日期 / 品相，按最近行情倒序；无行情谷子标注「未估值」
   口径：市价总值 = Σ goods.market_price（仅非空）；已估值件数 = market_price 非空的谷子数。
   筛选维度：IP / 角色 / 类型 / 状态 / 平台 / 品相 / 估值（有·无行情）
   ========================================================================== */
(function (global) {
  'use strict';

  var EATG = (global.EATG = global.EATG || {});
  var S = EATG.storage;
  var U = EATG.utils;
  var UI = EATG.ui;
  var A = EATG.agg;

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
      characters: [],
      pricesByGoods: {},   // goods_id -> price_records[]
      latestByGoods: {},   // goods_id -> latest price_record
      keyword: '',
      filters: { ip: [], char: [], type: [], status: [], platform: [], condition: [], valued: [] }
    };
  }

  // ---- 数据加载 ----
  function load() {
    return Promise.all([S.getAll('goods'), S.getAll('price_records'), S.getAll('characters')]).then(function (r) {
      state.goods = r[0] || [];
      state.characters = r[2] || [];
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

  function charNames(ids) {
    if (!ids || !ids.length) return '';
    var nameOf = {};
    (state.characters || []).forEach(function (c) { nameOf[c.id] = c.name; });
    return ids.map(function (id) { return nameOf[id] || ''; }).filter(Boolean).join('、');
  }

  function filteredGoods() {
    var f = state.filters;
    var q = state.keyword.trim().toLowerCase();
    var list = sortedGoods();
    return list.filter(function (g) {
      if (q) {
        var name = String(g.name || '').toLowerCase();
        var ip = String(g.ip || '').toLowerCase();
        var chars = charNames(g.character_ids).toLowerCase();
        if (name.indexOf(q) < 0 && ip.indexOf(q) < 0 && chars.indexOf(q) < 0) return false;
      }
      if (f.ip.length && f.ip.indexOf(g.ip || '') === -1) return false;
      if (f.type.length && f.type.indexOf(g.goods_type || '') === -1) return false;
      if (f.status.length && f.status.indexOf(g.status || '') === -1) return false;
      if (f.char.length) {
        var ids = g.character_ids || [];
        if (!ids.some(function (id) { return f.char.indexOf(Number(id)) !== -1; })) return false;
      }
      var latest = state.latestByGoods[g.id];
      if (f.platform.length && (!latest || f.platform.indexOf(latest.platform || '') === -1)) return false;
      if (f.condition.length && (!latest || f.condition.indexOf(latest.condition || '') === -1)) return false;
      if (f.valued.length) {
        var has = !!latest;
        var wV = f.valued.indexOf('1') !== -1, wU = f.valued.indexOf('0') !== -1;
        if ((wV && !has) || (wU && has)) return false;
      }
      return true;
    });
  }

  // ---- 筛选抽屉（同收藏库） ----
  function optionSets() {
    function uniq(arr) { var seen = {}, out = []; arr.forEach(function (v) { if (v != null && !seen[v]) { seen[v] = 1; out.push(v); } }); return out; }
    var ipOpts = uniq(state.goods.map(function (g) { return g.ip; }).filter(Boolean));
    var typeOpts = uniq(state.goods.map(function (g) { return g.goods_type; }).filter(Boolean));
    var platOpts = [], condOpts = [];
    Object.keys(state.pricesByGoods).forEach(function (gid) {
      state.pricesByGoods[gid].forEach(function (p) {
        if (p.platform) platOpts.push(p.platform);
        if (p.condition) condOpts.push(p.condition);
      });
    });
    platOpts = uniq(platOpts);
    condOpts = uniq(condOpts);
    var charOpts = (state.characters || []).map(function (c) { return { id: c.id, name: c.name, fav: !!c.is_favorite }; })
      .sort(function (a, b) { return (b.fav ? 1 : 0) - (a.fav ? 1 : 0) || String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'); });

    return {
      ip: { title: 'IP', type: 'value', opts: ipOpts },
      char: { title: '角色', type: 'char', opts: charOpts },
      type: { title: '类型', type: 'value', opts: typeOpts },
      status: { title: '状态', type: 'status', opts: A.STATUS_ORDER },
      platform: { title: '平台', type: 'value', opts: platOpts },
      condition: { title: '品相', type: 'value', opts: condOpts },
      valued: { title: '估值', type: 'value', opts: ['1', '0'] }
    };
  }

  function labelOf(cat, v) {
    if (cat === 'status') return A.STATUS_LABELS[v];
    if (cat === 'valued') return v === '1' ? '有行情' : '无行情';
    return v;
  }

  function openFilterSheet() {
    var sets = optionSets();
    var draft = {
      ip: state.filters.ip.slice(), char: state.filters.char.slice(), type: state.filters.type.slice(),
      status: state.filters.status.slice(), platform: state.filters.platform.slice(),
      condition: state.filters.condition.slice(), valued: state.filters.valued.slice()
    };
    var html = Object.keys(sets).map(function (cat) {
      var cfg = sets[cat];
      var chips = cfg.opts.map(function (o) {
        var val = cfg.type === 'char' ? o.id : o;
        var label = cfg.type === 'char' ? o.name : labelOf(cat, o);
        var cls = cfg.type === 'char' && o.fav ? ' is-fav' : '';
        return '<button type="button" class="opt-chip' + cls + '" data-cat="' + cat + '" data-val="' + esc(val) + '">' + esc(label) + '</button>';
      }).join('');
      return '<div class="filter-group"><div class="filter-group-title">' + esc(cfg.title) + '</div>' +
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
          draft = { ip: [], char: [], type: [], status: [], platform: [], condition: [], valued: [] };
          syncChips();
        } else if (b.dataset.act === 'apply') {
          state.filters = draft;
          ref.close();
          rerender();
        }
      });
    }
  }

  function clearFilters() {
    state.filters = { ip: [], char: [], type: [], status: [], platform: [], condition: [], valued: [] };
  }

  function updateFilterIndicator() {
    if (!dom.filterEl) return;
    var f = state.filters;
    var n = f.ip.length + f.char.length + f.type.length + f.status.length + f.platform.length + f.condition.length + f.valued.length;
    var badge = dom.filterEl.querySelector('.icon-badge');
    dom.filterEl.classList.toggle('is-active', n > 0);
    if (badge) { badge.hidden = n === 0; badge.textContent = String(n); }
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
      listHTML() +
    '</div>';
  }

  function go(hash) { if (EATG.app && EATG.app.navigate) EATG.app.navigate(hash); }

  function rerender() {
    var page = document.getElementById('market-page');
    if (!page) return;
    page.innerHTML = summaryHTML() + listHTML();
    updateFilterIndicator();
  }

  // ---- 顶部导航（搜索 + 筛选 + 录入，同收藏库） ----
  function buildNav(ctx) {
    ctx.navActions.innerHTML =
      '<div class="nav-search">' +
        '<svg class="nav-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
          '<circle cx="11" cy="11" r="6"/><path d="M20 20l-3.5-3.5"/></svg>' +
        '<input type="search" id="mkt-search" placeholder="搜索名称/角色/IP" autocomplete="off" />' +
      '</div>' +
      '<button type="button" class="icon-btn" id="mkt-filter" aria-label="筛选">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M3 5h18l-7 8v6l-4 2v-8z"/></svg>' +
        '<span class="icon-badge" hidden></span>' +
      '</button>' +
      '<button type="button" class="icon-btn icon-btn--accent" id="mkt-add" aria-label="录入行情">＋</button>';

    if (ctx.nav) ctx.nav.classList.add('top-nav--search');

    var searchEl = ctx.navActions.querySelector('#mkt-search');
    var filterEl = ctx.navActions.querySelector('#mkt-filter');
    var addEl = ctx.navActions.querySelector('#mkt-add');
    dom.filterEl = filterEl;

    dom.searchTimer = null;
    on(searchEl, 'input', function () {
      if (dom.searchTimer) clearTimeout(dom.searchTimer);
      dom.searchTimer = setTimeout(function () {
        state.keyword = searchEl.value || '';
        rerender();
      }, 300);
    });

    on(filterEl, 'click', openFilterSheet);
    on(addEl, 'click', function () { go('#/market/add'); });
  }

  function mount(container, ctx) {
    resetState();
    dom = { container: container, ctx: ctx };
    container.innerHTML = '<div class="loading">加载中…</div>';
    ctx.setTitle('行情');
    ctx.setBack(false);
    ctx.setActiveTab('market');
    buildNav(ctx);
    updateFilterIndicator();
    return load().then(function () {
      if (state.destroyed) return;
      container.innerHTML = pageHTML();
      updateFilterIndicator();
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
