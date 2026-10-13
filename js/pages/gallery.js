/* ==========================================================================
   一咕（EATG）· 角色图鉴首页（js/pages/gallery.js）
   实现：《页面线框与UI规范》P09 +《业务规则》§9 图鉴三态
   路由：#/gallery
   内容：1 角色横滑条（默认素世）+ 右上添加角色
        2 进度区（头像/名称/IP/已拥有数/总数/进度条 --accent）
        3 两列图鉴网格：三态卡片（已拥有亮显+角标 / 已拥有未出荷半亮+状态角标 / 未拥有灰剪影）
        4 自动点亮：关联 goods 任一购入 on_hand → owned（覆盖手动值）；预售/在途 → 半亮
        5 条目点击：详情 + “去收藏库补录”（预填角色跳新增页）+ 手动切换拥有
        6 点亮动画 300ms（grayscale→color）
   口径：三态判定见 computeItemState；金额无关。
   ========================================================================== */
(function (global) {
  'use strict';

  var EATG = (global.EATG = global.EATG || {});
  var S = EATG.storage;
  var U = EATG.utils;
  var UI = EATG.ui;

  EATG.pages = EATG.pages || {};

  var STATUS_LABELS = {
    deposit_pre: '定尾预售', full_pre: '全款预售', shipping: '在途',
    on_hand: '现货在手', sold_out: '已出荷'
  };

  var state = null;
  var dom = {};
  var offs = [];

  function on(el, ev, fn, opt) { if (!el) return; el.addEventListener(ev, fn, opt); offs.push([el, ev, fn, opt]); }
  function clearOffs() { offs.forEach(function (t) { t[0].removeEventListener(t[1], t[2], t[3]); }); offs = []; }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function esc(s) { return UI.esc(s == null ? '' : String(s)); }
  function clone(o) { var r = {}; for (var k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = o[k]; } return r; }

  function resetState() {
    state = {
      destroyed: false,
      characters: [],
      items: [],
      goodsById: {},
      purchasesByGoods: {},
      currentCharId: null,
      search: '',
      groupBySeries: true
    };
  }

  // ---- 三态判定（《业务规则》§9 唯一口径）----
  /**
   * @returns { state: 'owned'|'half'|'none', status: string|null, goodsName: string|null }
   */
  function computeItemState(item) {
    var gid = item.goods_id;
    if (gid && state.goodsById[gid]) {
      var g = state.goodsById[gid];
      var ps = state.purchasesByGoods[gid] || [];
      var hasOnHand = ps.some(function (p) { return p.status === 'on_hand'; });
      if (hasOnHand) return { state: 'owned', status: 'on_hand', goodsName: g.name };
      var preShip = ps.filter(function (p) {
        return p.status === 'deposit_pre' || p.status === 'full_pre' || p.status === 'shipping';
      });
      if (preShip.length) {
        // 取最靠前（最待办）的状态
        var rank = { deposit_pre: 0, full_pre: 1, shipping: 2 };
        preShip.sort(function (a, b) { return rank[a.status] - rank[b.status]; });
        return { state: 'half', status: preShip[0].status, goodsName: g.name };
      }
      // 全部 sold_out 或无购入：视为未拥有
      return { state: 'none', status: null, goodsName: g.name };
    }
    // 无关联 goods：以手动 owned 为准
    return { state: item.owned ? 'owned' : 'none', status: null, goodsName: null };
  }

  // ---- 数据加载 ----
  function load() {
    return Promise.all([
      S.getAll('characters'),
      S.getAll('gallery_items'),
      S.getAll('goods'),
      S.getAll('purchase_items')
    ]).then(function (r) {
      state.characters = r[0] || [];
      state.items = r[1] || [];
      state.goodsById = {};
      (r[2] || []).forEach(function (g) { state.goodsById[g.id] = g; });
      state.purchasesByGoods = {};
      (r[3] || []).forEach(function (p) {
        (state.purchasesByGoods[p.goods_id] = state.purchasesByGoods[p.goods_id] || []).push(p);
      });
      // 默认选中：自推优先，否则第一个
      if (!state.currentCharId || !state.characters.some(function (c) { return c.id === state.currentCharId; })) {
        var fav = state.characters.filter(function (c) { return c.is_favorite; })[0];
        state.currentCharId = (fav || state.characters[0] || {}).id || null;
      }
    });
  }

  function currentItems() {
    if (!state.currentCharId) return [];
    return state.items.filter(function (it) { return it.character_id === state.currentCharId; });
  }

  function currentChar() {
    return state.characters.filter(function (c) { return c.id === state.currentCharId; })[0] || null;
  }

  // ---- 进度 ----
  function progress(items) {
    var owned = 0, total = items.length;
    items.forEach(function (it) {
      var st = computeItemState(it);
      if (st.state === 'owned') owned++;
    });
    return { owned: owned, total: total, pct: total ? Math.round(owned / total * 100) : 0 };
  }

  // ---- 渲染 ----

  function charScrollHTML() {
    return '<div class="gal-char-scroll" id="gal-char-scroll">' +
      state.characters.map(function (c) {
        var on = c.id === state.currentCharId;
        return '<div class="gal-char-chip' + (on ? ' is-active' : '') + '" data-cid="' + c.id + '">' +
          (c.avatar ? '<img class="gal-avatar" src="' + esc(c.avatar) + '">' : '<div class="gal-avatar gal-avatar--ph">' + esc((c.name || '?').charAt(0)) + '</div>') +
          '<span class="gal-char-name">' + esc(c.name) + '</span>' +
        '</div>';
      }).join('') +
    '</div>';
  }

  function progressHTML() {
    var c = currentChar();
    if (!c) return '<div class="gal-progress"><p class="empty-line">还没有角色，点击右上「＋」添加</p></div>';
    var items = currentItems();
    var pr = progress(items);
    return '<div class="gal-progress">' +
      '<div class="gal-prog-head">' +
        (c.avatar ? '<img class="gal-prog-avatar" src="' + esc(c.avatar) + '">' : '<div class="gal-prog-avatar gal-avatar--ph">' + esc((c.name || '?').charAt(0)) + '</div>') +
        '<div class="gal-prog-info">' +
          '<div class="gal-prog-name">' + esc(c.name) + '</div>' +
          '<div class="gal-prog-ip">' + esc(c.ip || '—') + '</div>' +
          '<div class="gal-prog-count"><span class="num">' + pr.owned + '</span> / ' + pr.total + ' 已拥有</div>' +
        '</div>' +
      '</div>' +
      '<div class="gal-prog-bar"><div class="gal-prog-fill" style="width:' + pr.pct + '%"></div></div>' +
    '</div>';
  }

  function itemCardHTML(it) {
    var st = computeItemState(it);
    var img = it.image ? 'background-image:url(' + esc(it.image) + ')' : '';
    var badge = '';
    if (st.state === 'owned') badge = '<span class="gal-badge gal-badge--owned">拥有</span>';
    else if (st.state === 'half') badge = '<span class="gal-badge gal-badge--' + st.status + '">' + esc(STATUS_LABELS[st.status] || st.status) + '</span>';
    var nameCls = st.state === 'none' ? 'gal-card-name is-muted' : 'gal-card-name';
    var stateCls = 'gal-card--' + st.state;
    return '<div class="gal-card ' + stateCls + '" data-iid="' + it.id + '">' +
      '<div class="gal-card-img" style="' + img + '">' + badge + '</div>' +
      '<div class="' + nameCls + '">' + esc(it.name) + '</div>' +
      (it.series ? '<div class="gal-card-series">' + esc(it.series) + '</div>' : '') +
    '</div>';
  }

  function groupBySeriesItems(items) {
    var map = {}, order = [];
    items.forEach(function (it) {
      var key = it.series || '未分组';
      if (!map[key]) { map[key] = []; order.push(key); }
      map[key].push(it);
    });
    return order.map(function (k) { return { series: k, items: map[k] }; });
  }

  function gridHTML() {
    var items = currentItems();
    if (state.search) {
      var q = state.search.trim().toLowerCase();
      items = items.filter(function (it) { return String(it.name || '').toLowerCase().indexOf(q) >= 0; });
    }
    if (!items.length) {
      return '<p class="empty-line">还没有图鉴条目，去添加官方谷子</p>';
    }
    var html = '<div class="gal-grid">';
    if (state.groupBySeries) {
      groupBySeriesItems(items).forEach(function (g) {
        html += '<div class="gal-group"><div class="gal-group-title">' + esc(g.series) + '</div><div class="gal-grid-row">';
        g.items.forEach(function (it) { html += itemCardHTML(it); });
        html += '</div></div>';
      });
    } else {
      html += '<div class="gal-grid-row">';
      items.forEach(function (it) { html += itemCardHTML(it); });
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function toolbarHTML() {
    return '<div class="gal-toolbar">' +
      '<input id="gal-search" class="input" type="text" placeholder="搜索条目名称" value="' + esc(state.search) + '">' +
      '<button type="button" class="btn btn--secondary" id="gal-group-btn">' + (state.groupBySeries ? '取消分组' : '按系列分组') + '</button>' +
    '</div>';
  }

  function pageHTML() {
    return '<div class="page-scroll" id="gallery-page">' +
      charScrollHTML() +
      progressHTML() +
      toolbarHTML() +
      gridHTML() +
    '</div>';
  }

  // ---- 详情抽屉 ----
  function openDetail(item) {
    var st = computeItemState(item);
    var c = state.characters.filter(function (ch) { return ch.id === item.character_id; })[0];
    var goodsInfo = st.goodsName ? ('关联谷子：' + st.goodsName) : '未关联谷子款';
    var stateText = st.state === 'owned' ? '已拥有（亮显）' : (st.state === 'half' ? '已拥有未出荷（' + (STATUS_LABELS[st.status] || '') + '）' : '未拥有');
    var body = '<div class="gal-detail">' +
      (item.image ? '<img class="gal-detail-img" src="' + esc(item.image) + '">' : '<div class="gal-detail-img gal-detail-img--ph">无图</div>') +
      '<div class="gal-detail-name">' + esc(item.name) + '</div>' +
      '<div class="gal-detail-meta">角色：' + esc(c ? c.name : '—') + '</div>' +
      (item.series ? '<div class="gal-detail-meta">系列：' + esc(item.series) + '</div>' : '') +
      (item.release_date ? '<div class="gal-detail-meta">发售：' + esc(item.release_date) + '</div>' : '') +
      '<div class="gal-detail-meta">状态：' + esc(stateText) + '</div>' +
      '<div class="gal-detail-meta">' + esc(goodsInfo) + '</div>' +
    '</div>' +
    '<div class="detail-actions">' +
      '<button type="button" class="btn btn--secondary" data-act="edit">编辑</button>' +
      (st.state === 'none' ? '<button type="button" class="btn btn--primary" data-act="add-goods">去收藏库补录</button>' : '') +
      (st.state === 'none' ? '<button type="button" class="btn btn--secondary" data-act="toggle-owned">标记已拥有</button>' : '') +
      '<button type="button" class="btn btn--danger" data-act="del">删除</button>' +
    '</div>';
    var ref = UI.sheet({ title: '图鉴条目', bodyHTML: body });
    ref.body.addEventListener('click', function (e) {
      var act = e.target.closest('[data-act]');
      if (!act) return;
      var a = act.dataset.act;
      if (a === 'edit') { ref.close(); go('#/gallery/edit?id=' + item.id); }
      else if (a === 'add-goods') {
        ref.close();
        go('#/goods/edit?mode=new&from=gallery&name=' + encodeURIComponent(item.name || '') +
          (c ? '&chars=' + c.id : '') + (c && c.ip ? '&ip=' + encodeURIComponent(c.ip) : ''));
      }
      else if (a === 'toggle-owned') {
        item.owned = !item.owned;
        S.put('gallery_items', item).then(function () {
          UI.toast(item.owned ? '已标记为拥有' : '已取消拥有', 'success');
          ref.close();
          rerender();
        });
      }
      else if (a === 'del') {
        UI.confirmDialog({
          title: '删除条目',
          message: '删除后不可恢复，确认删除？',
          confirmText: '删除',
          danger: true,
          onConfirm: function () {
            S.del('gallery_items', item.id).then(function () {
              UI.toast('已删除', 'success');
              ref.close();
              rerender();
            });
          }
        });
      }
    });
  }

  // ---- 添加角色 ----
  function openAddChar() {
    var body = '<div class="form-section">' +
      '<div class="field"><div class="field-head"><label class="field-label">角色名</label></div><input id="nc-name" class="input" type="text" placeholder="如：长崎素世"></div>' +
      '<div class="field"><div class="field-head"><label class="field-label">所属 IP</label></div><input id="nc-ip" class="input" type="text" placeholder="如：MyGO"></div>' +
    '</div>';
    var ref = UI.sheet({ title: '添加角色', bodyHTML: body, footerHTML: '<button type="button" class="btn btn--primary" data-act="ok">保存</button>' });
    ref.el.addEventListener('click', function (e) {
      if (e.target.dataset.act !== 'ok') return;
      var name = document.getElementById('nc-name').value.trim();
      var ip = document.getElementById('nc-ip').value.trim();
      if (!name) { UI.toast('请填写角色名', 'error'); return; }
      S.add('characters', { name: name, ip: ip || '', is_favorite: state.characters.length === 0 }).then(function (id) {
        state.currentCharId = Number(id);
        UI.toast('已添加角色', 'success');
        ref.close();
        reload();
      });
    });
  }

  function go(hash) { if (EATG.app && EATG.app.navigate) EATG.app.navigate(hash); }

  function rerender() {
    var page = document.getElementById('gallery-page');
    if (!page) return;
    page.innerHTML = charScrollHTML() + progressHTML() + toolbarHTML() + gridHTML();
    bindInner();
  }

  function reload() {
    return load().then(function () { if (!state.destroyed) rerender(); });
  }

  function bindInner() {
    var page = document.getElementById('gallery-page');
    if (!page) return;
    on(page.querySelector('#gal-char-scroll'), 'click', function (e) {
      var chip = e.target.closest('.gal-char-chip');
      if (chip) { state.currentCharId = Number(chip.dataset.cid); rerender(); }
    });
    var search = document.getElementById('gal-search');
    if (search) on(search, 'input', function () { state.search = search.value; rerender(); });
    var gb = document.getElementById('gal-group-btn');
    if (gb) on(gb, 'click', function () { state.groupBySeries = !state.groupBySeries; rerender(); });
    on(page, 'click', function (e) {
      var card = e.target.closest('.gal-card');
      if (card) {
        var it = state.items.filter(function (x) { return x.id === Number(card.dataset.iid); })[0];
        if (it) openDetail(it);
      }
    });
  }

  function mount(container, ctx) {
    resetState();
    dom = { container: container };
    container.innerHTML = '<div class="loading">加载中…</div>';
    ctx.setTitle('图鉴');
    ctx.setBack(false);
    ctx.setActiveTab('gallery');
    ctx.navActions.innerHTML = '<button id="gal-add-char" type="button" class="icon-btn icon-btn--accent" title="添加角色">＋</button><button id="gal-add-item" type="button" class="icon-btn" title="添加图鉴条目">＋</button>';
    var addChar = document.getElementById('gal-add-char');
    var addItem = document.getElementById('gal-add-item');
    if (addChar) on(addChar, 'click', openAddChar);
    if (addItem) on(addItem, 'click', function () {
      if (!state.currentCharId) { UI.toast('请先选择或添加角色', 'error'); return; }
      go('#/gallery/edit?character_id=' + state.currentCharId);
    });
    return load().then(function () {
      if (state.destroyed) return;
      container.innerHTML = pageHTML();
      bindInner();
    }).catch(function (err) {
      if (state.destroyed) return;
      if (!(err && err.expected)) console.error('[EATG] 图鉴加载失败', err);
      UI.toast('加载失败：' + (err && err.message || err), 'error');
    });
  }

  function unmount() {
    if (state) state.destroyed = true;
    clearOffs();
  }

  EATG.pages['gallery'] = { key: 'gallery', mount: mount, unmount: unmount };

})(window);
