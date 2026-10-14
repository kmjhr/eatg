/* EATG 图片编辑器（订单截图用）：旋转 / 裁剪 / 画笔标注 / 撤销 / 保存
 * open(src) -> Promise<newSrc|null>  保存返回新 base64，取消返回 null
 * 独立模块，自含样式，不依赖页面 DOM */
(function () {
  var EATG = window.EATG = window.EATG || {};

  var CSS = '.eatg-ime-mask{position:fixed;inset:0;z-index:1000;background:rgba(10,10,14,.72);display:flex;flex-direction:column;align-items:stretch;justify-content:space-between;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}' +
    '.eatg-ime-head{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;color:#fff;font-size:15px;font-weight:600}' +
    '.eatg-ime-head .eatg-ime-x{font-size:26px;line-height:1;padding:2px 10px;background:none;border:none;color:#fff;cursor:pointer}' +
    '.eatg-ime-stage{flex:1;display:flex;align-items:center;justify-content:center;overflow:hidden;padding:0 8px;position:relative}' +
    '.eatg-ime-canvas{max-width:100%;max-height:56vh;background:#111;border-radius:6px;box-shadow:0 6px 24px rgba(0,0,0,.4);touch-action:none;display:block;user-select:none;-webkit-user-select:none}' +
    '.eatg-ime-bar{display:flex;align-items:center;justify-content:center;gap:8px;padding:10px 10px calc(10px + env(safe-area-inset-bottom));background:#16161c;border-top:1px solid #2a2a34}' +
    '.eatg-ime-btn{border:none;background:#2b2b36;color:#fff;font-size:13px;padding:8px 14px;border-radius:20px;min-width:52px;cursor:pointer}' +
    '.eatg-ime-btn:active{background:#3a3a48}' +
    '.eatg-ime-btn.on{background:#e63946;color:#fff}' +
    '.eatg-ime-btn.save{background:#2f6fed;color:#fff;font-weight:600}' +
    '.eatg-ime-colors{display:flex;gap:6px;align-items:center}' +
    '.eatg-ime-dot{width:22px;height:22px;border-radius:50%;border:2px solid transparent;cursor:pointer}' +
    '.eatg-ime-dot.on{border-color:#fff}' +
    '.eatg-ime-tip{color:#9aa0b5;font-size:11px;padding:0 6px;max-width:110px;line-height:1.3}' +
    '.eatg-ime-fixed{position:absolute;right:10px;top:6px;background:#e63946;color:#fff;font-size:11px;padding:3px 8px;border-radius:10px;z-index:2}';

  var styleEl = document.createElement('style');
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);

  function open(src) {
    return new Promise(function (resolve) {
      var state = { src: src, img: null, sel: null, pens: [], mode: 'view', color: '#e53935', done: false };
      var img = new Image();
      img.onload = function () {
        state.img = img;
        build();
      };
      img.onerror = function () { resolve(null); };
      img.src = src;

      var mask, canvas, ctx, stage;
      var dragging = null; // {type:'move'} | {type:'corner',i}
      var curPen = null;
      var HIT = 20;

      function build() {
        mask = document.createElement('div');
        mask.className = 'eatg-ime-mask';
        mask.innerHTML =
          '<div class="eatg-ime-head"><span>编辑截图</span><button type="button" class="eatg-ime-x" data-eatg="close">×</button></div>' +
          '<div class="eatg-ime-stage">' +
            '<span class="eatg-ime-fixed" data-eatg="mode-tip" hidden></span>' +
            '<canvas class="eatg-ime-canvas"></canvas>' +
          '</div>' +
          '<div class="eatg-ime-bar">' +
            '<button type="button" class="eatg-ime-btn" data-eatg="rotate">旋转</button>' +
            '<button type="button" class="eatg-ime-btn" data-eatg="crop">裁剪</button>' +
            '<button type="button" class="eatg-ime-btn" data-eatg="pen">画笔</button>' +
            '<button type="button" class="eatg-ime-btn" data-eatg="undo">撤销</button>' +
            '<button type="button" class="eatg-ime-btn save" data-eatg="save">保存</button>' +
          '</div>';
        document.body.appendChild(mask);
        stage = mask.querySelector('.eatg-ime-stage');
        canvas = mask.querySelector('canvas');
        ctx = canvas.getContext('2d');
        layout();
        defaultSel();
        draw();
        bindUI();
      }

      function layout() {
        var iw = state.img.naturalWidth, ih = state.img.naturalHeight;
        var maxW = 1100, maxH = 1500;
        var s = Math.min(1, maxW / iw, maxH / ih);
        canvas.width = Math.max(1, Math.round(iw * s));
        canvas.height = Math.max(1, Math.round(ih * s));
      }

      function defaultSel() {
        var w = Math.round(canvas.width * 0.9), h = Math.round(canvas.height * 0.9);
        state.sel = { x: Math.round((canvas.width - w) / 2), y: Math.round((canvas.height - h) / 2), w: w, h: h };
      }

      function toPx(e) {
        var r = canvas.getBoundingClientRect();
        return {
          x: (e.clientX - r.left) * (canvas.width / r.width),
          y: (e.clientY - r.top) * (canvas.height / r.height)
        };
      }

      function draw() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(state.img, 0, 0, canvas.width, canvas.height);
        // 笔画
        state.pens.forEach(function (p) {
          if (!p.pts.length) return;
          ctx.strokeStyle = p.c;
          ctx.lineWidth = Math.max(2, canvas.width / 240);
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.beginPath();
          p.pts.forEach(function (pt, i) { if (i === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y); });
          ctx.stroke();
        });
        // 选区
        if (state.mode === 'crop' && state.sel) drawSel();
      }

      function drawSel() {
        var s = state.sel;
        ctx.save();
        ctx.strokeStyle = 'rgba(47,111,237,.95)';
        ctx.lineWidth = 2;
        ctx.setLineDash([8, 5]);
        ctx.strokeRect(s.x, s.y, s.w, s.h);
        ctx.setLineDash([]);
        // 四角把手
        var hs = Math.max(14, canvas.width / 60);
        [[s.x, s.y], [s.x + s.w, s.y], [s.x, s.y + s.h], [s.x + s.w, s.y + s.h]].forEach(function (c) {
          ctx.fillStyle = '#2f6fed';
          ctx.fillRect(c[0] - hs / 2, c[1] - hs / 2, hs, hs);
        });
        // 暗化外部
        ctx.fillStyle = 'rgba(0,0,0,.35)';
        ctx.fillRect(0, 0, canvas.width, s.y);
        ctx.fillRect(0, s.y + s.h, canvas.width, canvas.height - s.y - s.h);
        ctx.fillRect(0, s.y, s.x, s.h);
        ctx.fillRect(s.x + s.w, s.y, canvas.width - s.x - s.w, s.h);
        ctx.restore();
      }

      function hitTest(p) {
        var s = state.sel, hs = Math.max(14, canvas.width / 60) / 2 + HIT;
        var corners = [[s.x, s.y], [s.x + s.w, s.y], [s.x, s.y + s.h], [s.x + s.w, s.y + s.h]];
        for (var i = 0; i < corners.length; i++) {
          if (Math.abs(p.x - corners[i][0]) < hs && Math.abs(p.y - corners[i][1]) < hs) return { type: 'corner', i: i };
        }
        if (p.x >= s.x && p.x <= s.x + s.w && p.y >= s.y && p.y <= s.y + s.h) return { type: 'move' };
        return null;
      }

      function clampSel() {
        var s = state.sel;
        s.w = Math.max(40, Math.min(canvas.width, s.w));
        s.h = Math.max(40, Math.min(canvas.height, s.h));
        s.x = Math.max(0, Math.min(canvas.width - s.w, s.x));
        s.y = Math.max(0, Math.min(canvas.height - s.h, s.y));
      }

      function rotate90() {
        var c = document.createElement('canvas');
        c.width = canvas.height; c.height = canvas.width;
        var x = c.getContext('2d');
        x.translate(c.width / 2, c.height / 2);
        x.rotate(Math.PI / 2);
        x.drawImage(state.img, -state.img.naturalWidth / 2, -state.img.naturalHeight / 2, state.img.naturalWidth, state.img.naturalHeight);
        var url = c.toDataURL('image/jpeg', 0.92);
        state.src = url;
        state.pens = []; // 旋转后清空标注，坐标已失效
        var ni = new Image();
        ni.onload = function () {
          state.img = ni;
          layout();
          defaultSel();
          draw();
          toastTip('已旋转（标注已清空）');
        };
        ni.src = url;
      }

      function setMode(m) {
        state.mode = m;
        var tip = mask.querySelector('[data-eatg="mode-tip"]');
        if (m === 'crop') { tip.textContent = '拖动选区调整裁剪范围'; tip.hidden = false; }
        else if (m === 'pen') { tip.textContent = '手指绘制标注，可换颜色'; tip.hidden = false; }
        else tip.hidden = true;
        [['crop', '裁剪'], ['pen', '画笔']].forEach(function (p) {
          var b = mask.querySelector('[data-eatg="' + p[0] + '"]');
          if (b) b.classList.toggle('on', state.mode === p[0]);
        });
        if (typeof showColors === 'function') showColors();
        draw();
      }

      function undo() {
        if (!state.pens.length) { toastTip('没有可撤销的标注'); return; }
        state.pens.pop();
        draw();
      }

      function save() {
        var w = canvas.width, h = canvas.height;
        var sx = 0, sy = 0, sw = w, sh = h;
        if (state.mode === 'crop' && state.sel && state.sel.w > 30 && state.sel.h > 30) {
          sx = Math.round(state.sel.x); sy = Math.round(state.sel.y);
          sw = Math.round(state.sel.w); sh = Math.round(state.sel.h);
        }
        var out = document.createElement('canvas');
        out.width = sw; out.height = sh;
        var o = out.getContext('2d');
        o.drawImage(state.img, sx, sy, sw, sh, 0, 0, sw, sh);
        state.pens.forEach(function (p) {
          if (!p.pts.length) return;
          o.strokeStyle = p.c;
          o.lineWidth = Math.max(2, out.width / 240);
          o.lineCap = 'round';
          o.lineJoin = 'round';
          o.beginPath();
          p.pts.forEach(function (pt, i) {
            var X = pt.x - sx, Y = pt.y - sy;
            if (i === 0) o.moveTo(X, Y); else o.lineTo(X, Y);
          });
          o.stroke();
        });
        state.done = true;
        var data = out.toDataURL('image/jpeg', 0.8);
        cleanup();
        resolve(data);
      }

      function cleanup() {
        if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
        mask = null;
      }

      function toastTip(msg) {
        var t = mask.querySelector('[data-eatg="mode-tip"]');
        if (t) { t.textContent = msg; t.hidden = false; }
      }

      function bindUI() {
        mask.addEventListener('click', function (e) {
          var el = e.target.closest('[data-eatg]');
          if (!el) return;
          var k = el.dataset.eatg;
          if (k === 'close') { state.done = true; cleanup(); resolve(null); }
          else if (k === 'rotate') rotate90();
          else if (k === 'crop') setMode(state.mode === 'crop' ? 'view' : 'crop');
          else if (k === 'pen') setMode(state.mode === 'pen' ? 'view' : 'pen');
          else if (k === 'undo') undo();
          else if (k === 'save') save();
        });
        // 画笔颜色条（点击画笔模式时出现）——用简版：色块直接放 bar 上方？改为按钮后追加色条
        var colorsBar = document.createElement('div');
        colorsBar.className = 'eatg-ime-colors';
        colorsBar.style.display = 'none';
        ['#e53935', '#ffd600', '#3d7bfd', '#43a047', '#ffffff'].forEach(function (c) {
          var d = document.createElement('button');
          d.type = 'button';
          d.className = 'eatg-ime-dot' + (c === state.color ? ' on' : '');
          d.style.background = c;
          d.dataset.color = c;
          colorsBar.appendChild(d);
        });
        var bar = mask.querySelector('.eatg-ime-bar');
        bar.insertBefore(colorsBar, bar.firstChild);
        colorsBar.addEventListener('click', function (e) {
          var d = e.target.closest('[data-color]');
          if (!d) return;
          state.color = d.dataset.color;
          var dots = colorsBar.querySelectorAll('.eatg-ime-dot');
          for (var i = 0; i < dots.length; i++) dots[i].classList.remove('on');
          d.classList.add('on');
        });
        // pointer 事件
        canvas.addEventListener('pointerdown', onDown);
        canvas.addEventListener('pointermove', onMove);
        canvas.addEventListener('pointerup', onUp);
        canvas.addEventListener('pointercancel', onUp);
        showColors();
      }

      function onDown(e) {
        if (e.button != null && e.button !== 0) return;
        var p = toPx(e);
        if (state.mode === 'crop') {
          dragging = hitTest(p);
          if (dragging) {
            dragging.x0 = p.x; dragging.y0 = p.y;
            dragging.sx0 = state.sel.x; dragging.sy0 = state.sel.y;
            dragging.sw = state.sel.w; dragging.sh = state.sel.h;
            e.preventDefault();
            canvas.setPointerCapture(e.pointerId);
          }
        } else if (state.mode === 'pen') {
          curPen = { c: state.color, pts: [p] };
          state.pens.push(curPen);
          e.preventDefault();
          canvas.setPointerCapture(e.pointerId);
          draw();
        }
      }

      function onMove(e) {
        if (!dragging && !curPen) return;
        var p = toPx(e);
        if (state.mode === 'crop' && dragging) {
          var s = state.sel;
          var dx = p.x - dragging.x0, dy = p.y - dragging.y0;
          if (dragging.type === 'move') {
            s.x = dragging.sx0 + dx; s.y = dragging.sy0 + dy;
          } else {
            var i = dragging.i, x2 = dragging.x0, y2 = dragging.y0;
            var nx = dragging.sx0 + dx, ny = dragging.sy0 + dy;
            var ox = dragging.sx0, oy = dragging.sy0;
            var L = dragging.sw, H = dragging.sh;
            if (i === 0) { s.x = nx; s.y = ny; s.w = ox + L - nx; s.h = oy + H - ny; }
            else if (i === 1) { s.y = ny; s.w = nx - ox; s.h = oy + H - ny; }
            else if (i === 2) { s.x = nx; s.w = ox + L - nx; s.h = ny - oy; }
            else { s.w = nx - ox; s.h = ny - oy; }
          }
          clampSel();
          draw();
        } else if (state.mode === 'pen' && curPen) {
          curPen.pts.push(p);
          draw();
        }
      }

      function onUp(e) {
        if (dragging || curPen) { e.preventDefault(); }
        dragging = null;
        curPen = null;
      }
    });
  }

  EATG.imgEditor = { open: open };
})();
