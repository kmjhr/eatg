/* ==========================================================================
   一咕（EATG）· 设置页（js/pages/settings.js）
   实现：《页面线框与UI规范》P20 + 《业务规则》§8
   路由：#/settings
   分组：币种 / 提醒 / 图片 / 监控源 / 数据管理 / 关于
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

  var DEFAULTS = S.SETTINGS_DEFAULTS;

  function resetState() {
    state = {
      destroyed: false,
      theme: 'auto',
      default_currency: DEFAULTS.default_currency,
      exchange_rate: DEFAULTS.exchange_rate,
      reminder: DEFAULTS.reminder,
      image_quality: DEFAULTS.image_quality,
      vision_api: DEFAULTS.vision_api,
      imageStats: { count: 0, bytes: 0 }
    };
  }

  function load() {
    return Promise.all([
      S.getSetting('theme'),
      S.getSetting('default_currency'),
      S.getSetting('exchange_rate'),
      S.getSetting('reminder'),
      S.getSetting('image_quality'),
      S.getSetting('vision_api'),
      S.getAll('goods')
    ]).then(function (r) {
      state.theme = r[0] || 'auto';
      state.default_currency = r[1] != null ? r[1] : DEFAULTS.default_currency;
      state.exchange_rate = r[2] || DEFAULTS.exchange_rate;
      state.reminder = r[3] || DEFAULTS.reminder;
      state.image_quality = r[4] != null ? r[4] : DEFAULTS.image_quality;
      state.vision_api = r[5] || DEFAULTS.vision_api;
      // 图片占用统计：所有 goods.images 的 base64 长度估算
      var goods = r[6] || [];
      var count = 0, bytes = 0;
      goods.forEach(function (g) {
        var imgs = g.images || [];
        imgs.forEach(function (img) {
          if (!img) return;
          count++;
          // base64 数据URL：每 4 字符 ≈ 3 字节
          var head = img.indexOf('base64,');
          var b64 = head >= 0 ? img.slice(head + 7) : img;
          bytes += Math.floor(b64.length * 3 / 4);
        });
      });
      state.imageStats = { count: count, bytes: bytes };
    });
  }

  function fmtBytes(b) {
    b = num(b);
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1024 / 1024).toFixed(2) + ' MB';
  }

  function fmtDate(ts) {
    if (!ts) return '无';
    var d = new Date(ts);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function headHTML() { return ''; }

  function groupHTML(title, body) {
    return '<div class="stg-group"><div class="stg-group-title">' + esc(title) + '</div>' + body + '</div>';
  }

  function rowHTML(label, control, hint) {
    return '<div class="stg-row">' +
      '<div class="stg-row-label">' + esc(label) + (hint ? '<div class="stg-row-hint">' + esc(hint) + '</div>' : '') + '</div>' +
      '<div class="stg-row-control">' + control + '</div>' +
    '</div>';
  }

  function currencyBody() {
    var er = state.exchange_rate || {};
    var auto = !!er.auto;
    var stale = er.source === 'api' && er.updated_at && (Date.now() - num(er.updated_at) > 24 * 3600 * 1000);
    var rateNote = er.source === 'api' ? '自动获取' : '手动';
    if (stale) rateNote += ' · 汇率可能过期';
    return rowHTML('默认币种',
      '<select id="stg-currency" class="input stg-select">' +
        '<option value="CNY"' + (state.default_currency === 'CNY' ? ' selected' : '') + '>CNY 人民币</option>' +
        '<option value="JPY"' + (state.default_currency === 'JPY' ? ' selected' : '') + '>JPY 日元</option>' +
        '<option value="USD"' + (state.default_currency === 'USD' ? ' selected' : '') + '>USD 美元</option>' +
      '</select>', '录入时保存原币，展示统一换算');
  }

  function exchangeBody() {
    var er = state.exchange_rate || {};
    var auto = !!er.auto;
    var stale = er.source === 'api' && er.updated_at && (Date.now() - num(er.updated_at) > 24 * 3600 * 1000);
    var rateNote = er.source === 'api' ? '自动获取' : '手动';
    if (stale) rateNote += ' · 汇率可能过期';
    return rowHTML('汇率（JPY→CNY）',
      '<div class="stg-rate-box">' +
        '<input id="stg-rate" type="number" step="0.0001" value="' + esc(er.rate) + '" class="input stg-rate" ' + (auto ? 'disabled' : '') + '>' +
        '<span class="stg-rate-note">' + esc(rateNote) + ' · 更新于 ' + esc(fmtDate(er.updated_at)) + '</span>' +
      '</div>', '1 日元 = X 人民币') +
      rowHTML('自动获取汇率',
        '<label class="switch"><input type="checkbox" id="stg-rate-auto" ' + (auto ? 'checked' : '') + '><span class="switch-track"></span></label>') +
      '<div class="stg-actions">' +
        '<button id="stg-rate-save" type="button" class="btn btn--primary">保存汇率</button>' +
      '</div>';
  }

  function reminderBody() {
    var r = state.reminder || {};
    return rowHTML('提醒开关',
      '<label class="switch"><input type="checkbox" id="stg-rem-enabled" ' + (r.enabled !== false ? 'checked' : '') + '><span class="switch-track"></span></label>') +
      rowHTML('开订提前（天）',
        '<input id="stg-rem-pre" type="number" min="0" value="' + esc(num(r.preorder_lead)) + '" class="input stg-num">') +
      rowHTML('补款提前（天）',
        '<input id="stg-rem-dead" type="number" min="0" value="' + esc(num(r.deadline_lead)) + '" class="input stg-num">') +
      rowHTML('免打扰时段',
        '<div class="stg-quiet-box">' +
          '<input id="stg-quiet-start" type="time" value="' + esc(r.quiet_start || '22:00') + '" class="input stg-time">' +
          '<span>—</span>' +
          '<input id="stg-quiet-end" type="time" value="' + esc(r.quiet_end || '08:00') + '" class="input stg-time">' +
        '</div>') +
      '<div class="stg-actions">' +
        '<button id="stg-rem-save" type="button" class="btn btn--primary">保存提醒设置</button>' +
      '</div>';
  }

  function visionBody() {
    var v = state.vision_api || {};
    return rowHTML('识别服务地址',
      '<input id="stg-vis-url" type="text" class="input" value="' + esc(v.url || '') + '">',
      '默认智谱 BigModel；有自建代理可改地址') +
      rowHTML('API Key',
        '<input id="stg-vis-key" type="password" class="input" value="' + esc(v.key || '') + '" placeholder="仅存本机浏览器">',
        '拍照批量录入时「自动识别」用它给谷子出框；留空则回退本地 OCR') +
      rowHTML('模型名',
        '<input id="stg-vis-model" type="text" class="input" value="' + esc(v.model || '') + '">',
        '默认 glm-4.6v-flash（智谱免费档）') +
      '<div class="stg-actions">' +
        '<button id="stg-vis-save" type="button" class="btn btn--primary">保存视觉识别设置</button>' +
      '</div>';
  }

  function imageBody() {
    var q = state.image_quality;
    return rowHTML('图片占用',
      '<span class="stg-static">' + esc(state.imageStats.count) + ' 张 · ' + esc(fmtBytes(state.imageStats.bytes)) + '</span>') +
      rowHTML('压缩质量',
        '<div class="stg-quality-box">' +
          '<input id="stg-img-quality" type="range" min="0.3" max="1" step="0.05" value="' + esc(q) + '">' +
          '<span id="stg-q-val" class="stg-q-val">' + esc(Math.round(q * 100)) + '%</span>' +
        '</div>', '上传图片时按此质量压缩，剥离 EXIF') +
      '<div class="stg-actions">' +
        '<button id="stg-img-clean" type="button" class="btn">清理图片缓存</button>' +
        '<button id="stg-img-save" type="button" class="btn btn--primary">保存质量</button>' +
      '</div>';
  }

  function themeBody() {
    var t = state.theme || 'auto';
    return rowHTML('主题',
      '<select id="stg-theme" class="input stg-select">' +
        '<option value="auto"' + (t === 'auto' ? ' selected' : '') + '>跟随系统</option>' +
        '<option value="light"' + (t === 'light' ? ' selected' : '') + '>浅色</option>' +
        '<option value="dark"' + (t === 'dark' ? ' selected' : '') + '>深色</option>' +
      '</select>', '切换后立即生效');
  }

  function linksBody() {
    return '<a class="stg-link" href="#/sources">' +
        '<span class="stg-link-label">监控源</span><span class="stg-link-arrow">›</span>' +
      '</a>' +
      '<a class="stg-link" href="#/data">' +
        '<span class="stg-link-label">数据管理</span><span class="stg-link-arrow">›</span>' +
      '</a>' +
      '<a class="stg-link" href="#/about">' +
        '<span class="stg-link-label">关于与隐私</span><span class="stg-link-arrow">›</span>' +
      '</a>';
  }

  function pageHTML() {
    return '<div class="stg-page">' +
      groupHTML('外观', themeBody()) +
      groupHTML('币种', currencyBody()) +
      groupHTML('汇率', exchangeBody()) +
      groupHTML('提醒', reminderBody()) +
      groupHTML('视觉识别', visionBody()) +
      groupHTML('图片', imageBody()) +
      groupHTML('其他', linksBody()) +
    '</div>';
  }

  // ---- 保存逻辑 ----
  function saveRate() {
    var autoEl = document.getElementById('stg-rate-auto');
    var auto = !!(autoEl && autoEl.checked);
    var er = { rate: num(state.exchange_rate && state.exchange_rate.rate), updated_at: state.exchange_rate && state.exchange_rate.updated_at, source: state.exchange_rate && state.exchange_rate.source, auto: auto };
    if (!auto) {
      var v = document.getElementById('stg-rate');
      if (v) er.rate = num(v.value);
      er.source = 'manual';
      er.updated_at = Date.now();
    }
    S.setSetting('exchange_rate', er).then(function () {
      state.exchange_rate = er;
      UI.toast('汇率已保存', 'success');
      // 局部刷新汇率组
      document.querySelector('.stg-group:nth-child(2) .stg-group-title').textContent = '汇率';
      var er2 = er;
      document.getElementById('stg-rate').value = er2.rate;
      document.getElementById('stg-rate').disabled = !!er2.auto;
    }).catch(function (err) { UI.toast('保存失败：' + err.message, 'error'); });
  }

  function saveReminder() {
    var r = {
      enabled: !!(document.getElementById('stg-rem-enabled') || {}).checked,
      preorder_lead: num((document.getElementById('stg-rem-pre') || {}).value),
      deadline_lead: num((document.getElementById('stg-rem-dead') || {}).value),
      quiet_start: (document.getElementById('stg-quiet-start') || {}).value || '22:00',
      quiet_end: (document.getElementById('stg-quiet-end') || {}).value || '08:00'
    };
    S.setSetting('reminder', r).then(function () {
      state.reminder = r;
      UI.toast('提醒设置已保存', 'success');
    }).catch(function (err) { UI.toast('保存失败：' + err.message, 'error'); });
  }

  function saveVision() {
    var v = {
      url: (document.getElementById('stg-vis-url') || {}).value || '',
      key: (document.getElementById('stg-vis-key') || {}).value || '',
      model: (document.getElementById('stg-vis-model') || {}).value || ''
    };
    S.setSetting('vision_api', v).then(function () {
      state.vision_api = v;
      UI.toast('视觉识别设置已保存', 'success');
    }).catch(function (err) { UI.toast('保存失败：' + err.message, 'error'); });
  }

  function saveImageQuality() {
    var v = num((document.getElementById('stg-img-quality') || {}).value);
    S.setSetting('image_quality', v).then(function () {
      state.image_quality = v;
      UI.toast('压缩质量已保存', 'success');
    }).catch(function (err) { UI.toast('保存失败：' + err.message, 'error'); });
  }

  function cleanImages() {
    if (!state.imageStats.count) { UI.toast('暂无图片缓存', 'info'); return; }
    UI.confirmDialog({
      title: '清理图片缓存',
      message: '将删除所有谷子款中保存的图片，此操作不可恢复。确认继续？',
      confirmText: '确认清理',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      S.getAll('goods').then(function (goods) {
        var ops = goods.filter(function (g) { return g.images && g.images.length; }).map(function (g) {
          g.images = [];
          return { action: 'put', store: 'goods', value: g };
        });
        if (!ops.length) { state.imageStats = { count: 0, bytes: 0 }; refreshImageStats(); return; }
        return S.bulk('goods', ops).then(function () {
          state.imageStats = { count: 0, bytes: 0 };
          UI.toast('已清理 ' + ops.length + ' 款的图片', 'success');
          refreshImageStats();
        });
      }).catch(function (err) { UI.toast('清理失败：' + err.message, 'error'); });
    });
  }

  function refreshImageStats() {
    var s = document.querySelector('.stg-static');
    if (s) s.textContent = state.imageStats.count + ' 张 · ' + fmtBytes(state.imageStats.bytes);
  }

  function bind() {
    var themeSel = document.getElementById('stg-theme');
    if (themeSel) on(themeSel, 'change', function () {
      var val = themeSel.value;
      U.applyTheme(val);
      try { localStorage.setItem('eatg_theme', val); } catch (e) {}
      S.setSetting('theme', val).then(function () {
        state.theme = val;
        UI.toast('主题已切换', 'success');
      }).catch(function (err) { UI.toast('保存失败：' + err.message, 'error'); });
    });

    var cur = document.getElementById('stg-currency');
    if (cur) on(cur, 'change', function () {
      S.setSetting('default_currency', cur.value).then(function () {
        state.default_currency = cur.value;
        UI.toast('默认币种已切换为 ' + cur.value, 'success');
      }).catch(function (err) { UI.toast('保存失败：' + err.message, 'error'); });
    });

    var q = document.getElementById('stg-img-quality');
    if (q) on(q, 'input', function () {
      var v = document.getElementById('stg-q-val');
      if (v) v.textContent = Math.round(num(q.value) * 100) + '%';
    });

    var auto = document.getElementById('stg-rate-auto');
    if (auto) on(auto, 'change', function () {
      document.getElementById('stg-rate').disabled = auto.checked;
    });

    on(document.getElementById('stg-rate-save'), 'click', saveRate);
    on(document.getElementById('stg-rem-save'), 'click', saveReminder);
    on(document.getElementById('stg-vis-save'), 'click', saveVision);
    on(document.getElementById('stg-img-save'), 'click', saveImageQuality);
    on(document.getElementById('stg-img-clean'), 'click', cleanImages);
  }

  function mount(container, ctx) {
    resetState();
    dom = { container: container };
    container.innerHTML = '<div class="loading">加载中…</div>';
    ctx.setTitle('设置');
    ctx.setBack(true);
    ctx.setActiveTab('mine');
    ctx.navActions.innerHTML = '';
    return load().then(function () {
      if (state.destroyed) return;
      container.innerHTML = pageHTML();
      bind();
    }).catch(function (err) {
      if (state.destroyed) return;
      console.error('[EATG] 设置页加载失败', err);
      UI.toast('加载失败：' + (err && err.message || err), 'error');
    });
  }

  function unmount() {
    if (state) state.destroyed = true;
    clearOffs();
  }

  EATG.pages['settings'] = { key: 'settings', mount: mount, unmount: unmount };

})(window);
