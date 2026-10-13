/* ==========================================================================
   一咕（EATG）· 愿望清单（js/pages/wishlist.js）
   实现：《页面线框与UI规范》P17 + 《业务规则》§10
   路由：#/wishlist
   内容：1 列表：想买资讯（名称/IP角色/开订/出荷/参考价），按开订时间升序
        2 操作：标记已订（转收藏库预填）、移除（status→normal）、编辑提醒时间
   数据：愿望清单 = news 表中 status='wish' 的条目
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
    state = { destroyed: false, items: [], charsById: {} };
  }

  function load() {
    return Promise.all([S.getAll('news'), S.getAll('characters')]).then(function (r) {
      state.items = (r[0] || []).filter(function (n) { return n.status === 'wish'; })
        .sort(function (a, b) { return (a.preorder_time || '9999').localeCompare(b.preorder_time || '9999'); });
      state.charsById = {};
      (r[1] || []).forEach(function (c) { state.charsById[c.id] = c; });
    });
  }

  function charNames(ids) {
    if (!ids || !ids.length) return '';
    return ids.map(function (id) { var c = state.charsById[id]; return c ? c.name : ''; }).filter(Boolean).join('、');
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

  function pageHTML() {
    if (!state.items.length) {
      return '<div class="page-scroll" id="wl-page"><p class="empty-line">愿望清单为空，去资讯页把想买的谷子加入吧～</p></div>';
    }
    return '<div class="page-scroll" id="wl-page"><div class="wl-list">' + state.items.map(itemHTML).join('') + '</div></div>';
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
    var n = state.items.filter(function (x) { return x.id === nid; })[0];
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
    var n = state.items.filter(function (x) { return x.id === nid; })[0];
    if (!n) return;
    n.status = 'normal';
    S.put('news', n).then(function () {
      UI.toast('已移出愿望清单', 'success');
      state.items = state.items.filter(function (x) { return x.id !== nid; });
      render();
    }).catch(function () { UI.toast('操作失败', 'error'); });
  }

  function editRemind(nid) {
    var n = state.items.filter(function (x) { return x.id === nid; })[0];
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
    ctx.setTitle('愿望清单');
    ctx.setBack(true);
    ctx.setActiveTab('news');
    return load().then(function () {
      if (state.destroyed) return;
      render();
    }).catch(function (err) {
      if (state.destroyed) return;
      if (!(err && err.expected)) console.error('[EATG] 愿望清单加载失败', err);
      UI.toast('加载失败：' + (err && err.message || err), 'error');
    });
  }

  function unmount() {
    if (state) state.destroyed = true;
    clearOffs();
  }

  EATG.pages['wishlist'] = { key: 'wishlist', mount: mount, unmount: unmount };

})(window);
