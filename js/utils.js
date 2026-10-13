/* ==========================================================================
   一咕（EATG）· 通用工具函数模块（js/utils.js）
   实现：fmtMoney(分,币种)（含汇率换算）/ todayStr() / genId() / uuid() /
        compressImage(file,{maxEdge,quality,stripExif}) / toCnyCents()
   依据《一咕EATG-数据字典与存储规范》§1、§5、《业务规则与计算逻辑》§8。
   ========================================================================== */
(function (global) {
  'use strict';

  var EATG = (global.EATG = global.EATG || {});

  // 运行期轻量缓存：供同步函数（如汇率换算）读取；由 storage.initDB() 载入 settings 后刷新。
  EATG.runtime = EATG.runtime || {
    exchangeRate: 0.05,   // JPY→CNY，默认 0.05（settings.exchange_rate 可改）
    defaultCurrency: 'CNY',
    imageQuality: 0.8
  };

  var U = (EATG.utils = EATG.utils || {});

  // ---- 基础 ----

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** 本地日期字符串 YYYY-MM-DD（可选传入 Date） */
  function todayStr(d) {
    var x = (d instanceof Date) ? d : new Date();
    return x.getFullYear() + '-' + pad2(x.getMonth() + 1) + '-' + pad2(x.getDate());
  }

  var _idSeq = 0;
  /** 生成本地唯一 id（字符串：时间戳 + 3 位序号） */
  function genId() {
    _idSeq = (_idSeq + 1) % 1000;
    return String(Date.now()) + ('000' + _idSeq).slice(-3);
  }

  /** RFC4122 v4 UUID（有 crypto 时用强随机） */
  function uuid() {
    if (global.crypto && global.crypto.getRandomValues) {
      var b = new Uint8Array(16);
      global.crypto.getRandomValues(b);
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      var hex = [];
      for (var i = 0; i < 16; i++) { hex.push(('0' + b[i].toString(16)).slice(-2)); }
      return hex.slice(0, 4).join('') + '-' + hex.slice(4, 6).join('') + '-' +
             hex.slice(6, 8).join('') + '-' + hex.slice(8, 10).join('') + '-' +
             hex.slice(10, 16).join('');
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : ((r & 0x3) | 0x8);
      return v.toString(16);
    });
  }

  // ---- 金额（唯一换算口径，业务规则 §8） ----

  /**
   * 分整数 + 币种 → 人民币“分”整数（JPY 等按汇率换算：round(原币分 × rate)）
   * @returns {number|null}
   */
  function toCnyCents(cents, currency) {
    var n = Number(cents);
    if (!isFinite(n)) return null;
    var cur = currency || EATG.runtime.defaultCurrency || 'CNY';
    if (cur === 'CNY') return Math.round(n);
    var rate = Number(EATG.runtime.exchangeRate);
    if (!isFinite(rate) || rate <= 0) rate = 0.05;
    return Math.round(n * rate);
  }

  /**
   * 金额展示：分整数 + 币种 → 人民币字符串（含汇率换算）
   * 例：fmtMoney(30,'CNY') === '¥0.30'；fmtMoney(1000,'JPY')（rate 0.05）=== '¥0.50'
   */
  function fmtMoney(cents, currency) {
    var cny = toCnyCents(cents, currency);
    if (cny == null) return '--';
    var sign = cny < 0 ? '-' : '';
    var parts = (Math.abs(cny) / 100).toFixed(2).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return sign + '¥' + parts.join('.');
  }

  // ---- 图片压缩（canvas 重绘 → 输出 JPEG，天然剥离 EXIF；业务规则 §12.9） ----

  function readAsDataURL(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error || new Error('读取文件失败')); };
      fr.readAsDataURL(file);
    });
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('图片解码失败')); };
      img.src = src;
    });
  }

  /** 估算 dataURL 的二进制字节数 */
  function dataUrlBytes(dataUrl) {
    var i = dataUrl.indexOf(',');
    var b64 = i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
    var pad = b64.slice(-2) === '==' ? 2 : (b64.slice(-1) === '=' ? 1 : 0);
    return Math.floor(b64.length * 3 / 4) - pad;
  }

  /**
   * 压缩图片为 base64（dataURL）字符串。
   * @param {File|Blob} file
   * @param {{maxEdge?:number, quality?:number, strictMaxBytes?:number, mime?:string, stripExif?:boolean}} opts
   * @returns {Promise<string>} dataURL（data:image/jpeg;base64,...）
   * 说明：默认长边 ≤1920、质量 0.8；若结果 > 约 800KB 则自动降质/缩放重压。
   *       canvas 重绘后不含原始 EXIF（stripExif 生效，位置信息被剥离）。
   */
  function compressImage(file, opts) {
    opts = opts || {};
    var maxEdge = opts.maxEdge || 1920;
    var quality = (opts.quality == null) ? 0.8 : opts.quality;
    var maxBytes = opts.maxBytes || 800 * 1024;
    var mime = opts.mime || 'image/jpeg';

    return readAsDataURL(file).then(loadImage).then(function (img) {
      var w = img.naturalWidth || img.width;
      var h = img.naturalHeight || img.height;
      var scale = Math.min(1, maxEdge / Math.max(w, h));
      var cw = Math.max(1, Math.round(w * scale));
      var ch = Math.max(1, Math.round(h * scale));

      var canvas = document.createElement('canvas');
      var ctx = canvas.getContext('2d');
      var q = quality;
      var out = '';
      var attempt = 0;

      while (true) {
        canvas.width = cw;
        canvas.height = ch;
        ctx = canvas.getContext('2d');
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, cw, ch);
        ctx.drawImage(img, 0, 0, cw, ch);
        out = canvas.toDataURL(mime, q);
        if (dataUrlBytes(out) <= maxBytes || attempt >= 6) break;
        attempt++;
        if (q > 0.4) { q = Math.max(0.4, q - 0.1); }
        else { cw = Math.max(1, Math.round(cw * 0.8)); ch = Math.max(1, Math.round(ch * 0.8)); }
      }
      return out;
    });
  }

  U.todayStr = todayStr;
  U.genId = genId;
  U.uuid = uuid;
  U.toCnyCents = toCnyCents;
  U.fmtMoney = fmtMoney;
  U.compressImage = compressImage;

  // ---- 主题切换（P-03 深色模式） ----
  function applyTheme(val) {
    var t = val || 'auto';
    if (t === 'auto') {
      t = global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    try { document.documentElement.setAttribute('data-theme', t); } catch (e) {}
    return t;
  }
  U.applyTheme = applyTheme;

})(window);
