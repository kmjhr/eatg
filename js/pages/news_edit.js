/* ==========================================================================
   一咕（EATG）· 资讯详情 / 手动添加（js/pages/news_edit.js）
   实现：《页面线框与UI规范》P15
   路由：#/news/edit          （手动添加）
        #/news/edit?id=<nid>  （详情/编辑）
   表单：标题、图片、IP、角色、类型、开订、出荷、参考价、渠道、备注
   详情：大图 + 完整信息 + 原文链接 + 三操作
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

  function yuanToCents(s) {
    s = String(s == null ? '' : s).trim();
    if (!s) return null;
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
    return Math.round(Number(s) * 100);
  }
  function centsToYuan(cents) {
    if (cents == null || !isFinite(Number(cents))) return '';
    var fixed = (Number(cents) / 100).toFixed(2);
    return fixed.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  }

  function resetState() {
    state = {
      destroyed: false,
      mode: 'add',
      id: null,
      record: {
        title: '', image: '', ip: '', character_ids: [], goods_type: '',
        preorder_time: '', release_time: '', price: null, channel: '', note: '',
        status: 'normal', is_read: true
      },
      enums: { ip: [], goods_type: [], channel: [] },
      characters: []
    };
  }

  function load(ctx) {
    var params = new URLSearchParams(ctx.query);
    var id = params.get('id');
    return Promise.all([
      S.get('enums', 'ip'),
      S.get('enums', 'goods_type'),
      S.get('enums', 'channel'),
      S.getAll('characters')
    ]).then(function (r) {
      state.enums.ip = (r[0] && r[0].values) || [];
      state.enums.goods_type = (r[1] && r[1].values) || [];
      state.enums.channel = (r[2] && r[2].values) || [];
      state.characters = r[3] || [];
      if (id) {
        state.mode = 'edit';
        state.id = Number(id);
        return S.get('news', state.id).then(function (n) {
          if (!n) throw new Error('资讯不存在');
          Object.assign(state.record, n);
        });
      }
    });
  }

  function charNames(ids) {
    if (!ids || !ids.length) return '';
    var map = {};
    state.characters.forEach(function (c) { map[c.id] = c; });
    return ids.map(function (id) { var c = map[id]; return c ? c.name : ''; }).filter(Boolean).join('、');
  }

  // ---- 详情渲染 ----
  function detailHTML() {
    var r = state.record;
    var img = r.image ? '<img class="ne-detail-img" src="' + r.image + '" alt="">' : '<div class="ne-detail-img ne-detail-img--ph">无图</div>';
    var actions = '<div class="ne-detail-actions">' +
      '<button type="button" class="btn btn--secondary" data-act="wish">想买</button>' +
      '<button type="button" class="btn btn--primary" data-act="order">已订</button>' +
      '<button type="button" class="btn btn--danger" data-act="ignore">忽略</button>' +
      '</div>';
    if (state.mode === 'edit') {
      actions = '<div class="ne-detail-actions">' +
        '<button type="button" class="btn btn--secondary" data-act="edit">编辑</button>' +
        '<button type="button" class="btn btn--danger" data-act="del">删除</button>' +
        '</div>' + actions;
    }
    return '<div class="page-scroll" id="ne-page">' +
      '<div class="ne-detail">' +
        img +
        '<h2 class="ne-detail-title">' + esc(r.title) + '</h2>' +
        '<div class="ne-detail-meta">' +
          (r.ip ? '<span class="tag tag--ip">' + esc(r.ip) + '</span>' : '') +
          (charNames(r.character_ids) ? '<span class="tag">' + esc(charNames(r.character_ids)) + '</span>' : '') +
          (r.goods_type ? '<span class="tag">' + esc(r.goods_type) + '</span>' : '') +
        '</div>' +
        '<div class="ne-detail-info">' +
          (r.preorder_time ? '<div><span class="muted">开订</span> ' + esc(r.preorder_time) + '</div>' : '') +
          (r.release_time ? '<div><span class="muted">出荷</span> ' + esc(r.release_time) + '</div>' : '') +
          (r.price != null ? '<div><span class="muted">参考价</span> <b class="num">' + money(r.price) + '</b></div>' : '') +
          (r.channel ? '<div><span class="muted">渠道</span> ' + esc(r.channel) + '</div>' : '') +
          (r.note ? '<div><span class="muted">备注</span> ' + esc(r.note) + '</div>' : '') +
        '</div>' +
        actions +
      '</div>' +
    '</div>';
  }

  // ---- 表单渲染 ----
  function selectOpts(list, selected, placeholder) {
    var opts = '<option value="">' + placeholder + '</option>';
    opts += list.map(function (v) {
      return '<option value="' + esc(v) + '"' + (selected === v ? ' selected' : '') + '>' + esc(v) + '</option>';
    }).join('');
    return opts;
  }

  function charCheckboxes() {
    var sel = state.record.character_ids || [];
    return state.characters.map(function (c) {
      return '<label class="ne-char-chip"><input type="checkbox" value="' + c.id + '"' + (sel.indexOf(c.id) >= 0 ? ' checked' : '') + '><span>' + esc(c.name) + '</span></label>';
    }).join('');
  }

  function formHTML() {
    var r = state.record;
    return '<div class="page-scroll" id="ne-page">' +
      '<div class="form-section">' +
        '<div class="field"><div class="field-head"><label class="field-label">标题 *</label></div>' +
          '<input id="ne-title" class="input" type="text" value="' + esc(r.title) + '" placeholder="资讯标题"></div>' +
        '<div class="field"><div class="field-head"><label class="field-label">图片</label></div>' +
          (r.image ? '<img class="ne-img-preview" src="' + r.image + '">' : '<div class="ne-img-preview ne-img-preview--ph">无图</div>') +
          '<input id="ne-image" type="file" accept="image/*" style="margin-top:8px">' +
          '<button type="button" class="btn btn--secondary btn--sm" id="ne-clear-img" style="margin-top:6px">清除图片</button></div>' +
        '<div class="field"><div class="field-head"><label class="field-label">IP</label></div>' +
          '<select id="ne-ip" class="input">' + selectOpts(state.enums.ip, r.ip, '选择IP') + '</select></div>' +
        '<div class="field"><div class="field-head"><label class="field-label">角色</label></div>' +
          '<div class="ne-char-list">' + charCheckboxes() + '</div></div>' +
        '<div class="field"><div class="field-head"><label class="field-label">谷子类型</label></div>' +
          '<select id="ne-type" class="input">' + selectOpts(state.enums.goods_type, r.goods_type, '选择类型') + '</select></div>' +
        '<div class="field"><div class="field-head"><label class="field-label">开订时间</label></div>' +
          '<input id="ne-preorder" class="input" type="date" value="' + esc(r.preorder_time) + '"></div>' +
        '<div class="field"><div class="field-head"><label class="field-label">出荷时间</label></div>' +
          '<input id="ne-release" class="input" type="date" value="' + esc(r.release_time) + '"></div>' +
        '<div class="field"><div class="field-head"><label class="field-label">参考价（元）</label></div>' +
          '<div class="money-input"><input id="ne-price" class="input" type="text" inputmode="decimal" placeholder="0.00" value="' + esc(centsToYuan(r.price)) + '"><span class="money-unit">元</span></div></div>' +
        '<div class="field"><div class="field-head"><label class="field-label">渠道</label></div>' +
          '<select id="ne-channel" class="input">' + selectOpts(state.enums.channel, r.channel, '选择渠道') + '</select></div>' +
        '<div class="field"><div class="field-head"><label class="field-label">备注</label></div>' +
          '<textarea id="ne-note" class="textarea" rows="3">' + esc(r.note) + '</textarea></div>' +
      '</div>' +
      '<div class="detail-actions"><button type="button" class="btn btn--primary" data-act="save">保存</button></div>' +
    '</div>';
  }

  function go(hash) { if (EATG.app && EATG.app.navigate) EATG.app.navigate(hash); }

  function render() {
    var container = dom.container;
    container.innerHTML = state.mode === 'edit' ? detailHTML() : formHTML();
    cacheDom();
    bind();
  }

  function cacheDom() {
    var p = document.getElementById('ne-page');
    dom.page = p;
    dom.title = p.querySelector('#ne-title');
    dom.ip = p.querySelector('#ne-ip');
    dom.type = p.querySelector('#ne-type');
    dom.preorder = p.querySelector('#ne-preorder');
    dom.release = p.querySelector('#ne-release');
    dom.price = p.querySelector('#ne-price');
    dom.channel = p.querySelector('#ne-channel');
    dom.note = p.querySelector('#ne-note');
    dom.image = p.querySelector('#ne-image');
  }

  function readChars() {
    var boxes = dom.page.querySelectorAll('.ne-char-chip input[type=checkbox]');
    var ids = [];
    boxes.forEach(function (b) { if (b.checked) ids.push(Number(b.value)); });
    return ids;
  }

  function bind() {
    if (state.mode === 'edit' && dom.page.classList.contains('ne-detail') === false) {
      // detail view
    }
    if (dom.image) {
      on(dom.image, 'change', function () {
        var file = dom.image.files && dom.image.files[0];
        if (!file) return;
        U.compressImage(file, 0.8).then(function (dataUrl) {
          state.record.image = dataUrl;
          render();
        }).catch(function () { UI.toast('图片处理失败', 'error'); });
      });
    }
    var clearImg = document.getElementById('ne-clear-img');
    if (clearImg) on(clearImg, 'click', function () { state.record.image = ''; render(); });

    on(dom.page, 'click', function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      var act = btn.dataset.act;
      if (act === 'save') doSave();
      else if (act === 'edit') { state.mode = 'form'; render(); }
      else if (act === 'del') doDel();
      else if (act === 'wish') doStatus('wish');
      else if (act === 'order') doStatus('ordered');
      else if (act === 'ignore') doStatus('ignored');
    });
  }

  function collectForm() {
    var r = state.record;
    r.title = dom.title.value.trim();
    r.ip = dom.ip.value;
    r.character_ids = readChars();
    r.goods_type = dom.type.value;
    r.preorder_time = dom.preorder.value;
    r.release_time = dom.release.value;
    r.price = yuanToCents(dom.price.value);
    r.channel = dom.channel.value;
    r.note = dom.note.value.trim();
  }

  function doSave() {
    collectForm();
    if (!state.record.title) { UI.toast('请填写标题', 'error'); return; }
    var p;
    if (state.mode === 'edit') {
      p = S.put('news', Object.assign({ id: state.id }, state.record));
    } else {
      state.record.created_at = Date.now();
      state.record.is_read = true;
      p = S.add('news', state.record);
    }
    p.then(function () {
      UI.toast('已保存', 'success');
      go(state.mode === 'edit' ? '#/news' : '#/news');
    }).catch(function (err) {
      UI.toast('保存失败：' + (err && err.message || err), 'error');
    });
  }

  function doDel() {
    UI.confirmDialog({ title: '删除资讯', message: '确认删除该资讯？', confirmText: '删除', danger: true }).then(function (ok) {
      if (!ok) return;
      S.del('news', state.id).then(function () {
        UI.toast('已删除', 'success');
        go('#/news');
      }).catch(function (err) { UI.toast('删除失败', 'error'); });
    });
  }

  function doStatus(status) {
    return S.get('news', state.id).then(function (n) {
      if (!n) return;
      n.status = status;
      n.is_read = true;
      return S.put('news', n);
    }).then(function () {
      state.record.status = status;
      UI.toast(status === 'wish' ? '已加入愿望清单' : status === 'ordered' ? '已标记已订' : '已忽略', 'success');
      if (status === 'ordered') {
        var r = state.record;
        var params = new URLSearchParams();
        params.set('mode', 'add'); params.set('from', 'news');
        params.set('name', r.title || '');
        if (r.ip) params.set('ip', r.ip);
        if (r.goods_type) params.set('goods_type', r.goods_type);
        if (r.character_ids && r.character_ids.length) params.set('chars', r.character_ids.join(','));
        if (r.channel) params.set('channel', r.channel);
        params.set('status', 'deposit_pre');
        go('#/goods/edit?' + params.toString());
      } else {
        render();
      }
    });
  }

  function mount(container, ctx) {
    resetState();
    dom = { container: container };
    container.innerHTML = '<div class="loading">加载中…</div>';
    ctx.setTitle(state.mode === 'edit' ? '资讯详情' : '添加资讯');
    ctx.setBack(true);
    ctx.setActiveTab('news');
    return load(ctx).then(function () {
      if (state.destroyed) return;
      render();
    }).catch(function (err) {
      if (state.destroyed) return;
      if (!(err && err.expected)) console.error('[EATG] 资讯编辑加载失败', err);
      UI.toast('加载失败：' + (err && err.message || err), 'error');
    });
  }

  function unmount() {
    if (state) state.destroyed = true;
    clearOffs();
  }

  EATG.pages['news/edit'] = { key: 'news/edit', mount: mount, unmount: unmount };

})(window);
