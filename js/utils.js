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

  // ---- 图片编辑器（旋转 + 裁剪，纯 Canvas，无外部依赖） ----
  // openImageEditor(dataUrl) → Promise<dataUrl|null>（null = 取消/未改动）
  // 裁剪比例：自由 / 1:1 / 3:4；输出自动压缩到长边 ≤1920、≤约800KB。

  function dataUrlToBlob(dataUrl) {
    var i = dataUrl.indexOf(',');
    var meta = dataUrl.slice(0, i);
    var b64 = dataUrl.slice(i + 1);
    var m = /^data:([^;]+)/.exec(meta);
    var mime = m ? m[1] : 'image/jpeg';
    var bin = atob(b64);
    var arr = new Uint8Array(bin.length);
    for (var k = 0; k < bin.length; k++) arr[k] = bin.charCodeAt(k);
    return new Blob([arr], { type: mime });
  }

  function openImageEditor(src) {
    return loadImage(src).then(function (img) {
      return new Promise(function (resolve) {
        var done = false;
        function finish(v) {
          if (done) return;
          done = true;
          if (el && el.parentNode) el.parentNode.removeChild(el);
          resolve(v);
        }

        var rot = 0;              // 0/90/180/270
        var ratio = 'free';       // free | 1:1 | 3:4
        var crop = null;          // {x,y,w,h}（canvas 显示区坐标）
        var drag = null;
        var cw = 0, ch = 0;       // canvas 像素尺寸（旋转后）

        var el = document.createElement('div');
        el.className = 'img-editor';
        el.innerHTML =
          '<div class="ie-head"><span class="ie-title">编辑图片</span>' +
            '<button type="button" class="ie-close" data-ie="close">✕</button></div>' +
          '<div class="ie-stage" id="ie-stage"><div class="ie-canvas-wrap" id="ie-wrap">' +
            '<canvas class="ie-canvas" id="ie-canvas"></canvas>' +
            '<div class="ie-crop" id="ie-crop">' +
              '<span class="ie-handle ie-h-nw" data-h="nw"></span>' +
              '<span class="ie-handle ie-h-ne" data-h="ne"></span>' +
              '<span class="ie-handle ie-h-sw" data-h="sw"></span>' +
              '<span class="ie-handle ie-h-se" data-h="se"></span>' +
            '</div>' +
          '</div></div>' +
          '<div class="ie-bar">' +
            '<button type="button" class="ie-btn" data-ie="rot-l">左转 ↺</button>' +
            '<button type="button" class="ie-btn" data-ie="rot-r">右转 ↻</button>' +
            '<button type="button" class="ie-btn" data-ie="reset">重置</button>' +
            '<span class="ie-sep"></span>' +
            '<span class="ie-ratio-label">比例</span>' +
            '<button type="button" class="ie-btn ie-ratio-btn is-on" data-ie="ratio" data-r="free">自由</button>' +
            '<button type="button" class="ie-btn ie-ratio-btn" data-ie="ratio" data-r="1:1">1:1</button>' +
            '<button type="button" class="ie-btn ie-ratio-btn" data-ie="ratio" data-r="3:4">3:4</button>' +
          '</div>' +
          '<div class="ie-foot">' +
            '<button type="button" class="btn btn--secondary" data-ie="cancel">取消</button>' +
            '<button type="button" class="btn btn--primary" data-ie="apply">应用</button>' +
          '</div>';
        document.body.appendChild(el);

        var stage = el.querySelector('#ie-stage');
        var wrap = el.querySelector('#ie-wrap');
        var canvas = el.querySelector('#ie-canvas');
        var cropEl = el.querySelector('#ie-crop');
        var ctx = canvas.getContext('2d');

        function rotatedSize() {
          var w = img.naturalWidth || img.width;
          var h = img.naturalHeight || img.height;
          return (rot % 180 === 90) ? { w: h, h: w } : { w: w, h: h };
        }

        function paint() {
          var rs = rotatedSize();
          cw = rs.w; ch = rs.h;
          canvas.width = cw;
          canvas.height = ch;
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, cw, ch);
          ctx.save();
          ctx.translate(cw / 2, ch / 2);
          ctx.rotate(rot * Math.PI / 180);
          ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
          ctx.restore();
          crop = null;
          layout();
        }

        function canvasCss() {
          var sw = stage.clientWidth || 300;
          var sh = stage.clientHeight || 300;
          var scale = Math.min(sw / cw, sh / ch);
          return { w: Math.round(cw * scale), h: Math.round(ch * scale) };
        }

        function layout() {
          var css = canvasCss();
          canvas.style.width = css.w + 'px';
          canvas.style.height = css.h + 'px';
          wrap.style.width = css.w + 'px';
          wrap.style.height = css.h + 'px';
          if (!crop) crop = { x: 0, y: 0, w: css.w, h: css.h };
          crop = clampCrop(crop);
          applyCropEl();
        }

        function clampCrop(c) {
          var css = canvasCss();
          var x = Math.max(0, Math.min(c.x, css.w - 1));
          var y = Math.max(0, Math.min(c.y, css.h - 1));
          var w = Math.max(40, Math.min(c.w, css.w - x));
          var h = Math.max(40, Math.min(c.h, css.h - y));
          return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
        }

        function applyCropEl() {
          if (!crop) return;
          cropEl.style.left = crop.x + 'px';
          cropEl.style.top = crop.y + 'px';
          cropEl.style.width = crop.w + 'px';
          cropEl.style.height = crop.h + 'px';
        }

        function fitDims(ax, ay) {
          if (ratio === 'free') return { w: ax, h: ay };
          var target = ratio === '1:1' ? 1 : (3 / 4);
          if (ay * target >= ax) return { w: Math.round(ay * target), h: ay };
          return { w: ax, h: Math.round(ax / target) };
        }

        function ratioBtn(btns, val) {
          for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('is-on', btns[i].dataset.r === val);
        }

        // ---- 裁剪框手势（pointer） ----
        stage.addEventListener('pointerdown', function (e) {
          if (e.button && e.button !== 0) return;
          var h = e.target.closest('[data-h]');
          if (h) { drag = { mode: 'resize', handle: h.dataset.h, startX: e.clientX, startY: e.clientY, base: { x: crop.x, y: crop.y, w: crop.w, h: crop.h } }; }
          else if (cropEl.contains(e.target)) { drag = { mode: 'move', startX: e.clientX, startY: e.clientY, base: { x: crop.x, y: crop.y, w: crop.w, h: crop.h } }; }
          else { drag = { mode: 'new', startX: e.clientX, startY: e.clientY }; }
          if (e.cancelable) e.preventDefault();
        });

        document.addEventListener('pointermove', function (e) {
          if (!drag) return;
          var wrapRect = wrap.getBoundingClientRect();
          var lx = e.clientX - wrapRect.left;
          var ly = e.clientY - wrapRect.top;
          if (drag.mode === 'move') {
            var m = {
              x: drag.base.x + (e.clientX - drag.startX),
              y: drag.base.y + (e.clientY - drag.startY),
              w: drag.base.w, h: drag.base.h
            };
            crop = clampCrop(m);
            applyCropEl();
          } else if (drag.mode === 'resize') {
            var f = drag.base;
            var fixedX = (drag.handle.indexOf('w') >= 0) ? f.x + f.w : f.x;
            var fixedY = (drag.handle.indexOf('n') >= 0) ? f.y + f.h : f.y;
            var ax = Math.abs(lx - fixedX), ay = Math.abs(ly - fixedY);
            var d = fitDims(ax, ay);
            var x = (drag.handle.indexOf('w') >= 0) ? fixedX - d.w : fixedX;
            var y = (drag.handle.indexOf('n') >= 0) ? fixedY - d.h : fixedY;
            crop = clampCrop({ x: x, y: y, w: d.w, h: d.h });
            applyCropEl();
          } else if (drag.mode === 'new') {
            var nx = Math.min(lx, drag.startX - (drag.startX - wrapRect.left));
            var ny = Math.min(ly, drag.startY - (drag.startY - wrapRect.top));
            var nw = Math.abs(lx - (drag.startX - wrapRect.left));
            var nh = Math.abs(ly - (drag.startY - wrapRect.top));
            var d2 = fitDims(nw, nh);
            crop = clampCrop({ x: nx, y: ny, w: d2.w, h: d2.h });
            applyCropEl();
          }
        });

        function endDrag() { drag = null; }
        document.addEventListener('pointerup', endDrag);
        document.addEventListener('pointercancel', endDrag);

        // ---- 工具栏 ----
        el.addEventListener('click', function (e) {
          var b = e.target.closest('[data-ie]');
          if (!b) return;
          var act = b.dataset.ie;
          if (act === 'close' || act === 'cancel') { finish(null); }
          else if (act === 'rot-l') { rot = (rot + 270) % 360; paint(); }
          else if (act === 'rot-r') { rot = (rot + 90) % 360; paint(); }
          else if (act === 'reset') { rot = 0; ratio = 'free'; ratioBtn(el.querySelectorAll('.ie-ratio-btn'), 'free'); paint(); }
          else if (act === 'ratio') { ratio = b.dataset.r; ratioBtn(el.querySelectorAll('.ie-ratio-btn'), ratio); crop = clampCrop(crop); applyCropEl(); }
          else if (act === 'apply') { doApply(); }
        });

        function doApply() {
          if (!crop) { finish(null); return; }
          var css = canvasCss();
          var scaleX = cw / css.w, scaleY = ch / css.h;
          var sx = Math.round(crop.x * scaleX), sy = Math.round(crop.y * scaleY);
          var sw = Math.max(1, Math.round(crop.w * scaleX)), sh = Math.max(1, Math.round(crop.h * scaleY));
          var out = document.createElement('canvas');
          out.width = sw; out.height = sh;
          var octx = out.getContext('2d');
          octx.fillStyle = '#FFFFFF';
          octx.fillRect(0, 0, sw, sh);
          octx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
          var dataUrl = out.toDataURL('image/jpeg', 0.92);
          if (EATG.ui) EATG.ui.toast('正在压缩…');
          compressImage(dataUrlToBlob(dataUrl), { maxEdge: 1920, quality: 0.85 }).then(function (finalUrl) {
            finish(finalUrl);
          }).catch(function (err) {
            console.error('[EATG] 图片编辑应用失败', err);
            if (EATG.ui) EATG.ui.toast('处理失败，已取消', 'error');
            finish(null);
          });
        }

        paint();
      });
    });
  }

  U.openImageEditor = openImageEditor;

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
