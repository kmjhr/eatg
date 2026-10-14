/* ==========================================================================
   一咕（EATG）· 图鉴条目编辑（js/pages/gallery_edit.js）
   实现：《页面线框与UI规范》P10
   路由：#/gallery/edit?id= 或 #/gallery/edit?character_id=
   表单：所属角色、名称、系列、发售日期、图片、拥有状态、关联谷子款（可选）
   保存/删除（二次确认）。
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
  function esc(s) { return UI.esc(s == null ? '' : String(s)); }

  function resetState() {
    state = {
      destroyed: false,
      mode: 'add',
      itemId: null,
      item: { character_id: null, name: '', series: '', release_date: '', image: '', owned: false, goods_id: null },
      characters: [],
      goods: []
    };
  }

  function load(ctx) {
    var params = new URLSearchParams(ctx.query);
    var id = params.get('id');
    var cid = params.get('character_id');
    return Promise.all([S.getAll('characters'), S.getAll('goods')]).then(function (r) {
      state.characters = r[0] || [];
      state.goods = r[1] || [];
      if (id) {
        state.mode = 'edit';
        state.itemId = Number(id);
        return S.get('gallery_items', state.itemId).then(function (it) {
          if (!it) throw new Error('图鉴条目不存在');
          state.item = clone(it);
        });
      }
      state.mode = 'add';
      if (cid) state.item.character_id = Number(cid);
      else if (state.characters[0]) state.item.character_id = state.characters[0].id;
    });
  }

  function clone(o) { var r = {}; for (var k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = o[k]; } return r; }

  function charOpts() {
    return state.characters.map(function (c) {
      return '<option value="' + c.id + '"' + (state.item.character_id === c.id ? ' selected' : '') + '>' + esc(c.name) + '</option>';
    }).join('');
  }

  function goodsOpts() {
    var opts = '<option value="">不关联</option>';
    opts += state.goods.map(function (g) {
      return '<option value="' + g.id + '"' + (state.item.goods_id === g.id ? ' selected' : '') + '>' + esc(g.name || ('谷子#' + g.id)) + '</option>';
    }).join('');
    return opts;
  }

  function pageHTML() {
    var it = state.item;
    return '<div class="page-scroll" id="ge-page">' +
      '<div class="form-section">' +
        '<div class="field"><div class="field-head"><label class="field-label">所属角色</label></div>' +
          '<select id="ge-char" class="input">' + charOpts() + '</select></div>' +
        '<div class="field"><div class="field-head"><label class="field-label">条目名称</label></div>' +
          '<input id="ge-name" class="input" type="text" value="' + esc(it.name) + '" placeholder="官方谷子名"></div>' +
        '<div class="field"><div class="field-head"><label class="field-label">系列</label></div>' +
          '<input id="ge-series" class="input" type="text" value="' + esc(it.series) + '"></div>' +
        '<div class="field"><div class="field-head"><label class="field-label">发售日期</label></div>' +
          '<input id="ge-date" class="input" type="date" value="' + esc(it.release_date) + '"></div>' +
        '<div class="field"><div class="field-head"><label class="field-label">图片</label></div>' +
          '<div class="ge-img-row">' +
            (it.image ? '<img class="ge-img" src="' + esc(it.image) + '">' : '<div class="ge-img ge-img--ph">无图</div>') +
            '<span class="btn btn--secondary" id="ge-img-btn" style="position:relative">选择图片' +
              '<input type="file" id="ge-img-input" class="input-cover" accept="image/*"></span>' +
            (it.image ? '<button type="button" class="btn btn--secondary" id="ge-img-clear">清除</button>' : '') +
          '</div></div>' +
        '<div class="field"><div class="field-head"><label class="field-label">关联谷子款（可选）</label></div>' +
          '<select id="ge-goods" class="input">' + goodsOpts() + '</select>' +
          '<p class="hint">关联后以谷子购入状态自动判定拥有情况</p></div>' +
        '<div class="field"><div class="field-head"><label class="field-label">拥有状态（手动标记）</label></div>' +
          '<label class="switch"><input type="checkbox" id="ge-owned" ' + (it.owned ? 'checked' : '') + '><span class="switch-track"></span>已拥有</label>' +
          '<p class="hint">有关联谷子款时以谷子状态为准，自动覆盖</p></div>' +
      '</div>' +
      '<div class="detail-actions">' +
        (state.mode === 'edit' ? '<button type="button" class="btn btn--danger" data-act="del">删除</button>' : '') +
        '<button type="button" class="btn btn--primary" data-act="save">保存</button>' +
      '</div>' +
    '</div>';
  }

  function cacheDom() {
    var p = document.getElementById('ge-page');
    dom.page = p;
    dom.char = p.querySelector('#ge-char');
    dom.name = p.querySelector('#ge-name');
    dom.series = p.querySelector('#ge-series');
    dom.date = p.querySelector('#ge-date');
    dom.goods = p.querySelector('#ge-goods');
    dom.owned = p.querySelector('#ge-owned');
    dom.imgBtn = p.querySelector('#ge-img-btn');
    dom.imgInput = p.querySelector('#ge-img-input');
    dom.imgClear = p.querySelector('#ge-img-clear');
  }

  function bind(ctx) {
    // 图片选择：input 覆盖按钮真实触摸；覆盖失效时点击按钮兜底 JS click（两路互斥）
    on(dom.imgBtn, 'click', function (e) {
      if (e.target === dom.imgInput) return;
      try { dom.imgInput.click(); } catch (err) { console.error('[EATG] 图鉴选图兜底失败', err); }
    });
    on(dom.imgInput, 'change', function () {
      var f = dom.imgInput.files[0];
      if (!f) return;
      U.compressImage(f, { maxEdge: 600, quality: 0.8 }).then(function (b64) {
        state.item.image = b64;
        rerender();
      }).catch(function () { UI.toast('图片处理失败', 'error'); });
    });
    if (dom.imgClear) on(dom.imgClear, 'click', function () { state.item.image = ''; rerender(); });
    on(dom.page, 'click', function (e) {
      var act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.dataset.act === 'save') doSave(ctx);
      else if (act.dataset.act === 'del') doDel(ctx);
    });
  }

  function doSave(ctx) {
    var it = state.item;
    it.character_id = Number(dom.char.value) || null;
    it.name = dom.name.value.trim();
    it.series = dom.series.value.trim();
    it.release_date = dom.date.value || '';
    it.goods_id = dom.goods.value ? Number(dom.goods.value) : null;
    it.owned = dom.owned.checked;
    if (!it.character_id) { UI.toast('请选择所属角色', 'error'); return; }
    if (!it.name) { UI.toast('请填写条目名称', 'error'); return; }
    var rec = clone(it);
    var p = state.mode === 'edit' ? S.put('gallery_items', rec) : S.add('gallery_items', rec);
    p.then(function () {
      UI.toast('已保存', 'success');
      goBack(ctx);
    }).catch(function (err) {
      UI.toast('保存失败：' + (err && err.message || err), 'error');
    });
  }

  function doDel(ctx) {
    UI.confirmDialog({
      title: '删除条目',
      message: '删除后不可恢复，确认删除？',
      confirmText: '删除',
      danger: true,
      onConfirm: function () {
        S.del('gallery_items', state.itemId).then(function () {
          UI.toast('已删除', 'success');
          goBack(ctx);
        });
      }
    });
  }

  function goBack(ctx) {
    if (ctx && ctx.navigate) ctx.navigate('#/gallery');
    else if (EATG.app) EATG.app.navigate('#/gallery');
  }

  function rerender() {
    var container = dom.container;
    if (!container) return;
    container.innerHTML = pageHTML();
    cacheDom();
    bind({ navigate: goBack });
  }

  function mount(container, ctx) {
    resetState();
    dom = { container: container };
    container.innerHTML = '<div class="loading">加载中…</div>';
    ctx.setTitle(state.mode === 'edit' ? '编辑图鉴条目' : '新增图鉴条目');
    ctx.setBack(true);
    ctx.setActiveTab('gallery');
    return load(ctx).then(function () {
      if (state.destroyed) return;
      container.innerHTML = pageHTML();
      cacheDom();
      bind(ctx);
    }).catch(function (err) {
      if (state.destroyed) return;
      if (!(err && err.expected)) console.error('[EATG] 图鉴编辑加载失败', err);
      UI.toast('加载失败：' + (err && err.message || err), 'error');
    });
  }

  function unmount() {
    if (state) state.destroyed = true;
    clearOffs();
  }

  EATG.pages['gallery/edit'] = { key: 'gallery/edit', mount: mount, unmount: unmount };

})(window);
