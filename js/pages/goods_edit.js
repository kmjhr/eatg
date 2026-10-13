/* ==========================================================================
   一咕（EATG）· 新增/编辑谷子页 + 购入记录（js/pages/goods_edit.js）
   实现：《详细开发指南》第3步 +《页面线框与UI规范》P04/P05
   路由：#/goods/edit?mode=add|edit&id=<goods_id>&pid=<purchase_id>&from=news|order
   内容：1 谷子款表单（名称/IP下拉+新增/角色多选+新增/类型下拉+新增/图片九宫格/市场参考价/标签/备注）
        2 购入记录表单（日期/数量/本体单价(可空)/币种/邮费分摊/渠道/状态/价格状态/备注）
        3 定尾预售扩展区（定金/尾款/补款截止/到期提醒开关 + 一键转全款预售）
        4 快捷词面板（localStorage: eatg_quick_words，各字段旁一键填入）
        5 连续录入开关（开启后保存不清空表单）
        6 from=news|order 预填
        7 保存：校验必填 → 更新 goods.agg → 跳转详情（无详情页则列表）
        8 edit 模式复用同一页面
   口径：金额「分」整数存储（元输入严格换算，无浮点误差 D-05）；价格状态自动判定
        （填单价=filled / 留空=unknown / 手动标记=estimated，见《业务规则》§6）；
        状态机 deposit_pre→full_pre→shipping→on_hand→sold_out（《数据字典》§4）。
   数据：一律走 EATG.storage；图片经 utils.compressImage 压缩为 base64 存 IndexedDB（剥离 EXIF）。
   ========================================================================== */
(function (global) {
  'use strict';

  var EATG = (global.EATG = global.EATG || {});
  var S = EATG.storage;
  var A = EATG.agg;
  var U = EATG.utils;
  var UI = EATG.ui;

  EATG.pages = EATG.pages || {};

  var MAX_IMAGES = 9;
  var CURRENCIES = ['CNY', 'JPY', '其他'];
  var QUICK_KEY = 'eatg_quick_words';

  // 内置默认快捷词（自定义项从 localStorage 合并，见《数据字典》§3）
  var DEFAULT_QUICK_WORDS = {
    name: ['长崎素世', '吧唧'],
    channel: ['淘宝', '闲鱼', '日拍', '煤炉'],
    ip: [], goods_type: [], tags: [], note: [], pnote: [], unit_price: [], shipping_share: []
  };

  var FIELD_LABELS = {
    name: '名称', ip: 'IP', goods_type: '类型', tags: '标签', note: '备注',
    pnote: '购入备注', channel: '渠道', unit_price: '本体单价', shipping_share: '邮费分摊'
  };
  // 快捷词字段 → 目标输入框 id（tags 走 chip 追加，单独处理）
  var QW_TARGET = {
    name: 'g-name', ip: 'g-ip', goods_type: 'g-type', note: 'g-note',
    pnote: 'p-note', channel: 'p-channel', unit_price: 'p-unit-price', shipping_share: 'p-ship'
  };

  var state = null;
  var dom = {};
  var offs = [];

  function on(el, ev, fn, opt) { if (!el) return; el.addEventListener(ev, fn, opt); offs.push([el, ev, fn, opt]); }
  function clearOffs() { offs.forEach(function (t) { t[0].removeEventListener(t[1], t[2], t[3]); }); offs = []; }
  function clone(o) { var r = {}; for (var k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = o[k]; } return r; }

  /** 标记「可预期的用户级错误」（如 id 不存在）：仍以 UI 提示暴露，但不产生 console.error。 */
  function expectedError(msg) { var e = new Error(msg); e.expected = true; return e; }

  function resetState() {
    state = {
      destroyed: false,
      mode: 'add',
      from: null,
      addPurchase: false,
      busy: false,
      goodsId: null,
      purchaseId: null,
      orderId: null,
      continuous: false,
      priceManual: false,
      currency: 'CNY',
      status: 'on_hand',
      enums: { ip: [], goods_type: [], channel: [] },
      characters: [],
      characterIds: [],
      images: [],
      tags: [],
      quickWords: {},
      customQuickWords: {},
      goods: {},
      purchase: {}
    };
  }

  // ---- 金额：元（字符串）<-> 分（整数），严格无浮点误差（D-05） ----
  function yuanToCents(s) {
    s = String(s == null ? '' : s).trim();
    if (!s) return null;
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN; // 非法：超过两位小数/非数字
    return Math.round(Number(s) * 100);
  }
  function centsToYuan(cents) {
    if (cents == null || !isFinite(Number(cents))) return '';
    var fixed = (Number(cents) / 100).toFixed(2);
    return fixed.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  }
  function unitText(currency) {
    if (currency === 'JPY') return '日元';
    if (currency === '其他') return '原币·元';
    return '元';
  }

  // ---- 快捷词 ----
  function normQuickWords(raw) {
    var map = {};
    function push(field, words) {
      if (!field || !Array.isArray(words)) return;
      var list = words.map(function (w) { return w == null ? '' : String(w).trim(); })
        .filter(function (w) { return w; });
      if (list.length) map[field] = (map[field] || []).concat(list);
    }
    if (Array.isArray(raw)) raw.forEach(function (it) { if (it) push(it.field, it.words); });
    else if (raw && typeof raw === 'object') Object.keys(raw).forEach(function (k) { push(k, raw[k]); });
    return map;
  }
  function loadQuickWords() {
    var merged = normQuickWords(DEFAULT_QUICK_WORDS);
    var stored = null;
    try { var s = global.localStorage.getItem(QUICK_KEY); if (s) stored = JSON.parse(s); } catch (e) { stored = null; }
    var custom = normQuickWords(stored);
    Object.keys(custom).forEach(function (k) {
      var base = merged[k] || [];
      custom[k].forEach(function (w) { if (base.indexOf(w) === -1) base.push(w); });
      merged[k] = base;
    });
    return merged;
  }
  function loadCustomQuickWords() {
    var stored = null;
    try { var s = global.localStorage.getItem(QUICK_KEY); if (s) stored = JSON.parse(s); } catch (e) { stored = null; }
    return normQuickWords(stored);
  }
  function saveCustomQuickWords() {
    try { global.localStorage.setItem(QUICK_KEY, JSON.stringify(state.customQuickWords)); } catch (e) {}
  }
  function isCustomWord(field, word) {
    var arr = state.customQuickWords[field] || [];
    return arr.indexOf(word) !== -1;
  }
  function addQuickWord(field, word) {
    word = String(word || '').trim();
    if (!word) return false;
    var custom = state.customQuickWords[field] || (state.customQuickWords[field] = []);
    if (custom.indexOf(word) !== -1) return false;
    custom.push(word);
    var merged = state.quickWords[field] || (state.quickWords[field] = []);
    if (merged.indexOf(word) === -1) merged.push(word);
    saveCustomQuickWords();
    return true;
  }
  function delQuickWord(field, word) {
    var custom = state.customQuickWords[field] || [];
    var ci = custom.indexOf(word);
    if (ci !== -1) custom.splice(ci, 1);
    var merged = state.quickWords[field] || [];
    var mi = merged.indexOf(word);
    if (mi !== -1) merged.splice(mi, 1);
    saveCustomQuickWords();
  }
  function qwBtn(field) {
    return '<button type="button" class="qw-btn" data-qw="' + field + '" title="快捷词（可添加/删除）">快捷词</button>';
  }

  // ---- 文本输入弹窗（复用 ui.sheet） ----
  function askText(opts) {
    return new Promise(function (resolve) {
      var ref = UI.sheet({
        title: opts.title,
        bodyHTML: '<input class="input" id="ask-input" autocomplete="off" placeholder="' + UI.esc(opts.placeholder || '') + '" value="' + UI.esc(opts.initial || '') + '">' +
          (opts.hint ? '<p class="hint">' + UI.esc(opts.hint) + '</p>' : ''),
        footerHTML: '<button type="button" class="btn btn--secondary" data-act="cancel">取消</button>' +
          '<button type="button" class="btn btn--primary" data-act="ok">确定</button>'
      });
      var input = ref.body.querySelector('#ask-input');
      function done(v) { ref.close(); resolve(v); }
      if (input) {
        setTimeout(function () { input.focus(); }, 0);
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); done(input.value.trim() || null); }
        });
      }
      if (ref.foot) ref.foot.addEventListener('click', function (e) {
        var b = e.target.closest('[data-act]');
        if (!b) return;
        done(b.dataset.act === 'ok' ? (input && input.value.trim() || null) : null);
      });
    });
  }

  // ---- 表单骨架 ----

  function selectHTML(id, values, value, placeholder, labels) {
    var opts = '<option value=""' + (value ? '' : ' selected') + ' disabled>' + UI.esc(placeholder || '请选择') + '</option>';
    values.forEach(function (v) {
      var label = (labels && labels[v]) || v;
      opts += '<option value="' + UI.esc(v) + '"' + (v === value ? ' selected' : '') + '>' + UI.esc(label) + '</option>';
    });
    if (value && values.indexOf(value) === -1) {
      var label2 = (labels && labels[value]) || value;
      opts += '<option value="' + UI.esc(value) + '" selected>' + UI.esc(label2) + '</option>';
    }
    return '<select id="' + id + '" class="input">' + opts + '</select>';
  }

  function moneyHTML(id, unit) {
    return '<div class="money-input"><input id="' + id + '" class="input" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00">' +
      '<span class="unit" data-unit="' + id + '">' + UI.esc(unit) + '</span></div>';
  }

  function fieldHTML(o) {
    return '<div class="field">' +
      '<div class="field-head"><label class="field-label" for="' + o.id + '">' + UI.esc(o.label) +
        (o.req ? ' <span class="req">*</span>' : '') + '</label>' + (o.qw ? qwBtn(o.qw) : '') + '</div>' +
      o.control +
      (o.hint ? '<p class="hint">' + o.hint + '</p>' : '') +
      '<p class="field-error" data-for="' + o.id + '"></p>' +
    '</div>';
  }

  function sectionHTML() {
    var enums = state.enums;
    var unit = unitText(state.currency);

    var prefillNote = state.from
      ? '<p class="prefill-note">已按' + UI.esc(state.from === 'order' ? '订单' : '资讯') + '预填，可修改后保存。</p>'
      : '';

    return '<section class="page page--edit">' +
      prefillNote +

      '<div class="form-section">' +
        '<h2 class="section-title">谷子款</h2>' +

        fieldHTML({ id: 'g-name', label: '名称', req: true, qw: 'name',
          control: '<input id="g-name" class="input" type="text" autocomplete="off" placeholder="如：长崎素世 1st 吧唧">' }) +

        fieldHTML({ id: 'g-ip', label: 'IP', req: true, qw: 'ip',
          control: '<div class="input-row">' + selectHTML('g-ip', enums.ip, state.goods.ip, '请选择 IP') +
            '<button type="button" class="add-btn" data-add="ip">＋ 新增</button></div>' }) +

        fieldHTML({ id: 'g-chars', label: '角色（多选）',
          control: '<div class="chip-select" id="g-chars"></div>' +
            '<button type="button" class="add-btn add-btn--block" data-add="char">＋ 新增角色</button>' }) +

        fieldHTML({ id: 'g-type', label: '类型', req: true, qw: 'goods_type',
          control: '<div class="input-row">' + selectHTML('g-type', enums.goods_type, state.goods.goods_type, '请选择类型') +
            '<button type="button" class="add-btn" data-add="goods_type">＋ 新增</button></div>' }) +

        '<div class="field">' +
          '<div class="field-head"><span class="field-label">图片九宫格</span><span class="field-count" id="g-img-count"></span></div>' +
          '<div class="grid9" id="g-images"></div>' +
          '<p class="hint">拍照或从相册选择，最多 ' + MAX_IMAGES + ' 张；压缩后存本机（剥离 EXIF），不上传。</p>' +
        '</div>' +

        fieldHTML({ id: 'g-mprice', label: '市场参考价', qw: null,
          control: moneyHTML('g-mprice', '元'),
          hint: '最近市场挂价/成交参考，可留空。' }) +

        '<div class="field">' +
          '<div class="field-head"><span class="field-label">标签</span>' + qwBtn('tags') + '</div>' +
          '<div class="tags-wrap" id="g-tags"></div>' +
          '<div class="input-row"><input id="g-tag-input" class="input" type="text" autocomplete="off" placeholder="输入标签后回车/点添加">' +
            '<button type="button" class="add-btn" data-act="tag-add">添加</button></div>' +
        '</div>' +

        fieldHTML({ id: 'g-note', label: '备注', qw: 'note',
          control: '<textarea id="g-note" class="textarea" placeholder="自由备注（如购入心情、品相说明）"></textarea>' }) +

      '</div>' +

      '<div class="form-section">' +
        '<h2 class="section-title">购入记录</h2>' +

        fieldHTML({ id: 'p-date', label: '购入日期',
          control: '<input id="p-date" class="input" type="date">' }) +

        fieldHTML({ id: 'p-qty', label: '数量', req: true,
          control: '<input id="p-qty" class="input" type="number" min="1" step="1" inputmode="numeric" placeholder="1">' }) +

        fieldHTML({ id: 'p-unit-price', label: '本体单价（可空）', qw: 'unit_price',
          control: moneyHTML('p-unit-price', unit),
          hint: '留空则价格状态自动为「未知」，成本未知暂不计盈利。' }) +

        fieldHTML({ id: 'p-currency', label: '币种',
          control: selectHTML('p-currency', CURRENCIES, state.currency, '请选择币种') }) +

        fieldHTML({ id: 'p-ship', label: '邮费分摊', qw: 'shipping_share',
          control: moneyHTML('p-ship', unit),
          hint: state.from === 'order'
            ? '从订单进入：邮费分摊只读（如需调整请回订单页统一分摊）。'
            : '本件承担的邮费份额；未分摊填 0。整单分摊模式在订单页统一设置。' }) +

        fieldHTML({ id: 'p-channel', label: '渠道', qw: 'channel',
          control: '<div class="input-row">' + selectHTML('p-channel', enums.channel, state.purchase.channel, '请选择渠道') +
            '<button type="button" class="add-btn" data-add="channel">＋ 新增</button></div>' }) +

        fieldHTML({ id: 'p-status', label: '状态', req: true,
          control: selectHTML('p-status', A.STATUS_ORDER, state.status, '请选择状态', A.STATUS_LABELS) }) +

        '<div class="field">' +
          '<div class="field-head"><span class="field-label">价格状态</span></div>' +
          '<div class="price-status-row">' +
            '<span class="ps-now" id="p-ps-now">未知</span>' +
            '<label class="switch"><input type="checkbox" id="p-ps-manual"><span class="switch-track"></span>' +
              '<span class="switch-label">手动标记为估算</span></label>' +
          '</div>' +
          '<p class="hint" id="p-ps-hint"></p>' +
        '</div>' +

        fieldHTML({ id: 'p-note', label: '购入备注', qw: 'pnote',
          control: '<textarea id="p-note" class="textarea" placeholder="如：合单分摊、补款说明"></textarea>' }) +

        '<div class="ext-area" id="p-ext" hidden>' +
          '<p class="section-sub">定尾预售</p>' +
          fieldHTML({ id: 'p-deposit', label: '定金',
            control: moneyHTML('p-deposit', unit) }) +
          fieldHTML({ id: 'p-balance', label: '尾款',
            control: moneyHTML('p-balance', unit) }) +
          fieldHTML({ id: 'p-deadline', label: '补款截止',
            control: '<input id="p-deadline" class="input" type="date">',
            hint: '为空则不做补款提醒。' }) +
          '<label class="switch switch--row"><input type="checkbox" id="p-remind"><span class="switch-track"></span>' +
            '<span class="switch-label">到期提醒</span></label>' +
          '<button type="button" class="btn btn--secondary conv-btn" data-act="convert">一键转全款预售</button>' +
        '</div>' +

      '</div>' +

      '<div class="save-spacer" aria-hidden="true"></div>' +
      '<div class="save-bar">' +
        '<label class="switch" id="opt-continuous-wrap"><input type="checkbox" id="opt-continuous"><span class="switch-track"></span>' +
          '<span class="switch-label">连续录入</span></label>' +
        '<button type="button" class="btn btn--secondary" data-act="cancel">取消</button>' +
        '<button type="button" class="btn btn--primary" data-act="save">保存</button>' +
      '</div>' +

      '<input type="file" id="f-camera" accept="image/*" capture="environment" hidden>' +
      '<input type="file" id="f-album" accept="image/*" multiple hidden>' +

    '</section>';
  }

  function skeletonHTML() {
    return '<div class="skeleton skeleton-bar" style="width:40%;height:22px;margin-bottom:12px"></div>' +
      '<div class="skeleton skeleton-bar" style="width:100%;height:180px;margin-bottom:12px"></div>' +
      '<div class="skeleton skeleton-bar" style="width:100%;height:240px"></div>';
  }

  function cacheDom() {
    var c = dom.container;
    dom.page = c.querySelector('.page--edit');
    dom.name = c.querySelector('#g-name');
    dom.ip = c.querySelector('#g-ip');
    dom.chars = c.querySelector('#g-chars');
    dom.type = c.querySelector('#g-type');
    dom.images = c.querySelector('#g-images');
    dom.imgCount = c.querySelector('#g-img-count');
    dom.mprice = c.querySelector('#g-mprice');
    dom.tags = c.querySelector('#g-tags');
    dom.tagInput = c.querySelector('#g-tag-input');
    dom.note = c.querySelector('#g-note');

    dom.date = c.querySelector('#p-date');
    dom.qty = c.querySelector('#p-qty');
    dom.unitPrice = c.querySelector('#p-unit-price');
    dom.currency = c.querySelector('#p-currency');
    dom.ship = c.querySelector('#p-ship');
    dom.channel = c.querySelector('#p-channel');
    dom.status = c.querySelector('#p-status');
    dom.psNow = c.querySelector('#p-ps-now');
    dom.psManual = c.querySelector('#p-ps-manual');
    dom.psHint = c.querySelector('#p-ps-hint');
    dom.pnote = c.querySelector('#p-note');
    dom.ext = c.querySelector('#p-ext');
    dom.deposit = c.querySelector('#p-deposit');
    dom.balance = c.querySelector('#p-balance');
    dom.deadline = c.querySelector('#p-deadline');
    dom.remind = c.querySelector('#p-remind');

    dom.continuous = c.querySelector('#opt-continuous');
    dom.continuousWrap = c.querySelector('#opt-continuous-wrap');
    dom.saveBtn = c.querySelector('[data-act="save"]');
    dom.camera = c.querySelector('#f-camera');
    dom.album = c.querySelector('#f-album');
  }

  // ---- 局部渲染 ----

  function renderChars() {
    var on = state.characterIds;
    var html = state.characters.map(function (c) {
      var sel = on.indexOf(Number(c.id)) !== -1;
      return '<button type="button" class="opt-chip' + (c.is_favorite ? ' is-fav' : '') + (sel ? ' is-on' : '') + '" data-char="' + c.id + '">' + UI.esc(c.name) + '</button>';
    }).join('');
    dom.chars.innerHTML = html || '<span class="hint">暂无角色，点下方「＋ 新增角色」添加</span>';
  }

  function renderImages() {
    var html = state.images.map(function (src, i) {
      return '<div class="grid9-cell"><img src="' + src + '" alt="">' +
        '<button type="button" class="cell-del" data-del="' + i + '" aria-label="移除图片">×</button></div>';
    }).join('');
    if (state.images.length < MAX_IMAGES) {
      html += '<button type="button" class="grid9-add" id="g-img-add" aria-label="添加图片">＋<span>添加图片</span></button>';
    }
    dom.images.innerHTML = html;
    if (dom.imgCount) dom.imgCount.textContent = state.images.length + ' / ' + MAX_IMAGES;
  }

  function renderTags() {
    dom.tags.innerHTML = state.tags.length
      ? state.tags.map(function (t, i) {
        return '<span class="tag-chip">' + UI.esc(t) + '<button type="button" data-tag-del="' + i + '" aria-label="移除标签">×</button></span>';
      }).join('')
      : '<span class="hint">暂无标签</span>';
  }

  function updateMoneyUnits() {
    var t = unitText(state.currency);
    ['p-unit-price', 'p-ship', 'p-deposit', 'p-balance'].forEach(function (id) {
      var el = dom.container.querySelector('[data-unit="' + id + '"]');
      if (el) el.textContent = t;
    });
  }

  function toggleExt() {
    if (!dom.ext) return;
    dom.ext.hidden = state.status !== 'deposit_pre';
  }

  function currentPriceStatus() {
    if (state.priceManual) return 'estimated';
    var c = yuanToCents(dom.unitPrice.value);
    if (c == null || isNaN(c)) return 'unknown';
    return 'filled';
  }

  function updatePriceStatusUI() {
    var ps = currentPriceStatus();
    dom.psNow.textContent = A.PRICE_LABELS[ps] || ps;
    dom.psNow.className = 'ps-now is-' + ps;
    if (state.priceManual) dom.psHint.textContent = '手动标记为估算：单独统计为估算盈利，不混入已实现盈利。';
    else if (ps === 'filled') dom.psHint.textContent = '录入时已填写单价，自动判定为「已填写」。';
    else dom.psHint.textContent = '单价留空，成本未知，暂不计盈利。';
  }

  function applyState() {
    var g = state.goods || {};
    var p = state.purchase || {};

    dom.name.value = g.name || '';
    if (dom.ip) dom.ip.value = g.ip || '';
    if (dom.type) dom.type.value = g.goods_type || '';
    state.characterIds = (g.character_ids || []).map(Number);
    state.images = (g.images || []).slice();
    state.tags = (g.tags || []).slice();
    dom.mprice.value = centsToYuan(g.market_price);
    dom.note.value = g.note || '';
    renderChars();
    renderImages();
    renderTags();

    dom.date.value = p.buy_date || U.todayStr();
    dom.qty.value = String(p.quantity != null ? p.quantity : 1);
    dom.unitPrice.value = centsToYuan(p.unit_price);
    state.currency = p.currency || (EATG.runtime && EATG.runtime.defaultCurrency) || 'CNY';
    if (dom.currency) dom.currency.value = state.currency;
    dom.ship.value = centsToYuan(p.shipping_share);
    if (state.from === 'order' && dom.ship) {
      dom.ship.readOnly = true;
      dom.ship.classList.add('is-readonly');
      var qwShip = dom.ship.parentNode && dom.ship.parentNode.parentNode
        ? dom.ship.parentNode.parentNode.querySelector('[data-qw="shipping_share"]') : null;
      if (qwShip) qwShip.disabled = true;
    }
    if (dom.channel) dom.channel.value = p.channel || '';
    state.status = p.status || (state.from === 'news' ? 'deposit_pre' : 'on_hand');
    if (dom.status) dom.status.value = state.status;
    state.priceManual = (p.price_status === 'estimated');
    dom.psManual.checked = state.priceManual;
    dom.pnote.value = p.note || '';

    dom.deposit.value = centsToYuan(p.deposit);
    dom.balance.value = centsToYuan(p.balance);
    dom.deadline.value = p.payment_deadline || '';
    dom.remind.checked = (p.remind_enabled === false) ? false : true;

    dom.continuous.checked = state.continuous;
    if (state.mode === 'edit') dom.continuousWrap.hidden = true; // 编辑模式不支持连录

    updateMoneyUnits();
    toggleExt();
    updatePriceStatusUI();
  }

  // ---- 事件绑定 ----

  function bindEvents() {
    // 图片九宫格
    on(dom.images, 'click', function (e) {
      var del = e.target.closest('[data-del]');
      if (del) { state.images.splice(Number(del.dataset.del), 1); renderImages(); return; }
      if (e.target.closest('#g-img-add')) openAddImageSheet();
    });
    on(dom.camera, 'change', function () { handleFiles(dom.camera.files, dom.camera); });
    on(dom.album, 'change', function () { handleFiles(dom.album.files, dom.album); });

    // 角色多选
    on(dom.chars, 'click', function (e) {
      var b = e.target.closest('[data-char]');
      if (!b) return;
      var id = Number(b.dataset.char);
      var i = state.characterIds.indexOf(id);
      if (i === -1) state.characterIds.push(id); else state.characterIds.splice(i, 1);
      renderChars();
    });

    // 页面级委托：新增选项 / 标签 / 快捷词 / 底部操作
    on(dom.page, 'click', function (e) {
      var add = e.target.closest('[data-add]');
      if (add) { onAdd(add.dataset.add); return; }

      if (e.target.closest('[data-act="tag-add"]')) { commitTagInput(); return; }
      var td = e.target.closest('[data-tag-del]');
      if (td) { state.tags.splice(Number(td.dataset.tagDel), 1); renderTags(); return; }

      var qw = e.target.closest('[data-qw]');
      if (qw) { openQuickSheet(qw.dataset.qw); return; }

      var act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.dataset.act === 'convert') convertToFullPre();
      else if (act.dataset.act === 'save') doSave();
      else if (act.dataset.act === 'cancel') leave();
    });

    // 标签输入回车
    on(dom.tagInput, 'keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); commitTagInput(); } });

    // 金额 → 价格状态联动
    on(dom.unitPrice, 'input', updatePriceStatusUI);
    on(dom.psManual, 'change', function () { state.priceManual = dom.psManual.checked; updatePriceStatusUI(); });

    // 币种 → 金额单位
    on(dom.currency, 'change', function () { state.currency = dom.currency.value; updateMoneyUnits(); });

    // 状态 → 定尾扩展区
    on(dom.status, 'change', function () { state.status = dom.status.value; toggleExt(); });

    // 连续录入
    on(dom.continuous, 'change', function () { state.continuous = dom.continuous.checked; });
  }

  function openAddImageSheet() {
    var ref = UI.sheet({
      title: '添加图片',
      bodyHTML: '<div class="opt-list">' +
        '<button type="button" class="opt-row" data-src="camera"><span>拍照</span><span class="opt-check">›</span></button>' +
        '<button type="button" class="opt-row" data-src="album"><span>从相册选择</span><span class="opt-check">›</span></button>' +
        '</div>'
    });
    ref.body.addEventListener('click', function (e) {
      var b = e.target.closest('[data-src]');
      if (!b) return;
      ref.close();
      if (b.dataset.src === 'camera') dom.camera.click();
      else dom.album.click();
    });
  }

  function handleFiles(fileList, inputEl) {
    var files = Array.prototype.slice.call(fileList || []);
    if (inputEl) inputEl.value = '';
    if (!files.length) return;
    var slots = MAX_IMAGES - state.images.length;
    if (slots <= 0) { UI.toast('最多 ' + MAX_IMAGES + ' 张图片', 'error'); return; }
    var take = files.slice(0, slots);
    if (files.length > slots) UI.toast('仅添加前 ' + slots + ' 张（上限 ' + MAX_IMAGES + '）', 'error');
    var quality = (EATG.runtime && EATG.runtime.imageQuality) || 0.8;
    UI.toast('正在压缩图片…');
    var chain = Promise.resolve();
    take.forEach(function (file) {
      chain = chain.then(function () {
        return U.compressImage(file, { maxEdge: 1920, quality: quality, stripExif: true }).then(function (dataUrl) {
          if (state.destroyed) return;
          state.images.push(dataUrl);
          renderImages();
        });
      });
    });
    chain.then(function () {
      if (state.destroyed) return;
      UI.toast('已添加图片', 'success');
    }).catch(function (err) {
      console.error('[EATG] 图片压缩失败', err);
      UI.toast('图片处理失败：' + (err && err.message || err), 'error');
    });
  }

  // ---- 新增 IP/类型/渠道/角色 ----

  function onAdd(kind) {
    if (kind === 'char') {
      var ip = (dom.ip && dom.ip.value) || '其他';
      askText({ title: '新增角色', placeholder: '角色名', hint: '将归入当前 IP：' + ip }).then(function (name) {
        if (!name) return;
        S.add('characters', { name: name, ip: ip, is_favorite: false }).then(function (id) {
          state.characters.push({ id: Number(id), name: name, ip: ip, is_favorite: false });
          state.characterIds.push(Number(id));
          renderChars();
          UI.toast('已新增角色：' + name, 'success');
        }).catch(function (err) { console.error('[EATG] 新增角色失败', err); UI.toast('新增失败：' + (err && err.message || err), 'error'); });
      });
      return;
    }
    var title = (kind === 'ip') ? '新增 IP' : (kind === 'goods_type' ? '新增类型' : '新增渠道');
    askText({ title: title, placeholder: '输入新选项' }).then(function (val) {
      if (!val) return;
      addEnumValue(kind, val).then(function () {
        var sel = (kind === 'ip') ? dom.ip : (kind === 'goods_type' ? dom.type : dom.channel);
        if (sel && sel.querySelector('option[value="' + val.replace(/"/g, '\\"') + '"]') == null) {
          var opt = document.createElement('option');
          opt.value = val; opt.textContent = val;
          sel.appendChild(opt);
        }
        if (sel) sel.value = val;
        UI.toast('已新增：' + val, 'success');
      }).catch(function (err) { console.error('[EATG] 新增选项失败', err); UI.toast('新增失败：' + (err && err.message || err), 'error'); });
    });
  }

  function addEnumValue(key, val) {
    var arr = (state.enums[key] || []).slice();
    if (arr.indexOf(val) === -1) arr.push(val);
    state.enums[key] = arr;
    return S.put('enums', { key: key, values: arr });
  }

  // ---- 快捷词填入 ----

  // 可叠加（追加）的文本型字段；下拉/金额字段点击即覆盖
  var STACK_FIELDS = ['name', 'note', 'pnote'];

  function openQuickSheet(field) {
    var words = state.quickWords[field] || [];
    var ref = UI.sheet({
      title: '快捷词 · ' + (FIELD_LABELS[field] || field),
      bodyHTML:
        '<div class="qw-add-row">' +
          '<input class="input qw-add-input" type="text" placeholder="输入新词后点添加" autocomplete="off">' +
          '<button type="button" class="btn btn--primary qw-add-btn">添加</button>' +
        '</div>' +
        '<div class="chip-select qw-chip-list">' + renderQwChips(field, words) + '</div>',
      footerHTML: '<button type="button" class="btn btn--primary qw-done">完成</button>'
    });

    var input = ref.body.querySelector('.qw-add-input');
    var chipList = ref.body.querySelector('.qw-chip-list');

    function repaint() {
      var w = state.quickWords[field] || [];
      chipList.innerHTML = renderQwChips(field, w);
    }

    function doAdd() {
      var v = input.value.trim();
      if (!v) return;
      if (addQuickWord(field, v)) {
        input.value = '';
        repaint();
      } else {
        UI.toast('该快捷词已存在', 'error');
      }
    }

    ref.body.addEventListener('click', function (e) {
      var del = e.target.closest('[data-qw-del]');
      if (del) {
        delQuickWord(field, del.dataset.qwDel);
        repaint();
        return;
      }
      var b = e.target.closest('[data-word]');
      if (b) {
        fillQuick(field, b.dataset.word);
        // 叠加型字段不关面板，便于连续点击；其他字段填入后关闭
        if (STACK_FIELDS.indexOf(field) === -1 && field !== 'tags') ref.close();
        return;
      }
      if (e.target.closest('.qw-add-btn')) { doAdd(); return; }
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); doAdd(); }
    });

    if (ref.foot) {
      ref.foot.addEventListener('click', function (e) {
        if (e.target.closest('.qw-done')) ref.close();
      });
    }
  }

  function renderQwChips(field, words) {
    if (!words.length) return '<span class="muted">暂无快捷词，可在上方添加</span>';
    return words.map(function (w) {
      var isCustom = isCustomWord(field, w);
      return '<span class="opt-chip qw-chip' + (isCustom ? ' is-custom' : '') + '" data-word="' + UI.esc(w) + '">' +
        UI.esc(w) +
        (isCustom ? '<button type="button" class="qw-chip-del" data-qw-del="' + UI.esc(w) + '" title="删除">×</button>' : '') +
        '</span>';
    }).join('');
  }

  function fillQuick(field, word) {
    if (field === 'tags') { addTag(word); return; }
    if (field === 'ip' || field === 'goods_type') {
      var arr = state.enums[field] || [];
      var ready = arr.indexOf(word) !== -1 ? Promise.resolve() : addEnumValue(field, word);
      ready.then(function () {
        var sel = (field === 'ip') ? dom.ip : dom.type;
        if (sel) {
          var ex = sel.querySelector('option[value="' + word.replace(/"/g, '\\"') + '"]');
          if (!ex) { var o = document.createElement('option'); o.value = word; o.textContent = word; sel.appendChild(o); }
          sel.value = word;
        }
      });
      return;
    }
    var id = QW_TARGET[field];
    var el = id ? document.getElementById(id) : null;
    if (!el) return;
    if (STACK_FIELDS.indexOf(field) !== -1) {
      // 叠加：已有内容则用空格衔接
      el.value = el.value ? el.value.trim() + ' ' + word : word;
    } else {
      el.value = word;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // ---- 标签 ----

  function commitTagInput() {
    var v = dom.tagInput.value.trim();
    if (!v) return;
    v.split(/[,，\s]+/).forEach(addTag);
    dom.tagInput.value = '';
  }
  function addTag(t) {
    t = String(t || '').trim();
    if (!t || state.tags.indexOf(t) !== -1) return;
    state.tags.push(t);
    renderTags();
  }

  // ---- 一键转全款预售（《业务规则》§7） ----

  function convertToFullPre() {
    var balance = yuanToCents(dom.balance.value);
    if (balance == null) { UI.toast('请先填写尾款金额', 'error'); dom.balance.focus(); return; }
    if (isNaN(balance)) { UI.toast('尾款金额格式不正确（最多两位小数）', 'error'); dom.balance.focus(); return; }
    UI.confirmDialog({
      title: '一键转全款预售',
      message: '将状态置为「全款预售」并关闭补款到期提醒，保留已录入的定金/尾款金额。确认？',
      confirmText: '转换'
    }).then(function (ok) {
      if (!ok) return;
      state.status = 'full_pre';
      dom.status.value = 'full_pre';
      dom.remind.checked = false;
      toggleExt();
      UI.toast('已转为全款预售（保存后生效）', 'success');
    });
  }

  // ---- 校验与保存 ----

  function clearErrors() {
    dom.container.querySelectorAll('.field-error').forEach(function (p) { p.textContent = ''; p.classList.remove('is-on'); });
    dom.container.querySelectorAll('.is-invalid').forEach(function (el) { el.classList.remove('is-invalid'); });
  }

  function markError(err) {
    var el = document.getElementById(err.id);
    var p = dom.container.querySelector('.field-error[data-for="' + err.id + '"]');
    if (p) { p.textContent = err.msg; p.classList.add('is-on'); }
    if (el) { el.classList.add('is-invalid'); try { el.scrollIntoView({ block: 'center' }); el.focus(); } catch (e) {} }
  }

  function collect() {
    var errors = [];
    var name = dom.name.value.trim();
    if (!name) errors.push({ id: 'g-name', msg: '请填写谷子名称' });

    var ip = dom.ip ? dom.ip.value : '';
    if (!ip) errors.push({ id: 'g-ip', msg: '请选择 IP' });

    var type = dom.type ? dom.type.value : '';
    if (!type) errors.push({ id: 'g-type', msg: '请选择类型' });

    var qty = Number(dom.qty.value);
    if (!isFinite(qty) || qty <= 0 || Math.floor(qty) !== qty) {
      errors.push({ id: 'p-qty', msg: '数量必须为大于 0 的整数' });
    }

    function moneyCheck(id, el, label) {
      var c = yuanToCents(el.value);
      if (c == null) return null;
      if (isNaN(c)) { errors.push({ id: id, msg: label + '格式不正确（最多两位小数）' }); return null; }
      return c;
    }

    var unitCents = moneyCheck('p-unit-price', dom.unitPrice, '本体单价');
    var shipCents = moneyCheck('p-ship', dom.ship, '邮费分摊');
    var mpriceCents = moneyCheck('g-mprice', dom.mprice, '市场参考价');
    var depositCents = moneyCheck('p-deposit', dom.deposit, '定金');
    var balanceCents = moneyCheck('p-balance', dom.balance, '尾款');

    return {
      errors: errors,
      goods: {
        name: name, ip: ip, goods_type: type,
        character_ids: state.characterIds.slice(),
        images: state.images.slice(),
        market_price: mpriceCents,
        tags: state.tags.slice(),
        note: dom.note.value.trim()
      },
      purchase: {
        buy_date: dom.date.value || U.todayStr(),
        quantity: qty,
        unit_price: unitCents,
        currency: state.currency,
        shipping_share: shipCents == null ? 0 : shipCents,
        channel: dom.channel ? dom.channel.value : '',
        status: state.status,
        price_status: currentPriceStatus(),
        deposit: depositCents,
        balance: balanceCents,
        payment_deadline: dom.deadline.value || '',
        remind_enabled: (state.status === 'deposit_pre') ? !!dom.remind.checked : null,
        note: dom.pnote.value.trim()
      }
    };
  }

  function buildGoodsRecord(v) {
    var rec = (state.mode === 'edit' && state.goods) ? clone(state.goods) : {};
    rec.name = v.goods.name;
    rec.ip = v.goods.ip;
    rec.goods_type = v.goods.goods_type;
    rec.character_ids = v.goods.character_ids;
    rec.tags = v.goods.tags;
    rec.note = v.goods.note;
    if (v.goods.images.length) rec.images = v.goods.images; else delete rec.images;
    if (v.goods.market_price == null) delete rec.market_price; else rec.market_price = v.goods.market_price;
    return rec;
  }

  function buildPurchaseRecord(v) {
    var rec = (state.mode === 'edit' && state.purchase) ? clone(state.purchase) : {};
    rec.goods_id = state.goodsId;
    rec.buy_date = v.purchase.buy_date;
    rec.quantity = v.purchase.quantity;
    rec.unit_price = (v.purchase.unit_price == null) ? null : v.purchase.unit_price;
    rec.currency = v.purchase.currency;
    rec.shipping_share = v.purchase.shipping_share;
    rec.channel = v.purchase.channel;
    rec.status = v.purchase.status;
    rec.price_status = v.purchase.price_status;
    rec.note = v.purchase.note;

    if (state.orderId != null) rec.order_id = state.orderId;

    if (v.purchase.deposit == null) delete rec.deposit; else rec.deposit = v.purchase.deposit;
    if (v.purchase.balance == null) delete rec.balance; else rec.balance = v.purchase.balance;
    if (!v.purchase.payment_deadline) delete rec.payment_deadline; else rec.payment_deadline = v.purchase.payment_deadline;
    if (v.purchase.remind_enabled == null) delete rec.remind_enabled; else rec.remind_enabled = v.purchase.remind_enabled;

    if (rec.sold_quantity == null) rec.sold_quantity = 0;
    return rec;
  }

  function setBusy(b) {
    state.busy = b;
    if (dom.saveBtn) {
      dom.saveBtn.disabled = b;
      dom.saveBtn.textContent = b ? '保存中…' : '保存';
    }
  }

  function doSave() {
    if (state.busy) return;
    clearErrors();
    var v = collect();
    if (v.errors.length) {
      markError(v.errors[0]);
      UI.toast(v.errors[0].msg, 'error');
      return;
    }
    var goodsIsNew = (state.mode !== 'edit');
    var purchaseIsNew = (state.mode !== 'edit') || (state.purchaseId == null);
    var goodsRec = buildGoodsRecord(v);
    var purchaseRec = buildPurchaseRecord(v);

    setBusy(true);
    persist(goodsRec, goodsIsNew, purchaseRec, purchaseIsNew).then(function (gid) {
      setBusy(false);
      afterSave(gid);
    }).catch(function (err) {
      setBusy(false);
      console.error('[EATG] 保存失败', err);
      UI.toast('保存失败：' + (err && err.message || err), 'error');
    });
  }

  /**
   * 写入 goods + purchase_items，然后重算并写回 goods.agg（《数据字典》§5）。
   * 事务：purchase + agg 写回走 storage.bulk（原子）。
   */
  function persist(goodsRec, goodsIsNew, purchaseRec, purchaseIsNew) {
    var step = goodsIsNew
      ? S.add('goods', goodsRec).then(function (id) { state.goodsId = Number(id); return Number(id); })
      : S.put('goods', goodsRec).then(function () { return state.goodsId; });

    return step.then(function (gid) {
      state.goodsId = gid;
      purchaseRec.goods_id = gid;
      var write = (purchaseIsNew || purchaseRec.id == null)
        ? S.add('purchase_items', purchaseRec)
        : S.put('purchase_items', purchaseRec);

      return write.then(function (pid) {
        if (pid != null) { purchaseRec.id = pid; state.purchaseId = pid; }
        return Promise.all([
          S.query('purchase_items', 'goods_id', gid),
          S.query('sale_items', 'goods_id', gid)
        ]);
      }).then(function (r) {
        var purchases = r[0] || [];
        var sales = r[1] || [];
        var savedGoods = clone(goodsRec);
        savedGoods.id = gid;
        savedGoods.agg = A.computeGoodsAgg(savedGoods, purchases, sales);
        return S.bulk(['goods', 'purchase_items'], [{ action: 'put', store: 'goods', value: savedGoods }])
          .then(function () { return gid; });
      });
    });
  }

  function afterSave(gid) {
    if (state.continuous && state.mode === 'add') {
      UI.toast('已保存，可继续录入', 'success');
      // 不清空表单（L-03）；下次保存继续新增
      state.goodsId = null;
      state.purchaseId = null;
      return;
    }
    var hasDetail = !!(EATG.pages && EATG.pages['goods/detail']);
    EATG.app && EATG.app.navigate ? EATG.app.navigate(hasDetail ? ('#/goods/detail?id=' + gid) : '#/library')
      : (global.location.hash = hasDetail ? ('#/goods/detail?id=' + gid) : '#/library');
  }

  function leave() {
    if (global.history.length > 1) global.history.back();
    else global.location.hash = '#/library';
  }

  // ---- 数据加载 ----

  function centsParam(v) {
    if (v == null || v === '') return null;
    var n = Number(v);
    return isFinite(n) ? Math.round(n) : null;
  }

  function applyQueryPrefill(params) {
    var g = state.goods;
    g.name = params.get('name') || '';
    g.ip = params.get('ip') || '';
    g.goods_type = params.get('goods_type') || params.get('type') || '';
    var chars = params.get('chars');
    g.character_ids = chars ? chars.split(/[,，\s]+/).map(function (x) { return Number(x); }).filter(function (n) { return isFinite(n) && n; }) : [];
    var tags = params.get('tags');
    g.tags = tags ? tags.split(/[,，\s]+/).filter(Boolean) : [];
    g.note = params.get('note') || '';
    g.market_price = centsParam(params.get('price'));

    var p = state.purchase;
    p.buy_date = params.get('buy_date') || U.todayStr();
    p.quantity = params.get('qty') != null ? Number(params.get('qty')) : 1;
    p.unit_price = centsParam(params.get('unit_price'));
    p.currency = params.get('currency') || (EATG.runtime && EATG.runtime.defaultCurrency) || 'CNY';
    p.shipping_share = centsParam(params.get('shipping_share'));
    p.channel = params.get('channel') || '';
    p.status = params.get('status') || (state.from === 'news' ? 'deposit_pre' : 'on_hand');
    p.note = params.get('pnote') || '';
    // 价格状态：不预填手动估算，按单价自动判定
    p.price_status = null;
    p.remind_enabled = true;
  }

  function load(ctx) {
    var params = new URLSearchParams(ctx.query || '');
    state.mode = (params.get('mode') === 'edit') ? 'edit' : 'add';
    state.from = params.get('from') || null;
    state.addPurchase = (params.get('newp') === '1');
    state.goods = {};
    state.purchase = {};
    var oid = params.get('order_id');
    state.orderId = (oid != null && oid !== '') ? Number(oid) : null;

    return Promise.all([S.getAll('characters'), S.getAll('enums')]).then(function (r) {
      state.characters = r[0] || [];
      var map = {};
      (r[1] || []).forEach(function (row) { map[row.key] = row.values || []; });
      state.enums = { ip: map.ip || [], goods_type: map.goods_type || [], channel: map.channel || [] };

      if (state.mode === 'edit') {
        var id = Number(params.get('id'));
        if (!isFinite(id) || !id) return Promise.reject(expectedError('缺少谷子款 id'));
        return S.get('goods', id).then(function (g) {
          if (!g) throw expectedError('未找到该谷子款（id=' + id + '）');
          state.goods = g;
          state.goodsId = Number(g.id);
          // newp=1：仅复用谷子款信息，购入记录留空 → 为既有谷子款新增一条购入记录
          if (state.addPurchase) { state.purchase = {}; state.purchaseId = null; return null; }
          return S.query('purchase_items', 'goods_id', id).then(function (list) {
            list = list || [];
            var pid = params.get('pid');
            var pick = null;
            if (pid != null && pid !== '') {
              list.forEach(function (it) { if (Number(it.id) === Number(pid)) pick = it; });
            }
            if (!pick) {
              pick = list.slice().sort(function (a, b) {
                return String(b.buy_date || '').localeCompare(String(a.buy_date || '')) || (Number(b.id) - Number(a.id));
              })[0] || null;
            }
            if (pick) { state.purchase = pick; state.purchaseId = Number(pick.id); }
          });
        });
      }
      // add 模式：从 query 预填（from=news|order 等）
      applyQueryPrefill(params);
      return null;
    });
  }

  // ---- 挂载 / 卸载 ----

  function mount(container, ctx) {
    resetState();
    dom = { container: container, ctx: ctx };
    state.quickWords = loadQuickWords();
    state.customQuickWords = loadCustomQuickWords();
    container.innerHTML = skeletonHTML();
    ctx.setTitle('谷子录入');
    ctx.setBack(true);

    return load(ctx).then(function () {
      if (state.destroyed) return;
      ctx.setTitle(state.mode === 'edit'
        ? (state.addPurchase ? '新增购入记录' : '编辑谷子')
        : '新增谷子');
      container.innerHTML = sectionHTML();
      cacheDom();
      bindEvents();
      applyState();
      if (state.mode === 'edit') ctx.setBack(true);
    }, function (err) {
      if (!(err && err.expected)) console.error('[EATG] 谷子录入页加载失败', err);
      UI.toast('加载失败：' + (err && err.message || err), 'error');
      container.innerHTML = '<div class="empty"><p class="empty-title">加载失败，请返回重试</p>' +
        '<button type="button" class="btn btn--secondary" data-act="back">返回</button></div>';
      var b = container.querySelector('[data-act="back"]');
      if (b) on(b, 'click', leave);
    });
  }

  function unmount() {
    state.destroyed = true;
    clearOffs();
    var root = document.getElementById('modal-root');
    if (root) { root.innerHTML = ''; root.hidden = true; }
    dom = {};
    state = null;
  }

  EATG.pages['goods/edit'] = { key: 'goods/edit', mount: mount, unmount: unmount };

})(window);
