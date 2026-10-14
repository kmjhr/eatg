/* ==========================================================================
   一咕（EATG）· 愿望中心（js/pages/wishlist.js）
   路由：#/wishlist
   概念：想买就是收藏 —— 收藏集合 = 资讯中 is_fav 或 status='wish' 的条目（去重）
   内容：1 列表：收藏的资讯（名称/IP角色/开订/出荷/参考价/状态），按开订时间升序
        2 操作：标记已订（转收藏库预填）、改提醒、移除（移出收藏）
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
    state = { destroyed: false, list: [], charsById: {} };
  }

  function load() {
    return Promise.all([S.getAll('news'), S.getAll('characters')]).then(function (r) {
      var all = r[0] || [];
      var seen = {}, list = [];
      all.forEach(function (n) {
        if (!n) return;
        if (n.is_fav || n.status === 'wish') {
          if (!seen[n.id]) { seen[n.id] = 1; list.push(n); }
        }
      });
      state.list = list.sort(function (a, b) { return (a.preorder_time || '9999').localeCompare(b.preorder_time || '9999'); });
      state.charsById = {};
      (r[1] || []).forEach(function (c) { state.charsById[c.id] = c; });
    });
  }

  function charNames(ids) {
    if (!ids || !ids.length) return '';
    return ids.map(function (id) { var c = state.charsById[id]; return c ? c.name : ''; }).filter(Boolean).join('、');
  }

  function statusBadge(n) {
    if (n.status === 'wish') return '<span class="tag tag--wish">想买</span>';
    if (n.status === 'ordered') return '<span class="tag tag--ordered">已订</span>';
    if (n.status === 'ignored') return '<span class="tag tag--ignored">已忽略</span>';
    return '';
  }

  function itemHTML(n) {
    var img = n.image ? '<img class="wl-img" src="' + n.image + '">' : '<div class="wl-img wl-img--ph">无图</div>';
    var chars = charNames(n.character_ids);
    return '<div class="wl-row" data-nid="' + n.id + '">' +
      '<div class="wl-main">' +
        '<div class="wl-head">' + img +
          '<div class="wl-info">' +
            '<div class="wl-title">' + esc(n.title) + '</div>' +
            '<div class="wl-meta">' +
              statusBadge(n) +
              (n.ip ? '<span class="tag tag--ip">' + esc(n.ip) + '</span>' : '') +
              (chars ? '<span class="tag">' + esc(chars) + '</span>' : '') +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="wl-times">' +
          (n.preorder_time ? '<div><span class="muted">开订</span> <b>' + esc(n.preorder_time) + '</b></div>' : '<div class="muted">开订 —</div>') +
          (n.release_time ? '<div><span class="muted">出荷</span> ' + esc(n.release_time) + '</div>' : '') +
        '</div>' +
        (n.price != null ? '<div class="wl-price num">' + money(n.price) + '</div>' : '') +
      '</div>' +
      '<div class="wl-actions">' +
        '<button type="button" class="btn btn--primary btn--sm" data-act="order">标记已订</button>' +
        '<button type="button" class="btn btn--secondary btn--sm" data-act="remind">改提醒</button>' +
        '<button type="button" class="btn btn--danger btn--sm" data-act="remove">移除</button>' +
      '</div>' +
    '</div>';
  }

  function listHTML() {
    if (!state.list.length) {
      return '<p class="empty-line">收藏为空，去资讯页点「想买」或左滑收藏 ♥ 加入吧～</p>';
    }
    return '<div class="wl-head-bar">收藏（想买）<span class="num">' + state.list.length + '</span></div>' +
      '<div class="wl-list">' + state.list.map(itemHTML).join('') + '</div>';
  }

  function pageHTML() {
    return '<div class="page-scroll" id="wl-page">' + listHTML() + '</div>';
  }

  function findN(nid) {
    for (var i = 0; i < state.list.length; i++) { if (state.list[i].id === nid) return state.list[i]; }
    return null;
  }

  function go(hash) { if (EATG.app && EATG.app.navigate) EATG.app.navigate(hash); }

  function render() { dom.container.innerHTML = pageHTML(); bind(); }

  function bind() {
    var page = document.getElementById('wl-page');
    if (!page) return;
    on(page, 'click', function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      var row = btn.closest('.wl-row');
      if (!row) return;
      var nid = Number(row.dataset.nid);
      var act = btn.dataset.act;
      if (act === 'order') doOrder(nid);
      else if (act === 'remove') doRemove(nid);
      else if (act === 'remind') editRemind(nid);
    });
  }

  function doOrder(nid) {
    var n = findN(nid);
    if (!n) return;
    n.status = 'ordered';
    n.is_read = true;
    S.put('news', n).then(function () {
      UI.toast('已标记已订，跳转收藏库', 'success');
      var params = new URLSearchParams();
      params.set('mode', 'add'); params.set('from', 'news');
      params.set('name', n.title || '');
      if (n.ip) params.set('ip', n.ip);
      if (n.goods_type) params.set('goods_type', n.goods_type);
      if (n.character_ids && n.character_ids.length) params.set('chars', n.character_ids.join(','));
      if (n.channel) params.set('channel', n.channel);
      params.set('status', 'deposit_pre');
      go('#/goods/edit?' + params.toString());
    }).catch(function () { UI.toast('操作失败', 'error'); });
  }

  function doRemove(nid) {
    var n = findN(nid);
    if (!n) return;
    n.status = 'normal';
    n.is_fav = false;
    S.put('news', n).then(function () {
      UI.toast('已移出收藏', 'success');
      state.list = state.list.filter(function (x) { return x.id !== nid; });
      render();
    }).catch(function () { UI.toast('操作失败', 'error'); });
  }

  function editRemind(nid) {
    var n = findN(nid);
    if (!n) return;
    var body = '<div class="field"><div class="field-head"><label class="field-label">开订提醒时间</label></div>' +
      '<input id="wl-preorder" class="input" type="date" value="' + esc(n.preorder_time || '') + '"></div>' +
      '<div class="field"><div class="field-head"><label class="field-label">出荷提醒时间</label></div>' +
      '<input id="wl-release" class="input" type="date" value="' + esc(n.release_time || '') + '"></div>';
    var ref = UI.sheet({ title: '编辑提醒时间', bodyHTML: body, footerHTML: '<button type="button" class="btn btn--primary" data-act="ok">保存</button>' });
    ref.el.addEventListener('click', function (e) {
      if (e.target.dataset.act !== 'ok') return;
      n.preorder_time = document.getElementById('wl-preorder').value;
      n.release_time = document.getElementById('wl-release').value;
      S.put('news', n).then(function () {
        UI.toast('提醒时间已更新', 'success');
        ref.close();
        render();
      }).catch(function () { UI.toast('保存失败', 'error'); });
    });
  }

  function mount(container, ctx) {
    resetState();
    dom = { container: container };
    container.innerHTML = '<div class="loading">加载中…</div>';
    ctx.setTitle('愿望中心');
    ctx.setBack(true);
    ctx.setActiveTab('news');
    return load().then(function () {
      if (state.destroyed) return;
      render();
    }).catch(function (err) {
      if (state.destroyed) return;
      if (!(err && err.expected)) console.error('[EATG] 愿望中心加载失败', err);
      UI.toast('加载失败：' + (err && err.message || err), 'error');
    });
  }

  function unmount() {
    if (state) state.destroyed = true;
    clearOffs();
  }

  EATG.pages['wishlist'] = { key: 'wishlist', mount: mount, unmount: unmount };

})(window);
