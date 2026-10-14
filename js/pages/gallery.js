/* ==========================================================================
   一咕（EATG）· 角色图鉴首页（js/pages/gallery.js）
   实现：《页面线框与UI规范》P09 +《业务规则》§9 图鉴三态
   路由：#/gallery
   内容：1 角色横滑条（默认素世）+ 右上添加角色
        2 进度区（头像/名称/IP/已拥有数/总数/进度条 --accent）
        3 两列图鉴网格：三态卡片（已拥有亮显+角标 / 已拥有未出荷半亮+状态角标 / 未拥有灰剪影）
        4 自动点亮：关联 goods 任一购入 on_hand → owned（覆盖手动值）；预售/在途 → 半亮
        5 条目点击：详情 + “去收藏库补录”（预填角色跳新增页）+ 手动切换拥有
        6 点亮动画 300ms（grayscale→color）
        7 刷卡模式：卡片堆叠 + 左右翻卡（右滑标记拥有 / 左滑跳过，惯性甩出 + 弹簧回弹 + 上一步撤销）
   口径：三态判定见 computeItemState；金额无关。
   ========================================================================== */
(function (global) {
  'use strict';

  var EATG = (global.EATG = global.EATG || {});
  var S = EATG.storage;
  var U = EATG.utils;
  var UI = EATG.ui;

  EATG.pages = EATG.pages || {};

  var STATUS_LABELS = {
    deposit_pre: '定尾预售', full_pre: '全款预售', shipping: '在途',
    on_hand: '现货在手', sold_out: '已出荷'
  };

  var state = null;
  var dom = {};
  var offs = [];

  function on(el, ev, fn, opt) { if (!el) return; el.addEventListener(ev, fn, opt); offs.push([el, ev, fn, opt]); }
  function clearOffs() { offs.forEach(function (t) { t[0].removeEventListener(t[1], t[2], t[3]); }); offs = []; }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function esc(s) { return UI.esc(s == null ? '' : String(s)); }
  function clone(o) { var r = {}; for (var k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = o[k]; } return r; }

  function resetState() {
    state = {
      destroyed: false,
      characters: [],
      items: [],
      goodsById: {},
      purchasesByGoods: {},
      currentCharId: null,
      search: '',
      groupBySeries: false, // 默认不分组（平铺全部条目），可点「按系列分组」切换
      swipeMode: false,
      autoOwn: false // 常规图鉴「点亮模式」开关：默认关闭防误触（打开后点击卡片点亮拥有）
    };
    resetDeck();
  }

  // ---- 三态判定（《业务规则》§9 唯一口径）----
  /**
   * @returns { state: 'owned'|'half'|'none', status: string|null, goodsName: string|null }
   */
  function computeItemState(item) {
    var gid = item.goods_id;
    if (gid && state.goodsById[gid]) {
      var g = state.goodsById[gid];
      var ps = state.purchasesByGoods[gid] || [];
      var hasOnHand = ps.some(function (p) { return p.status === 'on_hand'; });
      if (hasOnHand) return { state: 'owned', status: 'on_hand', goodsName: g.name };
      var preShip = ps.filter(function (p) {
        return p.status === 'deposit_pre' || p.status === 'full_pre' || p.status === 'shipping';
      });
      if (preShip.length) {
        // 取最靠前（最待办）的状态
        var rank = { deposit_pre: 0, full_pre: 1, shipping: 2 };
        preShip.sort(function (a, b) { return rank[a.status] - rank[b.status]; });
        return { state: 'half', status: preShip[0].status, goodsName: g.name };
      }
      // 全部 sold_out 或无购入：视为未拥有
      return { state: 'none', status: null, goodsName: g.name };
    }
    // 无关联 goods：以手动 owned 为准
    return { state: item.owned ? 'owned' : 'none', status: null, goodsName: null };
  }

  // ---- 数据加载 ----
  function load() {
    return Promise.all([
      S.getAll('characters'),
      S.getAll('gallery_items'),
      S.getAll('goods'),
      S.getAll('purchase_items')
    ]).then(function (r) {
      // 图鉴角色独立：只显示 gallery!==false 的角色（谷子侧新增角色不进图鉴）
      state.characters = (r[0] || []).filter(function (c) { return c.gallery !== false; });
      state.items = r[1] || [];
      state.goodsById = {};
      (r[2] || []).forEach(function (g) { state.goodsById[g.id] = g; });
      state.purchasesByGoods = {};
      (r[3] || []).forEach(function (p) {
        (state.purchasesByGoods[p.goods_id] = state.purchasesByGoods[p.goods_id] || []).push(p);
      });
      // 默认选中：自推优先，否则第一个
      if (!state.currentCharId || !state.characters.some(function (c) { return c.id === state.currentCharId; })) {
        var fav = state.characters.filter(function (c) { return c.is_favorite; })[0];
        state.currentCharId = (fav || state.characters[0] || {}).id || null;
      }
    });
  }

  function currentItems() {
    if (!state.currentCharId) return [];
    return state.items.filter(function (it) { return it.character_id === state.currentCharId; });
  }

  function currentChar() {
    return state.characters.filter(function (c) { return c.id === state.currentCharId; })[0] || null;
  }

  // ---- 谷子库 → 图鉴 自动同步（《业务规则》§9 扩展）----
  // 谷子库中存在且关联了当前角色的谷子，若图鉴无同名条目则自动添加并关联 goods_id，
  // 拥有状态由 computeItemState 按谷子购入状态自动判定（现货→点亮，预售/在途→半亮）。
  // 只添加不存在的条目，不覆盖既有标记。
  function syncFromGoods() {
    var c = currentChar();
    if (!c) return Promise.resolve(0);
    return S.getAll('goods').then(function (goods) {
      return S.getAll('gallery_items').then(function (items) {
        var byName = {};
        items.forEach(function (it) {
          if (it.character_id === c.id) byName[String(it.name || '')] = true;
        });
        var toAdd = [];
        goods.forEach(function (g) {
          var cids = g.character_ids || [];
          var hit = false;
          for (var i = 0; i < cids.length; i++) {
            if (Number(cids[i]) === c.id) { hit = true; break; }
          }
          if (!hit) return;
          var nm = String(g.name || '').trim();
          if (!nm || byName[nm]) return;
          byName[nm] = true;
          toAdd.push({
            character_id: c.id,
            name: g.name,
            goods_type: String(g.goods_type || '').trim() || '',
            image: (g.images && g.images[0]) ? g.images[0] : '',
            goods_id: g.id,
            owned: false,
            series: '',
            release_date: ''
          });
        });
        if (!toAdd.length) return Promise.resolve(0);
        var i = 0;
        function next() {
          if (i >= toAdd.length) return Promise.resolve(toAdd.length);
          var batch = toAdd.slice(i, i + 50);
          i += 50;
          return Promise.all(batch.map(function (v) { return S.add('gallery_items', v); })).then(next);
        }
        return next();
      });
    });
  }

  // ---- 进度 ----
  function progress(items) {
    var owned = 0, total = items.length;
    items.forEach(function (it) {
      var st = computeItemState(it);
      if (st.state === 'owned') owned++;
    });
    return { owned: owned, total: total, pct: total ? Math.round(owned / total * 100) : 0 };
  }

  // ---- 刷卡模式（卡片堆叠 · 左右翻卡）----
  // 手感参数：跟手位移 + 轻微旋转缩放，超阈值出现印章提示；
  // 松手时按甩动速度或位移判定方向，惯性飞出；不足阈值则弹簧回弹。
  var SWIPE_CFG = {
    threshold: 0.32,   // 位移达卡片宽度比例即判定翻卡
    flingV: 0.45,      // 甩动速度阈值（px/ms）
    maxRot: 22,        // 最大旋转角（deg）
    rubber: 0.35,      // 超界橡皮筋阻力系数
    maxVisible: 3      // 堆叠可见层数（含顶层）
  };
  var deck = null;
  var lastDetailClose = 0; // 详情关闭时间戳：关闭后短暂忽略卡片点击，防止连点又弹开

  function resetDeck() {
    deck = { items: [], pos: 0, history: [], top: null, locked: false, drag: null, suppressTap: false };
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /** 洗牌（Fisher-Yates）——刷卡每次进入/重开都随机打乱顺序 */
  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  }

  function deckCardHTML(it, layer) {
    var st = computeItemState(it);
    var img = it.image ? 'background-image:url(' + esc(it.image) + ')' : '';
    var badge = '';
    if (st.state === 'owned') badge = '<span class="gal-badge gal-badge--owned">拥有</span>';
    else if (st.state === 'half') badge = '<span class="gal-badge gal-badge--' + st.status + '">' + esc(STATUS_LABELS[st.status] || st.status) + '</span>';
    var nameCls = st.state === 'none' ? 'gal-deck-name is-muted' : 'gal-deck-name';
    return '<div class="gal-deck-card gal-card--' + st.state + (layer === 0 ? ' is-top' : '') + '" data-iid="' + it.id + '">' +
      '<div class="gal-deck-img" style="' + img + '">' + badge +
        '<div class="gal-deck-stamp gal-deck-stamp--yes">拥有</div>' +
        '<div class="gal-deck-stamp gal-deck-stamp--no">跳过</div>' +
      '</div>' +
      '<div class="' + nameCls + '">' + esc(it.name) + '</div>' +
      (it.series ? '<div class="gal-deck-series">' + esc(it.series) + '</div>' : '') +
    '</div>';
  }

  function deckEmptyHTML(total) {
    if (!total) {
      return '<div class="gal-deck-empty">' +
        '<div class="gal-deck-empty-title">还没有图鉴条目</div>' +
      '</div>';
    }
    return '<div class="gal-deck-empty">' +
      '<div class="gal-deck-empty-title">这叠卡片刷完了</div>' +
      '<button type="button" class="btn btn--secondary" id="gal-deck-restart">重新开始</button>' +
    '</div>';
  }

  function rebuildDeck() {
    var deckEl = document.getElementById('gal-deck');
    if (!deckEl) return;
    deck.top = null;
    deckEl.innerHTML = '';
    if (deck.pos >= deck.items.length) {
      deckEl.innerHTML = deckEmptyHTML(deck.items.length);
      updateSwipeCount();
      return;
    }
    var end = Math.min(deck.items.length, deck.pos + SWIPE_CFG.maxVisible);
    for (var i = deck.pos; i < end; i++) {
      var layer = i - deck.pos; // 0 = 顶层
      var it = deck.items[i];
      var wrap = document.createElement('div');
      wrap.innerHTML = deckCardHTML(it, layer);
      var card = wrap.firstChild;
      card.style.zIndex = 10 - layer;
      if (layer === 0) {
        deck.top = card;
      } else {
        card.style.transform = 'translateY(' + (layer * 12) + 'px) scale(' + (1 - layer * 0.07) + ') rotate(' + (layer % 2 ? 1.6 : -1.6) + 'deg)';
        card.style.opacity = 1 - layer * 0.16;
        card.style.pointerEvents = 'none';
      }
      deckEl.appendChild(card);
    }
    updateSwipeCount();
  }

  function updateSwipeCount() {
    var el = document.getElementById('gal-swipe-count');
    if (!el) return;
    var total = deck.items.length;
    if (total === 0) { el.textContent = '共 0 张'; return; }
    el.innerHTML = deck.pos >= total
      ? '刷完了 · 共 <span class="num">' + total + '</span> 张'
      : '第 <span class="num">' + (deck.pos + 1) + '</span> / ' + total + ' 张';
  }

  // 数据变更后局部刷新顶部拥有进度（不整页重渲染，避免打断刷卡动画）
  function updateProgUI() {
    var page = document.getElementById('gallery-page');
    if (!page) return;
    var pr = progress(currentItems());
    var cnt = page.querySelector('.gal-prog-count');
    if (cnt) cnt.innerHTML = '<span class="num">' + pr.owned + '</span> / ' + pr.total + ' 已拥有';
    var fill = page.querySelector('.gal-prog-fill');
    if (fill) fill.style.width = pr.pct + '%';
  }

  // ---- 手势 ----
  function bindDeckGestures() {
    var deckEl = document.getElementById('gal-deck');
    if (!deckEl) return;
    on(deckEl, 'pointerdown', onDeckDown);
  }

  function onDeckDown(e) {
    if (deck.locked || !deck.top) return;
    if (e.button && e.button !== 0) return;
    var card = e.target.closest('.gal-deck-card');
    if (!card || card !== deck.top) return;
    deck.drag = {
      startX: e.clientX, startY: e.clientY,
      dx: 0, moved: false, dragging: false,
      samples: []
    };
    document.addEventListener('pointermove', onDeckMove);
    document.addEventListener('pointerup', onDeckUp);
    document.addEventListener('pointercancel', onDeckUp);
  }

  function cancelDeckDrag() {
    document.removeEventListener('pointermove', onDeckMove);
    document.removeEventListener('pointerup', onDeckUp);
    document.removeEventListener('pointercancel', onDeckUp);
    deck.drag = null;
  }

  function onDeckMove(e) {
    var d = deck.drag;
    if (!d) return;
    var dx = e.clientX - d.startX, dy = e.clientY - d.startY;
    if (!d.dragging) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      d.moved = true;
      if (Math.abs(dy) > Math.abs(dx) * 1.2) { cancelDeckDrag(); return; } // 纵向意图 → 交还页面滚动
      d.dragging = true;
      deck.top.style.transition = 'none';
      deck.top.style.cursor = 'grabbing';
    }
    d.dx = dx;
    var w = deck.top.offsetWidth || 320;
    var max = Math.max(100, w * SWIPE_CFG.threshold * 1.6);
    var tx = rubberX(dx, max);
    var rot = clamp(dx * 0.14, -SWIPE_CFG.maxRot, SWIPE_CFG.maxRot);
    var scale = 1 - Math.min(Math.abs(dx) / (w * 0.85), 1) * 0.08;
    deck.top.style.transform = 'translate3d(' + tx + 'px,0,0) rotate(' + rot + 'deg) scale(' + scale + ')';
    updateStamps(dx, w);
    var now = Date.now();
    d.samples.push([now, dx]);
    if (d.samples.length > 6) d.samples.shift();
    if (e.cancelable) e.preventDefault();
  }

  function rubberX(dx, max) {
    var a = Math.abs(dx);
    if (a <= max) return dx;
    return (dx > 0 ? 1 : -1) * (max + (a - max) * SWIPE_CFG.rubber);
  }

  function updateStamps(dx, w) {
    var yes = deck.top.querySelector('.gal-deck-stamp--yes');
    var no = deck.top.querySelector('.gal-deck-stamp--no');
    if (!yes || !no) return;
    var th = Math.max(90, w * SWIPE_CFG.threshold);
    var k = clamp(Math.abs(dx) / th, 0, 1);
    yes.style.opacity = dx > 0 ? k : 0;
    no.style.opacity = dx < 0 ? k : 0;
  }

  function flingVX(d) {
    var s = d.samples;
    if (s.length < 2) return 0;
    var a = s[s.length - 1], b = s[0];
    var dt = a[0] - b[0];
    if (dt <= 0) return 0;
    return (a[1] - b[1]) / dt;
  }

  function onDeckUp() {
    var d = deck.drag;
    cancelDeckDrag();
    if (!deck.top) return;
    if (!d || !d.dragging) return; // 未拖动 → 交给 click 处理（详情）
    if (d.dragging) {
      deck.suppressTap = true;
      setTimeout(function () { deck.suppressTap = false; }, 400);
    }
    var vx = flingVX(d);
    var w = deck.top.offsetWidth || 320;
    var th = Math.max(90, w * SWIPE_CFG.threshold);
    var dir = 0;
    if (Math.abs(vx) >= SWIPE_CFG.flingV) dir = vx > 0 ? 1 : -1;
    else if (Math.abs(d.dx) >= th) dir = d.dx > 0 ? 1 : -1;
    if (dir) flyOut(dir);
    else springBack();
  }

  function springBack() {
    var card = deck.top;
    if (!card) return;
    card.style.transition = 'transform .5s cubic-bezier(.18,1.25,.4,1)';
    card.style.transform = '';
    card.style.cursor = 'grab';
    var stamps = card.querySelectorAll('.gal-deck-stamp');
    for (var i = 0; i < stamps.length; i++) stamps[i].style.opacity = 0;
    setTimeout(function () { if (card) card.style.transition = ''; }, 520);
  }

  function flyOut(dir) {
    var card = deck.top;
    if (!card) return;
    deck.locked = true;
    var w = card.offsetWidth || 320;
    card.style.transition = 'transform .34s cubic-bezier(.4,0,.6,1), opacity .3s ease';
    card.style.transform = 'translate3d(' + (dir * w * 1.35) + 'px,' + (dir * w * 0.06) + 'px,0) rotate(' + (dir * 24) + 'deg) scale(.9)';
    card.style.opacity = 0;
    setTimeout(function () { advanceDeck(dir); }, 330);
  }

  function advanceDeck(dir) {
    deck.locked = false;
    var item = deck.items[deck.pos];
    if (item) deck.history.push({ iid: item.id, changed: false, prevOwned: !!item.owned });
    deck.pos++;
    rebuildDeck();
  }

  // 上一步：回退一张牌（含还原标记）
  function undoSwipe() {
    if (deck.locked) return;
    if (!deck.history.length || deck.pos <= 0) { UI.toast('没有可撤销的刷卡'); return; }
    var last = deck.history.pop();
    deck.pos--;
    if (last.changed) {
      for (var i = 0; i < state.items.length; i++) {
        if (state.items[i].id === last.iid) {
          state.items[i].owned = last.prevOwned;
          S.put('gallery_items', state.items[i]).then(function () {});
          break;
        }
      }
      updateProgUI();
      UI.toast('已撤销，标记已还原', 'success');
    } else {
      UI.toast('已撤销上一步', 'success');
    }
    rebuildDeck();
  }

  // 底部按钮直接触发翻卡
  function actionSwipe(dir) {
    if (deck.locked || !deck.top) return;
    flyOut(dir);
  }

  // ---- 渲染 ----

  function charScrollHTML() {
    return '<div class="gal-char-scroll" id="gal-char-scroll">' +
      state.characters.map(function (c) {
        var on = c.id === state.currentCharId;
        return '<div class="gal-char-chip' + (on ? ' is-active' : '') + '" data-cid="' + c.id + '">' +
          (c.avatar ? '<img class="gal-avatar" src="' + esc(c.avatar) + '">' : '<div class="gal-avatar gal-avatar--ph">' + esc((c.name || '?').charAt(0)) + '</div>') +
          '<span class="gal-char-name">' + esc(c.name) + '</span>' +
          '<button type="button" class="gal-char-del" data-char-del="' + c.id + '" aria-label="删除角色">×</button>' +
        '</div>';
      }).join('') +
    '</div>';
  }

  function progressHTML() {
    var c = currentChar();
    if (!c) return '<div class="gal-progress"><p class="empty-line">还没有角色，点击右上「＋」添加</p></div>';
    var items = currentItems();
    var pr = progress(items);
    return '<div class="gal-progress">' +
      '<div class="gal-prog-head">' +
        (c.avatar ? '<img class="gal-prog-avatar" src="' + esc(c.avatar) + '">' : '<div class="gal-prog-avatar gal-avatar--ph">' + esc((c.name || '?').charAt(0)) + '</div>') +
        '<div class="gal-prog-info">' +
          '<div class="gal-prog-name">' + esc(c.name) + '</div>' +
          '<div class="gal-prog-ip">' + esc(c.ip || '—') + '</div>' +
          '<div class="gal-prog-count"><span class="num">' + pr.owned + '</span> / ' + pr.total + ' 已拥有</div>' +
        '</div>' +
      '</div>' +
      '<div class="gal-prog-bar"><div class="gal-prog-fill" style="width:' + pr.pct + '%"></div></div>' +
    '</div>';
  }

  function itemCardHTML(it) {
    var st = computeItemState(it);
    var img = it.image ? 'background-image:url(' + esc(it.image) + ')' : '';
    var badge = '';
    if (st.state === 'owned') badge = '<span class="gal-badge gal-badge--owned">拥有</span>';
    else if (st.state === 'half') badge = '<span class="gal-badge gal-badge--' + st.status + '">' + esc(STATUS_LABELS[st.status] || st.status) + '</span>';
    var nameCls = st.state === 'none' ? 'gal-card-name is-muted' : 'gal-card-name';
    var stateCls = 'gal-card--' + st.state;
    return '<div class="gal-card ' + stateCls + '" data-iid="' + it.id + '">' +
      '<div class="gal-card-img" style="' + img + '">' + badge + '</div>' +
      '<div class="' + nameCls + '">' + esc(it.name) + '</div>' +
      (it.series ? '<div class="gal-card-series">' + esc(it.series) + '</div>' : '') +
    '</div>';
  }

  function groupBySeriesItems(items) {
    var map = {}, order = [];
    items.forEach(function (it) {
      var key = it.series || '未分组';
      if (!map[key]) { map[key] = []; order.push(key); }
      map[key].push(it);
    });
    return order.map(function (k) { return { series: k, items: map[k] }; });
  }

  function gridHTML() {
    var items = currentItems();
    if (state.search) {
      var q = state.search.trim().toLowerCase();
      items = items.filter(function (it) { return String(it.name || '').toLowerCase().indexOf(q) >= 0; });
    }
    if (!items.length) {
      return '<p class="empty-line">还没有图鉴条目，去添加官方谷子</p>';
    }
    var html = '<div class="gal-grid">';
    if (state.groupBySeries) {
      groupBySeriesItems(items).forEach(function (g) {
        html += '<div class="gal-group"><div class="gal-group-title">' + esc(g.series) + '</div><div class="gal-grid-row">';
        g.items.forEach(function (it) { html += itemCardHTML(it); });
        html += '</div></div>';
      });
    } else {
      html += '<div class="gal-grid-row">';
      items.forEach(function (it) { html += itemCardHTML(it); });
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function toolbarHTML() {
    return '<div class="gal-toolbar">' +
      '<input id="gal-search" class="input" type="text" placeholder="搜索条目名称" value="' + esc(state.search) + '">' +
      '<div class="gal-toolbar-row">' +
        '<button type="button" class="btn btn--secondary" id="gal-group-btn">' + (state.groupBySeries ? '取消分组' : '按系列分组') + '</button>' +
        '<button type="button" class="btn btn--secondary" id="gal-swipe-btn" title="卡片堆叠，左右刷卡浏览">刷卡</button>' +
      '</div>' +
      '<div class="gal-swipe-opt">' +
        '<label class="switch"><input type="checkbox" id="gal-tap-own"' + (state.autoOwn ? ' checked' : '') + '><span class="switch-track"></span>' +
          '<span class="switch-label">点亮模式（点击卡片标记拥有）</span></label>' +
        '<span class="gal-swipe-opt-tip">默认关闭防误触 · 打开后点击卡片 = 点亮/取消</span>' +
      '</div>' +
    '</div>';
  }

  function swipePageHTML() {
    return '<div class="page-scroll" id="gallery-page">' +
      charScrollHTML() +
      progressHTML() +
      '<div class="gal-swipe">' +
        '<div class="gal-swipe-head">' +
          '<button type="button" class="btn btn--secondary btn--sm" id="gal-swipe-exit">‹ 网格</button>' +
          '<div class="gal-swipe-count" id="gal-swipe-count"></div>' +
        '</div>' +
        '<div class="gal-deck" id="gal-deck"></div>' +
        '<div class="gal-swipe-tip">左右滑动翻卡 · 点卡片看详情</div>' +
        '<div class="gal-swipe-actions">' +
          '<button type="button" class="btn btn--secondary" id="gal-swipe-skip">‹ 跳过</button>' +
          '<button type="button" class="btn btn--secondary" id="gal-swipe-undo">上一步</button>' +
          '<button type="button" class="btn btn--primary" id="gal-swipe-own">下一张 ›</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function pageHTML() {
    return '<div class="page-scroll" id="gallery-page">' +
      charScrollHTML() +
      progressHTML() +
      toolbarHTML() +
      gridHTML() +
    '</div>';
  }

  // ---- 详情抽屉 ----
  function openDetail(item) {
    var st = computeItemState(item);
    var c = state.characters.filter(function (ch) { return ch.id === item.character_id; })[0];
    var goodsInfo = st.goodsName ? ('关联谷子：' + st.goodsName) : '未关联谷子款';
    var stateText = st.state === 'owned' ? '已拥有（亮显）' : (st.state === 'half' ? '已拥有未出荷（' + (STATUS_LABELS[st.status] || '') + '）' : '未拥有');
    var body = '<div class="gal-detail">' +
      (item.image ? '<img class="gal-detail-img" src="' + esc(item.image) + '">' : '<div class="gal-detail-img gal-detail-img--ph">无图</div>') +
      '<div class="gal-detail-name">' + esc(item.name) + '</div>' +
      '<div class="gal-detail-meta">角色：' + esc(c ? c.name : '—') + '</div>' +
      (item.series ? '<div class="gal-detail-meta">系列：' + esc(item.series) + '</div>' : '') +
      (item.release_date ? '<div class="gal-detail-meta">发售：' + esc(item.release_date) + '</div>' : '') +
      '<div class="gal-detail-meta">状态：' + esc(stateText) + '</div>' +
      '<div class="gal-detail-meta">' + esc(goodsInfo) + '</div>' +
    '</div>' +
    '<div class="detail-actions">' +
      '<button type="button" class="btn btn--secondary" data-act="edit">编辑</button>' +
      (st.state === 'none' ? '<button type="button" class="btn btn--primary" data-act="add-goods">去收藏库补录</button>' : '') +
      (st.state === 'none' ? '<button type="button" class="btn btn--secondary" data-act="toggle-owned">标记已拥有</button>' : '') +
      '<button type="button" class="btn btn--danger" data-act="del">删除</button>' +
    '</div>';
    var ref = UI.sheet({ title: '图鉴条目', bodyHTML: body });
    // 关闭时记录时间，屏蔽随后的卡片连点（避免“关了好几次还弹”）
    var _close = ref.close;
    ref.close = function () { lastDetailClose = Date.now(); _close(); };
    ref.body.addEventListener('click', function (e) {
      var act = e.target.closest('[data-act]');
      if (!act) { ref.close(); return; } // 点详情空白区域也可关闭
      var a = act.dataset.act;
      if (a === 'edit') { ref.close(); go('#/gallery/edit?id=' + item.id); }
      else if (a === 'add-goods') {
        ref.close();
        go('#/goods/edit?mode=new&from=gallery&name=' + encodeURIComponent(item.name || '') +
          (c ? '&chars=' + c.id : '') + (c && c.ip ? '&ip=' + encodeURIComponent(c.ip) : ''));
      }
      else if (a === 'toggle-owned') {
        item.owned = !item.owned;
        S.put('gallery_items', item).then(function () {
          UI.toast(item.owned ? '已标记为拥有' : '已取消拥有', 'success');
          ref.close();
          rerender();
        });
      }
      else if (a === 'del') {
        UI.confirmDialog({
          title: '删除条目',
          message: '删除后不可恢复，确认删除？',
          confirmText: '删除',
          danger: true,
          onConfirm: function () {
            S.del('gallery_items', item.id).then(function () {
              UI.toast('已删除', 'success');
              ref.close();
              rerender();
            });
          }
        });
      }
    });
  }

  // ---- 添加角色 ----
  function openAddChar() {
    var body = '<div class="form-section">' +
      '<div class="field"><div class="field-head"><label class="field-label">角色名</label></div><input id="nc-name" class="input" type="text" placeholder="如：长崎素世"></div>' +
      '<div class="field"><div class="field-head"><label class="field-label">所属 IP</label></div><input id="nc-ip" class="input" type="text" placeholder="如：MyGO"></div>' +
    '</div>';
    var ref = UI.sheet({ title: '添加角色', bodyHTML: body, footerHTML: '<button type="button" class="btn btn--primary" data-act="ok">保存</button>' });
    ref.el.addEventListener('click', function (e) {
      if (e.target.dataset.act !== 'ok') return;
      var name = document.getElementById('nc-name').value.trim();
      var ip = document.getElementById('nc-ip').value.trim();
      if (!name) { UI.toast('请填写角色名', 'error'); return; }
      S.add('characters', { name: name, ip: ip || '', gallery: true, is_favorite: state.characters.length === 0 }).then(function (id) {
        state.currentCharId = Number(id);
        UI.toast('已添加角色', 'success');
        ref.close();
        reload();
      });
    });
  }

  /** 删除图鉴角色：从图鉴隐藏（gallery=false）+ 删除其全部图鉴条目；谷子库记录不受影响 */
  function delGalleryChar(cid) {
    var c = state.characters.filter(function (x) { return x.id === cid; })[0];
    if (!c) return;
    UI.confirmDialog({
      title: '删除图鉴角色',
      message: '删除「' + c.name + '」？将从图鉴移除该角色和它的全部图鉴条目（谷子库记录不受影响）。',
      confirmText: '删除',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      c.gallery = false;
      return S.put('characters', c).then(function () {
        return S.getAll('gallery_items').then(function (items) {
          var dels = (items || []).filter(function (it) { return it.character_id === cid; });
          var p = Promise.resolve();
          dels.forEach(function (it) { p = p.then(function () { return S.del('gallery_items', it.id); }); });
          return p;
        });
      }).then(function () {
        UI.toast('已删除「' + c.name + '」', 'success');
        if (state.currentCharId === cid) {
          var rest = state.characters.filter(function (x) { return x.id !== cid; });
          state.currentCharId = (rest[0] || {}).id || null;
        }
        state.characters = state.characters.filter(function (x) { return x.id !== cid; });
        rerender();
      });
    });
  }

  function go(hash) { if (EATG.app && EATG.app.navigate) EATG.app.navigate(hash); }

  function rerender() {
    var page = document.getElementById('gallery-page');
    if (!page) return;
    if (state.swipeMode) {
      page.innerHTML = swipePageHTML();
      deck.items = shuffle(currentItems()); // 每次进入刷卡随机打乱
      deck.pos = 0;
      deck.history = [];
      rebuildDeck();
    } else {
      page.innerHTML = charScrollHTML() + progressHTML() + toolbarHTML() + gridHTML();
    }
    bindInner();
  }

  function reload() {
    return load().then(function () { if (!state.destroyed) rerender(); });
  }

  function bindInner() {
    var page = document.getElementById('gallery-page');
    if (!page) return;
    on(page.querySelector('#gal-char-scroll'), 'click', function (e) {
      var del = e.target.closest('[data-char-del]');
      if (del) { delGalleryChar(Number(del.dataset.charDel)); return; }
      var chip = e.target.closest('.gal-char-chip');
      if (chip) { state.currentCharId = Number(chip.dataset.cid); rerender(); }
    });
    if (state.swipeMode) {
      bindSwipeControls(page);
      bindDeckGestures();
      return;
    }
    var search = document.getElementById('gal-search');
    if (search) on(search, 'input', function () { state.search = search.value; rerender(); });
    var gb = document.getElementById('gal-group-btn');
    if (gb) on(gb, 'click', function () { state.groupBySeries = !state.groupBySeries; rerender(); });
    var swBtn = document.getElementById('gal-swipe-btn');
    if (swBtn) on(swBtn, 'click', function () {
      if (!state.currentCharId) { UI.toast('请先选择或添加角色', 'error'); return; }
      state.swipeMode = true;
      rerender();
    });
    var to = document.getElementById('gal-tap-own');
    if (to) on(to, 'change', function () { state.autoOwn = to.checked; });
    on(page, 'click', function (e) {
      if (Date.now() - lastDetailClose < 350) return; // 详情刚关闭，忽略穿透点击
      var card = e.target.closest('.gal-card');
      if (card) {
        var it = state.items.filter(function (x) { return x.id === Number(card.dataset.iid); })[0];
        if (!it) return;
        if (state.autoOwn) {
          // 点亮模式：点击切换拥有（点亮/取消），已拥有的再点取消
          it.owned = !it.owned;
          S.put('gallery_items', it).then(function () {
            UI.toast(it.owned ? '已点亮：' + it.name : '已取消点亮：' + it.name, 'success');
          }).catch(function () { UI.toast('保存失败', 'error'); });
          rerender();
        } else {
          openDetail(it);
        }
      }
    });
  }

  // ---- 刷卡模式：顶部控制条 + 底部按钮 + 点击详情 ----
  function bindSwipeControls(page) {
    on(page, 'click', function (e) {
      if (e.target.closest('.gal-deck-stamp')) return;
      var btn = e.target.closest('button[id]');
      if (btn) {
        var id = btn.id;
        if (id === 'gal-swipe-exit') { state.swipeMode = false; rerender(); }
        else if (id === 'gal-swipe-skip') actionSwipe(-1);
        else if (id === 'gal-swipe-own') actionSwipe(1);
        else if (id === 'gal-swipe-undo') undoSwipe();
        else if (id === 'gal-deck-restart') { deck.items = shuffle(deck.items); deck.pos = 0; deck.history = []; rebuildDeck(); }
        return;
      }
      if (deck.suppressTap || deck.locked) return;
      if (Date.now() - lastDetailClose < 350) return; // 详情刚关闭，忽略穿透点击
      var card = e.target.closest('.gal-deck-card');
      if (!card || card !== deck.top) return;
      var it = state.items.filter(function (x) { return x.id === Number(card.dataset.iid); })[0];
      if (it) openDetail(it);
    });
  }

  function mount(container, ctx) {
    resetState();
    dom = { container: container };
    container.innerHTML = '<div class="loading">加载中…</div>';
    ctx.setTitle('图鉴');
    ctx.setBack(false);
    ctx.setActiveTab('gallery');
    ctx.navActions.innerHTML = '<button id="gal-import" type="button" class="icon-btn" title="导入图鉴清单 / 检查更新">导</button><button id="gal-add-char" type="button" class="icon-btn icon-btn--accent" title="添加角色">＋</button><button id="gal-add-item" type="button" class="icon-btn" title="添加图鉴条目">＋</button>';
    var addChar = document.getElementById('gal-add-char');
    var addItem = document.getElementById('gal-add-item');
    var importBtn = document.getElementById('gal-import');
    if (importBtn) on(importBtn, 'click', function () {
      if (!EATG.galleryImport) { UI.toast('导入模块未加载', 'error'); return; }
      EATG.galleryImport.open({ reload: reload });
    });
    if (addChar) on(addChar, 'click', openAddChar);
    if (addItem) on(addItem, 'click', function () {
      if (!state.currentCharId) { UI.toast('请先选择或添加角色', 'error'); return; }
      go('#/gallery/edit?character_id=' + state.currentCharId);
    });
    return load().then(function () {
      if (state.destroyed) return;
      container.innerHTML = pageHTML();
      bindInner();
      // 谷子库 → 图鉴 自动同步（打开图鉴页即执行，幂等）
      syncFromGoods().then(function (n) {
        if (n && !state.destroyed) {
          UI.toast('已从谷子库自动添加 ' + n + ' 条图鉴', 'success');
          rerender();
        }
      });
    }).catch(function (err) {
      if (state.destroyed) return;
      if (!(err && err.expected)) console.error('[EATG] 图鉴加载失败', err);
      UI.toast('加载失败：' + (err && err.message || err), 'error');
    });
  }

  function unmount() {
    if (state) state.destroyed = true;
    if (deck && deck.drag) cancelDeckDrag();
    clearOffs();
  }

  EATG.pages['gallery'] = { key: 'gallery', mount: mount, unmount: unmount };

})(window);
