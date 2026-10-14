/* ==========================================================================
   一咕（EATG）· 拍照批量录入（js/batch_scan.js）
   能力：拍一张照片 → 检测/手动框选多个谷子区域 → 逐框裁剪 + OCR 智能预填
         （名称/IP/类型/角色，词表匹配）→ 生成 N 条草稿 → 跳转批量确认页。
   依赖（按需懒加载，联网可用；离线时仅手动框选批量录入可用）：
         TensorFlow.js + COCO-SSD（自动识别数量，辅助）
         Tesseract.js（OCR 中文，提取包装/吊牌文字）
   草稿：localStorage eatg_batch_draft（JSON，含逐框裁剪图 dataURL 与预填字段）
   ========================================================================== */
(function (global) {
  'use strict';

  var EATG = (global.EATG = global.EATG || {});
  var S = EATG.storage;
  var UI = EATG.ui;

  var BS = (EATG.batchScan = EATG.batchScan || {});

  var DRAFT_KEY = 'eatg_batch_draft';
  var MAX_BOXES = 9;

  var TYPE_WORDS = ['吧唧', '徽章', '立牌', '亚克力', '色纸', '挂件', '玩偶', '手办',
    '文件夹', '拍立得', '小卡', '闪卡', '透卡', '杯垫', '抱枕', '勋章', '胶片', '镭射票', '应援棒', '画集', '立绘'];
  var IP_WORDS = ['MyGO', 'BanG Dream', 'BanG Dream!', 'bangdream', '孤独摇滚', '新世纪福音战士', 'EVA',
    '间谍过家家', '咒术回战', '排球少年', '蓝锁', '进击的巨人', '鬼灭之刃', '初音未来', 'Vocaloid',
    '东方', '偶像大师', 'Love Live', 'lovelive', '魔法少女小圆', '物语系列', '少女歌剧', '邦邦'];

  // 运行时状态（单实例）
  var view = null;

  // ---- 词表匹配 ----

  function matchWords(text, words) {
    var t = String(text || '').toLowerCase();
    if (!t) return null;
    for (var i = 0; i < words.length; i++) {
      if (t.indexOf(String(words[i]).toLowerCase()) !== -1) return words[i];
    }
    return null;
  }

  function cleanText(s) {
    return String(s || '').replace(/[ \t\r\n]+/g, ' ').trim();
  }

  // ---- 外部脚本懒加载（仅识别功能需要；离线时手动框选不受影响） ----

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[src="' + src + '"]')) { resolve(); return; }
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('模型加载失败，请检查网络后重试')); };
      document.head.appendChild(s);
    });
  }

  var modelPromise = null;
  function loadDetectModel() {
    if (modelPromise) return modelPromise;
    modelPromise = loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js')
      .then(function () {
        return loadScript('https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js');
      })
      .then(function () {
        if (!global.cocoSsd) throw new Error('COCO-SSD 未就绪');
        return global.cocoSsd.load();
      });
    return modelPromise;
  }

  var ocrPromise = null;
  function loadOcr() {
    if (ocrPromise) return ocrPromise;
    ocrPromise = loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js')
      .then(function () {
        if (!global.Tesseract) throw new Error('Tesseract 未就绪');
        return global.Tesseract.createWorker('chi_sim+eng', 1, {
          logger: function (m) {
            if (m && m.status === 'recognizing text' && m.progress != null) {
              UI.toast('识别中 ' + Math.round(m.progress * 100) + '%');
            }
          }
        });
      });
    return ocrPromise;
  }

  // ---- 全屏弹层（不依赖 UI.sheet，便于画布交互） ----

  function openOverlay() {
    var el = document.createElement('div');
    el.className = 'bs-overlay';
    el.innerHTML =
      '<div class="bs-head">' +
        '<button type="button" class="bs-close" data-act="close" aria-label="关闭">×</button>' +
        '<span class="bs-title">拍照批量录入</span>' +
      '</div>' +
      '<div class="bs-stage">' +
        '<canvas class="bs-canvas"></canvas>' +
        '<div class="bs-empty">选择照片后，在此框选每个谷子<br><span class="bs-empty-sub">可点「自动识别数量」让模型先圈一遍</span></div>' +
      '</div>' +
      '<div class="bs-foot">' +
        '<button type="button" class="btn btn--secondary" data-act="pick">相册 / 拍照</button>' +
        '<button type="button" class="btn btn--secondary" data-act="auto">自动识别数量</button>' +
        '<button type="button" class="btn btn--secondary" data-act="del-box">删选中框</button>' +
        '<button type="button" class="btn btn--primary" data-act="gen">生成录入</button>' +
      '</div>';
    document.body.appendChild(el);
    return el;
  }

  // ---- 图片选择（动态 file input，视觉隐藏，兼容 iOS） ----

  function pickImage() {
    return new Promise(function (resolve) {
      var ref = UI.sheet({
        title: '选择照片',
        bodyHTML: '<div class="opt-list">' +
          '<button type="button" class="opt-row" data-src="camera"><span>拍照</span><span class="opt-check">›</span></button>' +
          '<button type="button" class="opt-row" data-src="album"><span>从相册选择</span><span class="opt-check">›</span></button>' +
          '</div>'
      });
      ref.body.addEventListener('click', function (e) {
        var b = e.target.closest('[data-src]');
        if (!b) return;
        ref.close();
        var input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.className = 'file-hidden';
        if (b.dataset.src === 'camera') input.setAttribute('capture', 'environment');
        document.body.appendChild(input);
        input.addEventListener('change', function () {
          var f = input.files && input.files[0];
          input.remove();
          resolve(f || null);
        });
        input.click();
      });
    });
  }

  // ---- 画布：框编辑 ----

  function fitRect(iw, ih, bw, bh) {
    var scale = Math.min(bw / iw, bh / ih);
    var w = iw * scale, h = ih * scale;
    return { x: (bw - w) / 2, y: (bh - h) / 2, w: w, h: h };
  }

  function draw() {
    var cv = view.canvas, ctx = view.ctx;
    var W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    if (!view.img) return;
    var fr = view.fit;
    ctx.drawImage(view.img, fr.x, fr.y, fr.w, fr.h);

    view.boxes.forEach(function (b, i) {
      var x = b.x * fr.w + fr.x, y = b.y * fr.h + fr.y;
      var w = b.w * fr.w, h = b.h * fr.h;
      var sel = i === view.sel;
      ctx.strokeStyle = sel ? '#FF6B6B' : '#4CC9F0';
      ctx.lineWidth = sel ? 3 : 2;
      ctx.fillStyle = sel ? 'rgba(255,107,107,0.15)' : 'rgba(76,201,240,0.10)';
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = sel ? '#FF6B6B' : '#4CC9F0';
      ctx.font = '12px sans-serif';
      ctx.fillText('#' + (i + 1), x + 4, y + 14);
      if (sel) {
        var s = 10;
        [[0, 0], [1, 0], [0, 1], [1, 1]].forEach(function (p) {
          ctx.fillRect(x + p[0] * w - s / 2, y + p[1] * h - s / 2, s, s);
        });
      }
    });
  }

  function evPos(e) {
    var r = view.canvas.getBoundingClientRect();
    var x = (e.clientX - r.left) / r.width;
    var y = (e.clientY - r.top) / r.height;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  }

  function hitTest(p) {
    var i = view.sel;
    if (i >= 0) {
      var b = view.boxes[i];
      var pad = 0.02;
      var handles = [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]];
      for (var k = 0; k < handles.length; k++) {
        if (Math.abs(p.x - handles[k][0]) < pad && Math.abs(p.y - handles[k][1]) < pad) {
          return { kind: 'resize', i: i, h: k };
        }
      }
      if (p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad) {
        return { kind: 'move', i: i };
      }
    }
    for (var j = view.boxes.length - 1; j >= 0; j--) {
      var c = view.boxes[j];
      if (p.x >= c.x && p.x <= c.x + c.w && p.y >= c.y && p.y <= c.y + c.h) {
        return { kind: 'move', i: j };
      }
    }
    return null;
  }

  function bindCanvas() {
    var cv = view.canvas;
    var down = null;
    function onDown(e) {
      e.preventDefault();
      var p = evPos(e);
      var hit = hitTest(p);
      if (!hit) {
        view.sel = -1;
        draw();
        return;
      }
      view.sel = hit.i;
      down = { kind: hit.kind, h: hit.h, start: p, box: {
        x: view.boxes[hit.i].x, y: view.boxes[hit.i].y,
        w: view.boxes[hit.i].w, h: view.boxes[hit.i].h
      } };
      draw();
    }
    function onMove(e) {
      if (!down) return;
      e.preventDefault();
      var p = evPos(e);
      var b = view.boxes[down.i];
      if (down.kind === 'move') {
        var dx = p.x - down.start.x, dy = p.y - down.start.y;
        b.x = Math.min(1 - b.w, Math.max(0, down.box.x + dx));
        b.y = Math.min(1 - b.h, Math.max(0, down.box.y + dy));
      } else {
        var s = down.box, h = down.h;
        var nx = s.x, ny = s.y, nw = s.w, nh = s.h;
        if (h === 0 || h === 1) { nx = Math.min(s.x + s.w - 0.03, p.x); nw = s.w + (s.x - nx); }
        if (h === 2 || h === 3) { nw = Math.max(0.03, p.x - s.x); }
        if (h === 0 || h === 2) { ny = Math.min(s.y + s.h - 0.03, p.y); nh = s.h + (s.y - ny); }
        if (h === 1 || h === 3) { nh = Math.max(0.03, p.y - s.y); }
        b.x = nx; b.y = ny; b.w = nw; b.h = nh;
      }
      draw();
    }
    function onUp() { down = null; }
    cv.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    view._handlers = [onDown, onMove, onUp];
  }

  function unbindCanvas() {
    if (!view) return;
    var cv = view.canvas;
    if (cv) cv.removeEventListener('pointerdown', view._handlers[0]);
    window.removeEventListener('pointermove', view._handlers[1]);
    window.removeEventListener('pointerup', view._handlers[2]);
    view._handlers = null;
  }

  // ---- 自动识别数量（COCO-SSD，联网辅助） ----

  function autoDetect() {
    if (!view || !view.img) { UI.toast('请先选择照片', 'error'); return; }
    UI.toast('正在加载识别模型（首次约 10MB，请稍候）…');
    loadDetectModel().then(function (model) {
      return model.detect(view.img);
    }).then(function (preds) {
      if (!view || view.destroyed) return;
      var fr = view.fit;
      var keep = (preds || []).filter(function (p) { return p.score >= 0.5; });
      // 过滤掉明显占据整图的大框（很可能是背景误检）
      keep = keep.filter(function (p) {
        return (p.bbox[2] * p.bbox[3]) < 0.6;
      });
      if (!keep.length) {
        UI.toast('没有识别到明显的物体，可手动框选', 'info');
        return;
      }
      var prev = view.boxes.length;
      keep.forEach(function (p) {
        if (view.boxes.length >= MAX_BOXES) return;
        view.boxes.push({
          x: Math.max(0, Math.min(1, p.bbox[0] / view.img.naturalWidth)),
          y: Math.max(0, Math.min(1, p.bbox[1] / view.img.naturalHeight)),
          w: Math.max(0.03, Math.min(1, p.bbox[2] / view.img.naturalWidth)),
          h: Math.max(0.03, Math.min(1, p.bbox[3] / view.img.naturalHeight))
        });
      });
      view.sel = -1;
      draw();
      UI.toast('已自动圈出 ' + (view.boxes.length - prev) + ' 个区域（' + view.boxes.length + '/9），可拖动/缩放手柄修正', 'success');
    }).catch(function (err) {
      console.error('[EATG] 自动识别失败', err);
      UI.toast('自动识别失败：' + (err && err.message || err), 'error');
    });
  }

  // ---- 裁剪 + OCR + 预填 ----

  function cropBox(img, box, targetMax) {
    var iw = img.naturalWidth, ih = img.naturalHeight;
    var bw = Math.max(1, box.w * iw), bh = Math.max(1, box.h * ih);
    var bx = Math.max(0, Math.min(iw - bw, box.x * iw));
    var by = Math.max(0, Math.min(ih - bh, box.y * ih));
    var scale = Math.min(1, targetMax / Math.max(bw, bh));
    var cw = Math.max(1, Math.round(bw * scale)), ch = Math.max(1, Math.round(bh * scale));
    var cv = document.createElement('canvas');
    cv.width = cw; cv.height = ch;
    var cx = cv.getContext('2d');
    cx.drawImage(img, bx, by, bw, bh, 0, 0, cw, ch);
    return cv.toDataURL('image/jpeg', 0.8);
  }

  function suggestItem(ocrText) {
    var t = cleanText(ocrText);
    var low = t.toLowerCase();
    var type = matchWords(t, TYPE_WORDS) || '';
    var ip = matchWords(t, view.ipWords) || '';
    var charIds = view.characters.filter(function (c) {
      return c.name && low.indexOf(String(c.name).toLowerCase()) !== -1;
    }).map(function (c) { return Number(c.id); });

    var name = '';
    if (charIds.length && type) {
      // 用第一个匹配角色 + 类型拼名称
      var chName = '';
      view.characters.forEach(function (c) { if (Number(c.id) === charIds[0]) chName = c.name; });
      name = chName + ' ' + type;
    } else if (charIds.length) {
      var chName2 = '';
      view.characters.forEach(function (c) { if (Number(c.id) === charIds[0]) chName2 = c.name; });
      name = chName2;
    } else if (type) {
      name = type;
    } else {
      name = t.slice(0, 20);
    }

    return { name: name, ip: ip, type: type, charIds: charIds };
  }

  function generate() {
    if (!view || !view.img) { UI.toast('请先选择照片', 'error'); return; }
    if (!view.boxes.length) { UI.toast('请先框选至少一个谷子区域', 'error'); return; }
    if (view.boxes.length > MAX_BOXES) { UI.toast('最多 ' + MAX_BOXES + ' 个区域', 'error'); return; }

    var items = [];
    var chain = Promise.resolve();
    view.boxes.forEach(function (box, i) {
      chain = chain.then(function () {
        var img = cropBox(view.img, box, 800);
        if (view.useOcr) {
          return loadOcr().then(function (worker) {
            UI.toast('正在识别第 ' + (i + 1) + ' / ' + view.boxes.length + ' 个区域…');
            return worker.recognize(img).then(function (res) {
              var text = cleanText(res && res.data && res.data.text);
              var sug = suggestItem(text);
              items.push({ image: img, ocrText: text, name: sug.name, ip: sug.ip, type: sug.type, charIds: sug.charIds, qty: 1 });
            });
          }).catch(function (err) {
            console.error('[EATG] OCR 失败', err);
            items.push({ image: img, ocrText: '', name: '', ip: '', type: '', charIds: [], qty: 1 });
            UI.toast('OCR 不可用（' + (err && err.message || err) + '），已按手动框选生成', 'error');
          });
        }
        items.push({ image: img, ocrText: '', name: '', ip: '', type: '', charIds: [], qty: 1 });
        return null;
      });
    });

    chain.then(function () {
      if (!view || view.destroyed) return;
      try {
        global.localStorage.setItem(DRAFT_KEY, JSON.stringify({ ts: Date.now(), items: items }));
      } catch (e) {
        UI.toast('草稿保存失败（图片过多？），请减少框选数量', 'error');
        return;
      }
      close();
      if (EATG.app && EATG.app.navigate) EATG.app.navigate('#/goods/batch');
      else global.location.hash = '#/goods/batch';
    });
  }

  // ---- 弹层生命周期 ----

  function close() {
    if (!view) return;
    view.destroyed = true;
    unbindCanvas();
    if (view.el && view.el.parentNode) view.el.parentNode.removeChild(view.el);
    view = null;
  }

  BS.open = function () {
    if (view) return;
    var el = openOverlay();
    view = {
      el: el, canvas: el.querySelector('.bs-canvas'), boxes: [], sel: -1,
      img: null, fit: null, destroyed: false, characters: [], ipWords: IP_WORDS.slice(),
      useOcr: true, _handlers: null
    };
    var ctx = view.canvas.getContext('2d');
    view.ctx = ctx;

    pickImage().then(function (file) {
      if (!file) { close(); return; }
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        if (view && view.destroyed) return;
        view.img = img;
        var fr = fitRect(img.naturalWidth, img.naturalHeight, view.canvas.clientWidth, view.canvas.clientHeight);
        view.fit = fr;
        view.canvas.width = view.canvas.clientWidth;
        view.canvas.height = view.canvas.clientHeight;
        view.boxes = [];
        view.sel = -1;
        var empty = view.el.querySelector('.bs-empty');
        if (empty) empty.style.display = 'none';
        draw();
      };
      img.onerror = function () { URL.revokeObjectURL(url); UI.toast('图片读取失败', 'error'); };
      img.src = url;
    });

    // 载入词表（角色/IP 枚举，用于预填匹配）
    S.getAll('characters').then(function (chars) {
      if (!view || view.destroyed) return;
      view.characters = chars || [];
      return S.getAll('enums');
    }).then(function (rows) {
      if (!view || view.destroyed) return;
      (rows || []).forEach(function (row) {
        if (row.key === 'ip') {
          (row.values || []).forEach(function (v) {
            if (view.ipWords.indexOf(v) === -1) view.ipWords.push(v);
          });
        }
      });
    }).catch(function (err) { console.error('[EATG] 词表加载失败', err); });

    bindCanvas();

    el.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'close') close();
      else if (b.dataset.act === 'pick') {
        close();
        BS.open();
      } else if (b.dataset.act === 'auto') autoDetect();
      else if (b.dataset.act === 'del-box') {
        if (view && view.sel >= 0) {
          view.boxes.splice(view.sel, 1);
          view.sel = -1;
          draw();
        } else {
          UI.toast('请先点选一个框再删除', 'info');
        }
      }
      else if (b.dataset.act === 'gen') generate();
    });

    // 空态点击画布 → 添加默认框（方便快速开始）
    view.canvas.addEventListener('dblclick', function (e) {
      if (!view || !view.img || view.boxes.length >= MAX_BOXES) return;
      var p = evPos(e);
      view.boxes.push({ x: Math.max(0, p.x - 0.15), y: Math.max(0, p.y - 0.2), w: 0.3, h: 0.4 });
      view.sel = view.boxes.length - 1;
      draw();
    });
  };

  BS.hasDraft = function () {
    try { return !!global.localStorage.getItem(DRAFT_KEY); } catch (e) { return false; }
  };

})(window);
