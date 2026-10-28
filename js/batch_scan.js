/* ==========================================================================
   一咕（EATG）· 拍照批量录入（js/batch_scan.js）
   能力：拍/选一张照片 → 「自动识别」用本地 OCR 找出包装/吊牌文字区并生成 N 个框
         （框可拖动/缩放/删除/双击新增）→ 逐框裁剪 + OCR → 关键词命中自动预填
         （名称/IP/类型/角色）→ 生成 N 条草稿 → 跳转批量确认页。
   OCR：本地内置 Tesseract.js（vendor/tesseract + vendor/tessdata），完全离线，无外链。
   说明：物体计数 / 角色识别需自训练模型（见 app/docs/交付说明.md「需训练模型」），
         本文件预留扩展点 BS.setDetector()，接入后自动识别会额外产出物体框。
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
  var OCR_MAX_EDGE = 1280;   // 整图识别时的最长边（兼顾速度与精度）
  var CROP_MAX_EDGE = 800;   // 单框裁剪图最长边（草稿体积与 OCR 精度平衡）
  var OCR_MIN_CONF = 40;     // 词置信度阈值

  // ---- 本地 OCR 资源（相对本页 baseURI 解析为绝对地址，避免 worker 内相对路径歧义） ----
  var VENDOR_BASE = (function () {
    try { return new URL('vendor/', document.baseURI).href; }
    catch (e) { return 'vendor/'; }
  })();
  var TESS = {
    lib: VENDOR_BASE + 'tesseract/tesseract.min.js',
    worker: VENDOR_BASE + 'tesseract/worker.min.js',
    coreSimd: VENDOR_BASE + 'tesseract/tesseract-core-simd-lstm.wasm.js',
    core: VENDOR_BASE + 'tesseract/tesseract-core-lstm.wasm.js',
    lang: VENDOR_BASE + 'tessdata'
  };

  // ---- 关键词词表 ----
  // 类型同义词 → 规范中文名（同时会优先匹配用户自定义的 enums.goods_type）
  var TYPE_SYNONYMS = [
    { canon: '吧唧', words: ['缶バッジ', 'バッジ缶', '缶バッチ', 'バッチ缶', '吧唧', '徽章', '圆形徽章', 'badge', 'can badge', 'グッズ缶'] },
    { canon: '立牌', words: ['アクリルスタンド', 'スタンドアクリル', 'アクスタ', '亚克力立牌', '立牌', '亚克力', 'acrylic stand', 'acrylic'] },
    { canon: '挂件', words: ['ラバーストラップ', 'ストラップラバー', 'キーホルダー', '橡胶挂件', '挂件', '钥匙扣', '挂饰', 'rubber strap', 'keychain'] },
    { canon: '文件夹', words: ['クリアファイル', 'ファイルクリア', '文件夹', 'clear file', 'file folder'] },
    { canon: '色纸', words: ['色紙', '紙色', '色纸', 'shikishi'] },
    { canon: '拍立得', words: ['ブロマイド', 'マイドブロ', '拍立得', 'bromide'] },
    { canon: '小卡', words: ['トレーディングカード', 'カードトレーディング', '小卡', '闪卡', '卡片', '卡牌', 'trading card'] },
    { canon: '透卡', words: ['クリアカード', 'カードクリア', '透卡', '透明卡'] },
    { canon: '镭射票', words: ['レーザーチケット', '镭射票', '激光票'] },
    { canon: '杯垫', words: ['コースター', 'スターコー', '杯垫', 'coaster'] },
    { canon: '马克杯', words: ['マグカップ', 'カップマグ', '马克杯', 'mug'] },
    { canon: '挂布', words: ['タペストリー', 'ストリータペ', '挂布', '布画', '挂画', 'tapestry'] },
    { canon: '抱枕', words: ['抱き枕', '枕き抱', '抱枕', '靠垫', 'cushion'] },
    { canon: '玩偶', words: ['ぬいぐるみ', 'ぐるみぬい', 'ぬい', '玩偶', '娃娃', '毛绒', 'plush'] },
    { canon: '手办', words: ['フィギュア', 'ギュアフィ', '手办', 'figure'] },
    { canon: '应援棒', words: ['ペンライト', '应援棒', '荧光棒', 'penlight'] },
    { canon: '画集', words: ['画集', '画册', 'art book', 'artbook'] },
    { canon: '胶片', words: ['クリアファイル', '胶片', 'フィルム'] }
  ];

  // IP 同义词 → 规范名（会优先映射到用户 enums.ip 中已有的项）
  var IP_SYNONYMS = [
    { canon: 'MyGO', words: ['mygo!!!!!', 'mygo', 'マイゴ', '迷星叫'] },
    { canon: '邦邦', words: ['bang dream!', 'bang dream', 'bangdream', 'バンドリ', 'bandori', '邦ドリ'] },
    { canon: '孤独摇滚', words: ['ぼっち・ざ・ろっく', 'bocchi', 'ぼざろ', '孤独摇滚'] },
    { canon: '初音未来', words: ['初音ミク', 'hatsune miku', 'vocaloid', '初音未来'] },
    { canon: '无期迷途', words: ['无期迷途', 'path to nowhere'] },
    { canon: '间谍过家家', words: ['spy family', 'spy×family', '间谍过家家'] },
    { canon: '咒术回战', words: ['呪術廻戦', 'jujutsu kaisen', '咒术回战'] }
  ];

  // 运行时状态（单实例）
  var view = null;

  // ---- 文本工具 ----

  function cleanText(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function normText(s) { return String(s || '').toLowerCase().replace(/\s+/g, ''); }

  function matchWords(normedText, words, rawWords) {
    if (!normedText) return null;
    for (var i = 0; i < words.length; i++) {
      if (normedText.indexOf(words[i]) !== -1) return rawWords ? rawWords[i] : words[i];
    }
    return null;
  }

  // ---- 本地 OCR 引擎（懒加载 + 单例） ----

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[data-eatg-src="' + src + '"]')) { resolve(); return; }
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.setAttribute('data-eatg-src', src);
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('本地 OCR 库加载失败：' + src)); };
      document.head.appendChild(s);
    });
  }

  function simdSupported() {
    try {
      return WebAssembly.validate(new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0,
        10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11
      ]));
    } catch (e) { return false; }
  }

  var ocrPromise = null;
  function loadOcr() {
    if (ocrPromise) return ocrPromise;
    ocrPromise = loadScript(TESS.lib).then(function () {
      if (!global.Tesseract) throw new Error('Tesseract 未就绪');
      var core = simdSupported() ? TESS.coreSimd : TESS.core;
      setProgress('正在启动识别引擎…', 5);
      return global.Tesseract.createWorker('chi_sim+eng+jpn', 1, {
        workerPath: TESS.worker,
        corePath: core,
        langPath: TESS.lang,
        gzip: false,   // 直接读取未压缩的 .traineddata
        logger: function (m) {
          if (!m || m.progress == null) return;
          if (m.status === 'loading tesseract core') setProgress('加载识别核心…', m.progress);
          else if (m.status === 'loading language traineddata') setProgress('加载中文语言包…', m.progress);
          else if (m.status === 'initializing tesseract') setProgress('初始化引擎…', m.progress);
        }
      });
    }).catch(function (err) {
      ocrPromise = null;   // 允许重试
      throw err;
    });
    return ocrPromise;
  }

  function terminateOcr() {
    if (!ocrPromise) return;
    ocrPromise.then(function (w) { try { w.terminate(); } catch (e) {} }).catch(function () {});
    ocrPromise = null;
  }

  // ---- 全屏弹层 ----

  function openOverlay() {
    var el = document.createElement('div');
    el.className = 'bs-overlay';
    el.innerHTML =
      '<div class="bs-head">' +
        '<button type="button" class="bs-close" data-act="close" aria-label="关闭">×</button>' +
        '<span class="bs-title">拍照批量录入</span>' +
      '</div>' +
      '<div class="bs-progress" hidden><span class="bs-progress-text"></span>' +
        '<span class="bs-progress-bar"><i></i></span></div>' +
      '<div class="bs-stage">' +
        '<canvas class="bs-canvas"></canvas>' +
        '<div class="bs-empty">点下方「相册 / 拍照」选择照片<br><span class="bs-empty-sub">选图后点「自动识别」：已配视觉Key自动圈出谷子，否则识别吊牌/包装文字区；也可双击画面手动加框</span></div>' +
      '</div>' +
      '<div class="bs-foot">' +
        '<button type="button" class="btn btn--secondary" data-act="pick">相册 / 拍照</button>' +
        '<button type="button" class="btn btn--secondary" data-act="auto">自动识别</button>' +
        '<button type="button" class="btn btn--secondary" data-act="del-box">删选中框</button>' +
        '<button type="button" class="btn btn--primary" data-act="gen">生成录入</button>' +
      '</div>';
    document.body.appendChild(el);
    return el;
  }

  function setProgress(text, pct) {
    if (!view || !view.el) return;
    var box = view.el.querySelector('.bs-progress');
    if (!box) return;
    if (text == null) { box.hidden = true; return; }
    box.hidden = false;
    var t = box.querySelector('.bs-progress-text');
    if (t) t.textContent = text;
    var i = box.querySelector('.bs-progress-bar i');
    if (i) i.style.width = Math.round(Math.max(0, Math.min(1, pct || 0)) * 100) + '%';
  }

  function setBusy(b) {
    if (!view || !view.el) return;
    var foot = view.el.querySelector('.bs-foot');
    if (!foot) return;
    Array.prototype.forEach.call(foot.querySelectorAll('button'), function (btn) {
      if (btn.dataset.act === 'close') return;
      btn.disabled = !!b;
    });
  }

  // ---- 图片选择 ----

  function loadFile(file) {
    if (!file || !view || view.destroyed) return;
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      if (view && view.destroyed) return;
      view.img = img;
      view.fit = fitRect(img.naturalWidth, img.naturalHeight, view.canvas.clientWidth, view.canvas.clientHeight);
      view.canvas.width = view.canvas.clientWidth;
      view.canvas.height = view.canvas.clientHeight;
      view.boxes = [];
      view.sel = -1;
      var empty = view.el.querySelector('.bs-empty');
      if (empty) empty.style.display = 'none';
      var opts = view.el.querySelector('.bs-pick-options');
      if (opts) opts.style.display = 'none';
      draw();
    };
    img.onerror = function () { URL.revokeObjectURL(url); UI.toast('图片读取失败', 'error'); };
    img.src = url;
  }

  /** 编辑后的 dataUrl 加载进画布（与 loadFile 相同流程） */
  function loadDataUrl(dataUrl) {
    if (!dataUrl || !view || view.destroyed) return;
    var img = new Image();
    img.onload = function () {
      if (view && view.destroyed) return;
      view.img = img;
      view.fit = fitRect(img.naturalWidth, img.naturalHeight, view.canvas.clientWidth, view.canvas.clientHeight);
      view.canvas.width = view.canvas.clientWidth;
      view.canvas.height = view.canvas.clientHeight;
      view.boxes = [];
      view.sel = -1;
      var empty = view.el.querySelector('.bs-empty');
      if (empty) empty.style.display = 'none';
      var opts = view.el.querySelector('.bs-pick-options');
      if (opts) opts.style.display = 'none';
      draw();
    };
    img.onerror = function () { UI.toast('图片读取失败', 'error'); };
    img.src = dataUrl;
  }

  function showPickOptions() {
    if (!view || view.destroyed) return;
    var opts = view.el.querySelector('.bs-pick-options');
    if (!opts) {
      opts = document.createElement('div');
      opts.className = 'bs-pick-options';
      opts.innerHTML = '<div class="opt-list">' +
        '<button type="button" class="opt-row opt-row--file" data-src="camera">' +
          '<span class="opt-row-btn">拍照</span>' +
          '<input type="file" style="display:none" accept="image/*" capture="environment">' +
          '<span class="opt-check">›</span></button>' +
        '<button type="button" class="opt-row opt-row--file" data-src="album">' +
          '<span class="opt-row-btn">从相册选择</span>' +
          '<input type="file" style="display:none" accept="image/*" multiple>' +
          '<span class="opt-check">›</span></button>' +
        '</div>';
      view.el.appendChild(opts);
      opts.addEventListener('change', function (e) {
        var inp = e.target.closest('input[type=file]');
        if (!inp) return;
        var file = inp.files && inp.files[0];
        inp.value = '';
        if (!file) return;
        // 批量录入选图直接进画布（不再在此弹旋转/裁剪编辑器，避免手机端卡住）
        // 照片裁正/旋转在生成录入后的确认页、或谷子详情页再做
        UI.toast('正在载入照片…', 'info');
        loadFile(file);
      });
      opts.addEventListener('click', function (e) {
        var row = e.target.closest('.opt-row--file');
        if (!row) return;
        var inp = row.querySelector('input[type=file]');
        if (!inp) return;
        try { inp.click(); } catch (err) { console.error('[EATG] 选图触发失败', err); }
      });
    }
    opts.style.display = 'block';
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
      if (view.busy) return;
      var p = evPos(e);
      var hit = hitTest(p);
      if (!hit) { view.sel = -1; draw(); return; }
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
      // 手动改动后该框的 OCR 文本作废，生成时重新识别
      b.text = null;
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

  // ---- 自动识别：本地 OCR → 文字区聚类 → 生成框 ----

  /** 解析 Tesseract TSV 词表，按 块-段 聚合成文字区（含包围框与文本） */
  function regionsFromTsv(tsv, imgW, imgH) {
    var groups = {};
    String(tsv || '').split('\n').forEach(function (line) {
      var c = line.split('\t');
      if (c.length < 12) return;
      if (Number(c[0]) !== 5) return;                 // level 5 = 词
      var conf = Number(c[10]);
      var text = String(c[11] || '').trim();
      if (!text || !(conf >= OCR_MIN_CONF)) return;
      var key = c[2] + '-' + c[3];                    // block-par
      var g = groups[key] || (groups[key] = { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9, words: [] });
      var x = Number(c[6]), y = Number(c[7]), w = Number(c[8]), h = Number(c[9]);
      g.x0 = Math.min(g.x0, x); g.y0 = Math.min(g.y0, y);
      g.x1 = Math.max(g.x1, x + w); g.y1 = Math.max(g.y1, y + h);
      g.words.push({ text: text, x: x, y: y });
    });
    var out = [];
    Object.keys(groups).forEach(function (k) {
      var g = groups[k];
      if (g.x1 <= g.x0 || g.y1 <= g.y0) return;
      g.words.sort(function (a, b) { return (a.y - b.y) || (a.x - b.x); });
      var x = g.x0 / imgW, y = g.y0 / imgH;
      var bw = (g.x1 - g.x0) / imgW, bh = (g.y1 - g.y0) / imgH;
      var area = bw * bh;
      if (area < 0.002 || area > 0.85) return;        // 过小噪声 / 过大整图
      out.push({ x: x, y: y, w: bw, h: bh, text: g.words.map(function (w) { return w.text; }).join('') });
    });
    out.sort(function (a, b) { return (a.y - b.y) || (a.x - b.x); });   // 阅读顺序
    return out.slice(0, MAX_BOXES);
  }

  function autoDetect() {
    if (!view || !view.img) { UI.toast('请先选择照片', 'error'); return; }
    if (view.busy) return;
    view.busy = true;
    setBusy(true);

    var cut = cropBox(view.img, { x: 0, y: 0, w: 1, h: 1 }, 1920);

    // 优先：视觉大模型「数个数 + 给框」（已在设置页配置 Key 时）
    setProgress('正在调用视觉识别…', 10);
    Promise.resolve(EATG.vision && EATG.vision.detectBoxes(cut.url, cut.w, cut.h) || Promise.reject({ code: 'NO_KEY' }))
      .then(function (boxes) {
        if (!view || view.destroyed) return;
        if (!boxes || !boxes.length) {
          UI.toast('未圈出谷子，可双击画面手动加框', 'info');
          return;
        }
        view.boxes = boxes.map(function (b) { return { x: b.x, y: b.y, w: b.w, h: b.h, text: null }; });
        view.useOcr = false;   // 出框模式：不再跑 OCR，名称/IP/类型在确认页自己填
        view.sel = -1;
        draw();
        UI.toast('已自动圈出 ' + view.boxes.length + ' 个谷子，可拖动/缩放修正后点「生成录入」', 'success');
      })
      .catch(function (err) {
        // 回退：本地 OCR 文字区识别（未配 Key 或视觉服务失败时）
        var msg = (err && err.message) || String(err);
        if (err && err.code === 'NO_KEY') {
          alert('【视觉识别】还没配 Key\n\n去「我的 → 设置 → 视觉识别」填智谱 Key 后才能自动数谷子。\n现在回退到本地吊牌文字识别。');
        } else {
          console.warn('[EATG] 视觉出框失败，回退本地 OCR', err);
          alert('【视觉识别调用失败】\n\n错误：' + msg + (err && err.status ? ('\nHTTP ' + err.status) : '') + '\n\n可能原因：\n1. 模型名不对（应填 glm-4.1v-thinking-flash）\n2. Key 错或没余额\n3. 网络不通\n\n现在回退到本地吊牌文字识别。');
        }
        return ocrFallback();
      })
      .then(function () {
        if (!view || view.destroyed) return;
        view.busy = false;
        setBusy(false);
        setProgress(null);
      });

    function ocrFallback() {
      setProgress('正在准备识别引擎…', 3);
      return loadOcr().then(function (worker) {
        setProgress('正在识别吊牌/包装文字…', 30);
        return worker.recognize(cut.url);
      }).then(function (res) {
        if (!view || view.destroyed) return;
        var tsv = (res && res.data && res.data.tsv) || '';
        var regions = regionsFromTsv(tsv, cut.w, cut.h);
        view.useOcr = true;
        var prev = view.boxes.length;
        regions.forEach(function (r) {
          if (view.boxes.length >= MAX_BOXES) return;
          view.boxes.push({ x: r.x, y: r.y, w: r.w, h: r.h, text: r.text });
        });
        view.sel = -1;
        draw();
        if (regions.length) UI.toast('已识别 ' + regions.length + ' 个文字区，可拖动/缩放修正', 'success');
        else UI.toast('未识别到文字，可双击画面手动加框', 'info');
      }).catch(function (err2) {
        console.error('[EATG] 本地 OCR 失败', err2);
        UI.toast('识别失败：' + (err2 && err2.message || err2), 'error');
      });
    }
  }

  // ---- 裁剪 ----

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
    return { url: cv.toDataURL('image/jpeg', 0.9), w: cw, h: ch };
  }

  // ---- 关键词预填 ----

  /** 在词表中查同义词，返回规范名（未命中返回 ''） */
  function synLookup(n, table) {
    for (var i = 0; i < table.length; i++) {
      if (matchWords(n, table[i].words.map(normText))) return table[i].canon;
    }
    return '';
  }

  /** 把规范名映射到用户已有枚举项（先精确、后包含；未命中返回 ''） */
  function resolveEnum(canon, values) {
    if (!canon) return '';
    var nc = normText(canon), i;
    for (i = 0; i < values.length; i++) if (normText(values[i]) === nc) return values[i];
    for (i = 0; i < values.length; i++) if (normText(values[i]).indexOf(nc) !== -1) return values[i];
    return '';
  }

  function suggestItem(ocrText) {
    var t = cleanText(ocrText);
    var n = normText(t);
    var enumTypes = (view.enums && view.enums.goods_type) || [];
    var enumIps = (view.enums && view.enums.ip) || [];

    // 类型：① 直接命中用户枚举 → ② 同义词规范名 → ③ 规范名映射到枚举（吧唧→徽章（吧唧））
    var type = matchWords(n, enumTypes.map(normText), enumTypes);
    if (!type) {
      var tc = synLookup(n, TYPE_SYNONYMS);
      if (tc) type = resolveEnum(tc, enumTypes) || tc;
    }

    // IP：① 直接命中用户枚举 → ② 同义词规范名 → ③ 映射到枚举（BanG Dream→邦邦）
    var ip = matchWords(n, enumIps.map(normText), enumIps);
    if (!ip) {
      var ic = synLookup(n, IP_SYNONYMS);
      if (ic) ip = resolveEnum(ic, enumIps) || (enumIps.length ? '' : ic);   // 枚举非空时不塞不存在的值
    }

    // 角色（附加能力；后续角色识别由深度学习模型接管）
    var chars = view.characters || [];
    var charIds = chars.filter(function (c) {
      return c.name && n.indexOf(normText(c.name)) !== -1;
    }).map(function (c) { return Number(c.id); });
    var firstChar = '';
    if (charIds.length) {
      chars.forEach(function (c) { if (Number(c.id) === charIds[0]) firstChar = c.name; });
    }

    // 名称：角色 + 类型 → 角色 → 类型 → 原文前 20 字
    var name = '';
    if (firstChar && type) name = firstChar + ' ' + type;
    else if (firstChar) name = firstChar;
    else if (type) name = type;
    else name = t.slice(0, 20);

    return { name: name, ip: ip, type: type, charIds: charIds };
  }

  function emptyItem(imageUrl) {
    return { image: imageUrl, ocrText: '', name: '', ip: '', type: '', charIds: [], qty: 1, status: 'on_hand' };
  }

  function finalizeItem(cut, text) {
    var sug = suggestItem(text);
    return {
      image: cut.url, ocrText: text,
      name: sug.name, ip: sug.ip, type: sug.type, charIds: sug.charIds,
      qty: 1, status: 'on_hand'
    };
  }

  // ---- 生成草稿 ----

  function generate() {
    if (!view || !view.img) { UI.toast('请先选择照片', 'error'); return; }
    if (!view.boxes.length) { UI.toast('请先框选至少一个谷子区域', 'error'); return; }
    if (view.boxes.length > MAX_BOXES) { UI.toast('最多 ' + MAX_BOXES + ' 个区域', 'error'); return; }
    if (view.busy) return;
    view.busy = true;
    setBusy(true);

    var boxes = view.boxes.slice();
    var items = new Array(boxes.length);
    var chain = Promise.resolve();

    boxes.forEach(function (box, i) {
      chain = chain.then(function () {
        var cut = cropBox(view.img, box, CROP_MAX_EDGE);
        if (!view.useOcr) { items[i] = emptyItem(cut.url); return null; }
        if (box.text != null && box.text !== '') { items[i] = finalizeItem(cut, box.text); return null; }
        return loadOcr().then(function (worker) {
          setProgress('识别第 ' + (i + 1) + '/' + boxes.length + ' 个区域…', 0.3 + 0.7 * (i / boxes.length));
          return worker.recognize(cut.url).then(function (res) {
            var text = cleanText(res && res.data && res.data.text);
            items[i] = finalizeItem(cut, text);
          });
        }).catch(function (err) {
          console.error('[EATG] 第 ' + (i + 1) + ' 个区域 OCR 失败', err);
          items[i] = emptyItem(cut.url);
          UI.toast('第 ' + (i + 1) + ' 个区域 OCR 失败，已保留图片', 'error');
        });
      });
    });

    chain.then(function () {
      if (!view || view.destroyed) return;
      try {
        global.localStorage.setItem(DRAFT_KEY, JSON.stringify({ ts: Date.now(), items: items }));
      } catch (e) {
        UI.toast('草稿保存失败（图片过多？），请减少框选数量', 'error');
        view.busy = false; setBusy(false); setProgress(null);
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
    terminateOcr();
    unbindCanvas();
    if (view.el && view.el.parentNode) view.el.parentNode.removeChild(view.el);
    view = null;
  }

  BS.open = function () {
    if (view) return;
    var el = openOverlay();
    view = {
      el: el, canvas: el.querySelector('.bs-canvas'), boxes: [], sel: -1,
      img: null, fit: null, destroyed: false, busy: false,
      characters: [], enums: { ip: [], goods_type: [] },
      detector: BS._detector, useOcr: true, _handlers: null
    };
    view.ctx = view.canvas.getContext('2d');

    // 载入词表（角色 + IP/类型枚举，用于预填匹配）
    S.getAll('characters').then(function (chars) {
      if (!view || view.destroyed) return;
      view.characters = chars || [];
      return S.getAll('enums');
    }).then(function (rows) {
      if (!view || view.destroyed) return;
      (rows || []).forEach(function (row) {
        if (row.key === 'ip') view.enums.ip = row.values || [];
        else if (row.key === 'goods_type') view.enums.goods_type = row.values || [];
      });
    }).catch(function (err) { console.error('[EATG] 词表加载失败', err); });

    bindCanvas();

    el.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'close') close();
      else if (b.dataset.act === 'pick') showPickOptions();
      else if (b.dataset.act === 'auto') autoDetect();
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

    // 双击画面 → 手动添加一个默认框
    view.canvas.addEventListener('dblclick', function (e) {
      if (!view || !view.img || view.busy || view.boxes.length >= MAX_BOXES) return;
      var p = evPos(e);
      view.boxes.push({ x: Math.max(0, p.x - 0.15), y: Math.max(0, p.y - 0.2), w: 0.3, h: 0.4, text: null });
      view.sel = view.boxes.length - 1;
      draw();
    });
  };

  // ---- 多选相册批量：每张照片 = 1 个谷子草稿 ----

  /** 读取并压缩图片文件 → dataURL（最长边 maxEdge，JPEG 0.75） */
  function compressFile(file, maxEdge) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var iw = img.naturalWidth, ih = img.naturalHeight;
        var scale = Math.min(1, (maxEdge || 800) / Math.max(iw, ih));
        var cw = Math.max(1, Math.round(iw * scale)), ch = Math.max(1, Math.round(ih * scale));
        var cv = document.createElement('canvas');
        cv.width = cw; cv.height = ch;
        cv.getContext('2d').drawImage(img, 0, 0, cw, ch);
        resolve(cv.toDataURL('image/jpeg', 0.75));
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
      img.src = url;
    });
  }

  /** 多选相册批量生成：一次选 N 张照片，每张生成 1 条谷子草稿（名称/IP/类型留待确认页补齐） */
  BS.openMulti = function () {
    if (view) { UI.toast('请先关闭当前批量录入', 'info'); return; }
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.multiple = true;
    inp.addEventListener('change', function () {
      var files = Array.prototype.slice.call(inp.files || []);
      if (!files.length) return;
      if (files.length > 9) { UI.toast('一次最多 9 张，请分批选择', 'error'); return; }
      UI.toast('正在处理 ' + files.length + ' 张照片…', 'info');
      var items = new Array(files.length);
      var chain = Promise.resolve();
      files.forEach(function (f, i) {
        chain = chain.then(function () {
          return compressFile(f, 800).then(function (dataUrl) {
            items[i] = { image: dataUrl, ocrText: '', name: '', ip: '', type: '', charIds: [], qty: 1, status: 'on_hand' };
          }).catch(function (err) {
            console.error('[EATG] 第 ' + (i + 1) + ' 张处理失败', err);
            items[i] = null;
          });
        });
      });
      chain.then(function () {
        var valid = items.filter(Boolean);
        if (!valid.length) { UI.toast('照片处理失败，请重试', 'error'); return; }
        try {
          global.localStorage.setItem(DRAFT_KEY, JSON.stringify({ ts: Date.now(), mode: 'album', items: valid }));
        } catch (e) {
          UI.toast('照片太多本地存储不下，请分批（建议每批 ≤ 6 张）', 'error');
          return;
        }
        UI.toast('已生成 ' + valid.length + ' 条草稿，请补齐必填项', 'success');
        if (EATG.app && EATG.app.navigate) EATG.app.navigate('#/goods/batch');
        else global.location.hash = '#/goods/batch';
      });
    });
    inp.click();
  };

  /** 扩展点：接入自训练物体检测模型后调用（x/y/w/h 为 0~1 归一化坐标，返回 Promise） */
  BS.setDetector = function (fn) { if (view) view.detector = fn; BS._detector = fn; };
  BS._detector = null;

  BS.hasDraft = function () {
    try { return !!global.localStorage.getItem(DRAFT_KEY); } catch (e) { return false; }
  };

})(window);
