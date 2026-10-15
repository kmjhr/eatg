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
      goods: [],
      galleryCats: []
    };
  }

  function load(ctx) {
    var params = new URLSearchParams(ctx.query);
    var id = params.get('id');
    var cid = params.get('character_id');
    return Promise.all([S.getAll('characters'), S.getAll('goods'), S.getSetting('galleryCats')]).then(function (r) {
      // 图鉴角色独立：只显示 gallery!==false 的角色（谷子侧角色不进图鉴所属角色列表）
      state.characters = (r[0] || []).filter(function (c) { return c.gallery !== false; });
      state.goods = r[1] || [];
      state.galleryCats = (Array.isArray(r[2]) && r[2].length) ? r[2] : EATG.DEFAULT_GALLERY_CATS.slice();
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
      // 自动修复：同名图鉴角色去重合并后重载角色列表
      return U.dedupeGalleryChars().then(function (res) {
        if (res && res.merged) {
          return S.getAll('characters').then(function (chars2) {
            state.characters = (chars2 || []).filter(function (c) { return c.gallery !== false; });
            if (cid && !state.characters.some(function (c) { return c.id === Number(cid); })) {
              state.item.character_id = state.characters[0] ? state.characters[0].id : null;
            }
          });
        }
      });
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

  function catOpts() {
    var cur = String(state.item.category || '');
    var cats = state.galleryCats.length ? state.galleryCats : EATG.DEFAULT_GALLERY_CATS;
    var list = [''].concat(cats);
    return list.map(function (c) {
      return '<option value="' + c + '"' + (cur === c ? ' selected' : '') + '>' + (c || '未填写（归入「其他」）') + '</option>';
    }).join('');
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
        '<div class="field"><div class="field-head"><label class="field-label">品类</label></div>' +
          '<select id="ge-cat" class="input">' + catOpts() + '</select>' +
          '<p class="hint">未填写默认归入「其他」，图鉴页可按品类筛选</p></div>' +
        '<div class="field"><div class="field-head"><label class="field-label">发售日期</label></div>' +
          '<input id="ge-date" class="input" type="date" value="' + esc(it.release_date) + '"></div>' +
        '<div class="field"><div class="field-head"><label class="field-label">图片</label></div>' +
          '<div class="grid9" id="ge-grid">' +
            (it.image
              ? '<div class="grid9-cell"><img id="ge-img-view" src="' + esc(it.image) + '" alt="" data-edit="0">' +
                '<button type="button" class="cell-del" id="ge-img-clear" aria-label="移除图片">×</button>' +
                '<button type="button" class="cell-edit" id="ge-img-edit" aria-label="编辑图片（旋转/裁剪）">✎</button></div>'
              : '') +
            '<button type="button" class="grid9-add" id="ge-img-add" aria-label="添加图片">＋<span>添加图片</span></button>' +
          '</div>' +
          '<p class="hint">点图或 ✎ 编辑（旋转/裁剪），× 移除；「添加图片」拍照/相册选图，选中后先编辑再确认</p></div>' +
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
    dom.cat = p.querySelector('#ge-cat');
    dom.date = p.querySelector('#ge-date');
    dom.goods = p.querySelector('#ge-goods');
    dom.owned = p.querySelector('#ge-owned');
    dom.imgView = p.querySelector('#ge-img-view');
    dom.imgEdit = p.querySelector('#ge-img-edit');
    dom.imgClear = p.querySelector('#ge-img-clear');
    dom.imgAdd = p.querySelector('#ge-img-add');
  }

  function bind(ctx) {
    // 与谷子页一致：点图/✎ 编辑（旋转/裁剪）、× 移除、＋ 添加（拍照/相册选择单，选中后先编辑）
    if (dom.imgView) on(dom.imgView, 'click', function () { openEdit(); });
    if (dom.imgEdit) on(dom.imgEdit, 'click', function () { openEdit(); });
    if (dom.imgClear) on(dom.imgClear, 'click', function () { state.item.image = ''; rerender(); });
    if (dom.imgAdd) on(dom.imgAdd, 'click', openAddImageSheet);
    on(dom.page, 'click', function (e) {
      var act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.dataset.act === 'save') doSave(ctx);
      else if (act.dataset.act === 'del') doDel(ctx);
    });
  }

  /** 「添加图片」：拍照/相册选择单；选中照片后先编辑（旋转/裁剪）再替换 */
  function openAddImageSheet() {
    var ref = UI.sheet({
      title: '添加图片',
      bodyHTML: '<div class="opt-list">' +
        '<span class="opt-row opt-row--file" data-src="camera">' +
          '<button type="button" class="opt-row-btn">拍照</button>' +
          '<input type="file" class="input-cover" accept="image/*" capture="environment" data-src="camera">' +
          '<span class="opt-check">›</span></span>' +
        '<span class="opt-row opt-row--file" data-src="album">' +
          '<button type="button" class="opt-row-btn">从相册选择</button>' +
          '<input type="file" class="input-cover" accept="image/*" data-src="album">' +
          '<span class="opt-check">›</span></span>' +
        '</div>'
    });
    ref.body.addEventListener('change', function (e) {
      var inp = e.target.closest('input[type=file]');
      if (!inp) return;
      ref.close();
      pickAndEdit(inp);
    });
    ref.body.addEventListener('click', function (e) {
      var row = e.target.closest('.opt-row--file');
      if (!row) return;
      var inp = row.querySelector('input[type=file]');
      if (!inp || e.target === inp) return;
      try { inp.click(); } catch (err) { console.error('[EATG] 图鉴选图兜底失败', err); }
    });
  }

  /** 选中照片后先编辑（旋转/裁剪）再替换条目图；取消=保留原图 */
  function pickAndEdit(inputEl) {
    var f = inputEl.files[0];
    inputEl.value = '';
    if (!f) return;
    UI.toast('正在处理图片…');
    U.importImagesWithEdit([f], {
      maxCount: 1,
      maxEdge: 900,
      onEach: function (dataUrl) { state.item.image = dataUrl; }
    }).then(function (res) {
      if (state.destroyed) return;
      if (res.added) { UI.toast('图片已更新', 'success'); rerender(); }
      else UI.toast('未选择图片', 'error');
    }).catch(function (err) { UI.toast('图片处理失败：' + (err && err.message || err), 'error'); });
  }

  /** 点击条目图/编辑按钮：打开编辑器修改现有图片 */
  function openEdit() {
    var src = state.item.image;
    if (!src) return;
    if (!U.openImageEditor) { UI.toast('图片编辑暂不可用', 'error'); return; }
    U.openImageEditor(src).then(function (out) {
      if (state.destroyed || out == null) return;
      state.item.image = out;
      rerender();
      UI.toast('图片已更新', 'success');
    });
  }

  function doSave(ctx) {
    var it = state.item;
    it.character_id = Number(dom.char.value) || null;
    it.name = dom.name.value.trim();
    it.series = dom.series.value.trim();
    it.category = (dom.cat ? dom.cat.value : '') || '';
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
