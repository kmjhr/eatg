/* ==========================================================================
   一咕（EATG）· 拍照批量录入确认页（js/pages/goods_batch.js）
   路由：#/goods/batch
   数据：localStorage eatg_batch_draft（batch_scan 生成：N 条裁剪图 + OCR 预填）
   能力：逐条编辑必填项（名称/IP/类型/角色/数量/状态/渠道/单价）→ 删除多余条 →
         一键保存 N 条（每条：goods + purchase_items + agg 重算，与录入页同口径）
   ========================================================================== */
(function (global) {
  'use strict';

  var EATG = (global.EATG = global.EATG || {});
  var S = EATG.storage;
  var A = EATG.agg;
  var U = EATG.utils;
  var UI = EATG.ui;

  EATG.pages = EATG.pages || {};

  var DRAFT_KEY = 'eatg_batch_draft';
  var CURRENCIES = ['CNY', 'JPY', '其他'];

  var state = null;
  var dom = {};
  var offs = [];

  function on(el, ev, fn, opt) { if (!el) return; el.addEventListener(ev, fn, opt); offs.push([el, ev, fn, opt]); }
  function clearOffs() { offs.forEach(function (t) { t[0].removeEventListener(t[1], t[2], t[3]); }); offs = []; }
  function esc(s) { return UI.esc(s == null ? '' : String(s)); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }

  function yuanToCents(s) {
    s = String(s == null ? '' : s).trim();
    if (!s) return null;
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
    return Math.round(Number(s) * 100);
  }

  function loadDraft() {
    try {
      var raw = global.localStorage.getItem(DRAFT_KEY);
      if (!raw) return null;
      var d = JSON.parse(raw);
      return (d && Array.isArray(d.items)) ? d.items : null;
    } catch (e) { return null; }
  }

  function saveDraft(items) {
    try { global.localStorage.setItem(DRAFT_KEY, JSON.stringify({ ts: Date.now(), items: items })); return true; }
    catch (e) { return false; }
  }

  function clearDraft() {
    try { global.localStorage.removeItem(DRAFT_KEY); } catch (e) {}
  }

  function selectHTML(id, values, value, placeholder) {
    var opts = '<option value=""' + (value ? '' : ' selected') + '>' + esc(placeholder || '请选择') + '</option>';
    var found = false;
    values.forEach(function (v) {
      var sel = (v === value) ? ' selected' : '';
      if (v === value) found = true;
      opts += '<option value="' + esc(v) + '"' + sel + '>' + esc(v) + '</option>';
    });
    if (value && !found) {
      opts += '<option value="' + esc(value) + '" selected>' + esc(value) + '</option>';
    }
    return '<select id="' + id + '" class="input">' + opts + '</select>';
  }

  function unitText(c) { return c === 'JPY' ? '日元' : (c === '其他' ? '原币·元' : '元'); }

  // ---- 渲染 ----

  function itemHTML(it, i) {
    var statusOpts = A.STATUS_ORDER.map(function (s) {
      return '<option value="' + s + '"' + (it.status === s ? ' selected' : '') + '>' + esc(A.STATUS_LABELS[s]) + '</option>';
    }).join('');
    var charChips = state.characters.map(function (c) {
      var sel = it.charIds.indexOf(Number(c.id)) !== -1;
      return '<button type="button" class="opt-chip' + (sel ? ' is-on' : '') + '" data-char="' + c.id + '">' + esc(c.name) + '</button>';
    }).join('');
    return '<div class="bs-item" data-i="' + i + '">' +
      '<div class="bs-item-head">' +
        '<span class="bs-item-no">#' + (i + 1) + '</span>' +
        '<button type="button" class="btn btn--danger bs-item-del" data-del="' + i + '">删除</button>' +
      '</div>' +
      '<div class="bs-item-body">' +
        '<div class="bs-thumb"><img src="' + esc(it.image || '') + '" alt=""></div>' +
        '<div class="bs-fields">' +
          '<div class="field"><div class="field-head"><label class="field-label" for="bi-name-' + i + '">名称 <span class="req">*</span></label></div>' +
            '<input id="bi-name-' + i + '" class="input" type="text" autocomplete="off" placeholder="如：长崎素世 1st 吧唧" value="' + esc(it.name) + '"></div>' +
          '<div class="field"><div class="field-head"><label class="field-label" for="bi-ip-' + i + '">IP <span class="req">*</span></label></div>' +
            selectHTML('bi-ip-' + i, state.enums.ip, it.ip || '', '请选择 IP') + '</div>' +
          '<div class="field"><div class="field-head"><label class="field-label" for="bi-type-' + i + '">类型 <span class="req">*</span></label></div>' +
            selectHTML('bi-type-' + i, state.enums.goods_type, it.type || '', '请选择类型') + '</div>' +
          '<div class="field"><div class="field-head"><span class="field-label">角色（多选）</span></div>' +
            '<div class="chip-select">' + (charChips || '<span class="hint">暂无角色</span>') + '</div></div>' +
          '<div class="bs-grid">' +
            '<label class="bs-cell"><span>数量</span><input class="input input--mini" data-n="qty" data-i="' + i + '" type="number" min="1" step="1" value="' + (num(it.qty) || 1) + '"></label>' +
            '<label class="bs-cell"><span>状态</span><select class="input input--mini" data-n="status" data-i="' + i + '">' + statusOpts + '</select></label>' +
            '<label class="bs-cell"><span>渠道</span>' + selectHTML('bi-ch-' + i, state.enums.channel, it.channel || '', '不填') + '</label>' +
            '<label class="bs-cell"><span>原袋</span>' + selectHTML('bi-bag-' + i, ['有原袋', '无原袋'], (it.bag === true ? '有原袋' : (it.bag === false ? '无原袋' : '')), '未标记') + '</label>' +
            '<label class="bs-cell"><span>单价（可空）</span><input class="input input--mini" data-n="unit" data-i="' + i + '" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00" value="' + esc(it.unitPrice != null ? (it.unitPrice / 100).toFixed(2) : '') + '"></label>' +
          '</div>' +
          (it.ocrText ? '<p class="hint">OCR：' + esc(it.ocrText.slice(0, 80)) + '</p>' : '') +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function render() {
    var container = dom.container;
    var html = state.items.map(itemHTML).join('');
    container.innerHTML =
      '<section class="page page--batch">' +
        '<div class="form-section">' +
          '<h2 class="section-title">拍照批量录入（' + state.items.length + ' 条）</h2>' +
          '<p class="hint">已按照片区域拆分，OCR 自动预填；请核对/补齐必填项后一键保存。</p>' +
        '</div>' +
        html +
        '<div class="save-spacer" aria-hidden="true"></div>' +
        '<div class="save-bar">' +
          '<button type="button" class="btn btn--secondary" data-act="cancel">取消</button>' +
          '<button type="button" class="btn btn--primary" data-act="save-all">全部保存（' + state.items.length + '）</button>' +
        '</div>' +
      '</section>';
    cacheDom();
    bind();
  }

  function cacheDom() {
    dom.page = dom.container.querySelector('.page--batch');
  }

  function bind() {
    on(dom.page, 'click', function (e) {
      var d = e.target.closest('[data-del]');
      if (d) { removeItem(Number(d.dataset.del)); return; }
      var ch = e.target.closest('[data-char]');
      if (ch) {
        var i = Number(ch.closest('.bs-item').dataset.i);
        var cid = Number(ch.dataset.char);
        var arr = state.items[i].charIds;
        var k = arr.indexOf(cid);
        if (k === -1) arr.push(cid); else arr.splice(k, 1);
        ch.classList.toggle('is-on');
        return;
      }
      var act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.dataset.act === 'cancel') leave();
      else if (act.dataset.act === 'save-all') doSaveAll();
    });
    on(dom.page, 'input', syncItem);
    on(dom.page, 'change', syncItem);
  }

  function removeItem(i) {
    state.items.splice(i, 1);
    saveDraft(state.items);
    if (!state.items.length) { UI.toast('已删除全部，返回录入', 'info'); leave(); return; }
    render();
  }

  function syncItem(e) {
    var el = e.target;
    var row = el.closest('.bs-item');
    if (!row) return;
    var i = Number(row.dataset.i);
    var it = state.items[i];
    if (!it) return;
    if (el.id === 'bi-name-' + i) it.name = el.value;
    else if (el.id === 'bi-ip-' + i) it.ip = el.value;
    else if (el.id === 'bi-type-' + i) it.type = el.value;
    else if (el.id === 'bi-ch-' + i) it.channel = el.value;
    else if (el.id === 'bi-bag-' + i) {
      it.bag = el.value === '有原袋' ? true : (el.value === '无原袋' ? false : null);
    }
    else if (el.dataset.n === 'qty') it.qty = Math.max(1, Math.floor(Number(el.value) || 1));
    else if (el.dataset.n === 'status') it.status = el.value;
    else if (el.dataset.n === 'unit') {
      var c = yuanToCents(el.value);
      it.unitPrice = (c == null || isNaN(c)) ? null : c;
    }
  }

  // ---- 保存 ----

  function saveOne(it, i) {
    var goodsRec = {
      name: it.name.trim(),
      ip: it.ip,
      goods_type: it.type,
      character_ids: (it.charIds || []).slice(),
      tags: [],
      note: ''
    };
    if (it.image) goodsRec.images = [it.image];
    return S.add('goods', goodsRec).then(function (gid) {
      gid = Number(gid);
      var purchaseRec = {
        goods_id: gid,
        buy_date: U.todayStr(),
        quantity: num(it.qty) || 1,
        unit_price: it.unitPrice != null ? it.unitPrice : null,
        currency: it.currency || (EATG.runtime && EATG.runtime.defaultCurrency) || 'CNY',
        shipping_share: 0,
        channel: it.channel || '',
        status: it.status || 'on_hand',
        price_status: (it.unitPrice == null) ? 'unknown' : 'filled',
        note: ''
      };
      if (it.bag != null) purchaseRec.has_bag = it.bag;
      return S.add('purchase_items', purchaseRec).then(function (pid) {
        purchaseRec.id = pid;
        return Promise.all([
          S.query('purchase_items', 'goods_id', gid),
          S.query('sale_items', 'goods_id', gid)
        ]).then(function (r) {
          goodsRec.id = gid;
          goodsRec.agg = A.computeGoodsAgg(goodsRec, r[0] || [], r[1] || []);
          return S.put('goods', goodsRec);
        });
      });
    });
  }

  function doSaveAll() {
    var items = state.items;
    if (!items.length) { UI.toast('没有可保存的条目', 'error'); return; }
    // 校验必填
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!String(it.name || '').trim()) { UI.toast('第 ' + (i + 1) + ' 条未填名称', 'error'); return; }
      if (!it.ip) { UI.toast('第 ' + (i + 1) + ' 条未选 IP', 'error'); return; }
      if (!it.type) { UI.toast('第 ' + (i + 1) + ' 条未选类型', 'error'); return; }
    }
    setBusy(true);
    var ok = 0, failed = [];
    var chain = Promise.resolve();
    items.forEach(function (it, i) {
      chain = chain.then(function () {
        return saveOne(it, i).then(function () { ok++; }).catch(function (err) {
          console.error('[EATG] 批量保存第 ' + (i + 1) + ' 条失败', err);
          failed.push(i + 1);
        });
      });
    });
    chain.then(function () {
      setBusy(false);
      if (failed.length) {
        UI.toast('成功 ' + ok + ' 条，失败 ' + failed.length + ' 条（第 ' + failed.join('、') + ' 条）', 'error');
        state.items = items.filter(function (_, idx) { return failed.indexOf(idx + 1) === -1; });
        saveDraft(state.items);
        render();
        return;
      }
      clearDraft();
      UI.toast('已录入 ' + ok + ' 个谷子', 'success');
      leave();
    });
  }

  function setBusy(b) {
    var btn = dom.container && dom.container.querySelector('[data-act="save-all"]');
    if (btn) { btn.disabled = b; btn.textContent = b ? '保存中…' : '全部保存'; }
  }

  function leave() {
    if (global.history.length > 1) global.history.back();
    else global.location.hash = '#/library';
  }

  // ---- 挂载 / 卸载 ----

  function mount(container, ctx) {
    state = {
      destroyed: false,
      items: loadDraft() || [],
      characters: [],
      enums: { ip: [], goods_type: [], channel: [] }
    };
    dom = { container: container, ctx: ctx };
    ctx.setTitle('拍照批量录入');
    ctx.setBack(true);

    if (!state.items.length) {
      container.innerHTML = '<div class="empty"><p class="empty-title">没有待录入的草稿</p>' +
        '<p class="hint">请先在「新增谷子」页点「拍照批量录入」，框选照片中的谷子。</p>' +
        '<button type="button" class="btn btn--secondary" data-act="back">返回</button></div>';
      var b = container.querySelector('[data-act="back"]');
      if (b) on(b, 'click', function () { global.location.hash = '#/goods/edit?mode=add'; });
      return;
    }

    container.innerHTML = '<div class="skeleton skeleton-bar" style="width:45%;height:22px;margin-bottom:12px"></div>' +
      '<div class="skeleton skeleton-card" style="height:120px;margin-bottom:12px"></div>';
    return Promise.all([S.getAll('characters'), S.getAll('enums')]).then(function (r) {
      if (state.destroyed) return;
      state.characters = r[0] || [];
      var map = {};
      (r[1] || []).forEach(function (row) { map[row.key] = row.values || []; });
      state.enums = { ip: map.ip || [], goods_type: map.goods_type || [], channel: map.channel || [] };
      render();
    }).catch(function (err) {
      console.error('[EATG] 批量页加载失败', err);
      UI.toast('加载失败：' + (err && err.message || err), 'error');
    });
  }

  function unmount() {
    if (state) state.destroyed = true;
    clearOffs();
    state = null;
    dom = {};
  }

  EATG.pages['goods/batch'] = { key: 'goods/batch', mount: mount, unmount: unmount };

})(window);
