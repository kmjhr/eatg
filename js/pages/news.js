/* ==========================================================================
   一咕（EATG）· 资讯首页（js/pages/news.js）
   实现：《页面线框与UI规范》P14 + 《业务规则》§10
   路由：#/news
   内容：1 顶部：标题 + 筛选（IP/角色/类型/只看未读） + 监控源 + 手动添加 + 愿望清单入口
        2 卡片流：图/标题/IP角色/开订/出荷/参考价/渠道；未读圆点
        3 三按钮：想买(wish) / 已订(ordered) / 忽略(ignored)
        4 左滑快速忽略
        5 提醒：开订/出荷前 Notification + 应用内检查，免打扰时段不弹
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
  var swipe = { card: null, row: null, startX: 0, startY: 0, dx: 0, dragging: false, moved: false, opened: null };
  var SWIPE_OPEN = 72;
  var TAP_TOL = 6;

  function on(el, ev, fn, opt) { if (!el) return; el.addEventListener(ev, fn, opt); offs.push([el, ev, fn, opt]); }
  function clearOffs() { offs.forEach(function (t) { t[0].removeEventListener(t[1], t[2], t[3]); }); offs = []; }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function money(c) { return U.fmtMoney(c, 'CNY'); }
  function esc(s) { return UI.esc(s == null ? '' : String(s)); }

  function resetState() {
    state = {
      destroyed: false,
      news: [],
      charsById: {},
      filters: { ip: '', char: '', type: '', unread: false },
      enums: { ip: [], goods_type: [] }
    };
  }

  // ---- 数据加载 ----
  function load() {
    return Promise.all([
      S.getAll('news'),
      S.getAll('characters'),
      S.get('enums', 'ip'),
      S.get('enums', 'goods_type')
    ]).then(function (r) {
      state.news = (r[0] || []).sort(function (a, b) { return num(b.created_at) - num(a.created_at); });
      state.charsById = {};
      (r[1] || []).forEach(function (c) { state.charsById[c.id] = c; });
      state.enums.ip = (r[2] && r[2].values) || [];
      state.enums.goods_type = (r[3] && r[3].values) || [];
    });
  }

  function charNames(ids) {
    if (!ids || !ids.length) return '';
    return ids.map(function (id) { var c = state.charsById[id]; return c ? c.name : ''; }).filter(Boolean).join('、');
  }

  // ---- 筛选 ----
  function filteredNews() {
    var f = state.filters;
    return state.news.filter(function (n) {
      if (f.unread && n.is_read) return false;
      if (f.ip && n.ip !== f.ip) return false;
      if (f.type && n.goods_type !== f.type) return false;
      if (f.char) {
        var cid = Number(f.char);
        if (!n.character_ids || n.character_ids.indexOf(cid) < 0) return false;
      }
      return true;
    });
  }

  // ---- 渲染 ----
  function filterHTML() {
    var ips = state.enums.ip;
    var types = state.enums.goods_type;
    var chars = Object.values(state.charsById);
    var f = state.filters;
    return '<div class="news-filter">' +
      '<select id="nf-ip" class="input input--sm">' +
        '<option value="">全部IP</option>' +
        ips.map(function (v) { return '<option value="' + esc(v) + '"' + (f.ip === v ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join('') +
      '</select>' +
      '<select id="nf-char" class="input input--sm">' +
        '<option value="">全部角色</option>' +
        chars.map(function (c) { return '<option value="' + c.id + '"' + (f.char === String(c.id) ? ' selected' : '') + '>' + esc(c.name) + '</option>'; }).join('') +
      '</select>' +
      '<select id="nf-type" class="input input--sm">' +
        '<option value="">全部类型</option>' +
        types.map(function (v) { return '<option value="' + esc(v) + '"' + (f.type === v ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join('') +
      '</select>' +
      '<label class="switch switch--sm"><input id="nf-unread" type="checkbox"' + (f.unread ? ' checked' : '') + '><span class="switch-track"></span><span class="switch-label">未读</span></label>' +
    '</div>';
  }

  function statusBadge(status) {
    if (status === 'wish') return '<span class="news-badge news-badge--wish">想买</span>';
    if (status === 'ordered') return '<span class="news-badge news-badge--ordered">已订</span>';
    if (status === 'ignored') return '<span class="news-badge news-badge--ignored">已忽略</span>';
    return '';
  }

  function cardHTML(n) {
    var img = n.image ? '<img class="news-card-img" src="' + n.image + '" alt="">' : '<div class="news-card-img news-card-img--ph">无图</div>';
    var chars = charNames(n.character_ids);
    var unread = n.is_read ? '' : '<span class="news-unread"></span>';
    return '<div class="news-card' + (n.status === 'ignored' ? ' is-ignored' : '') + '" data-nid="' + n.id + '">' +
      '<div class="news-card-main">' +
        '<div class="news-card-head">' + img +
          '<div class="news-card-info">' +
            '<div class="news-card-title">' + unread + esc(n.title) + '</div>' +
            '<div class="news-card-meta">' +
              (n.ip ? '<span class="tag tag--ip">' + esc(n.ip) + '</span>' : '') +
              (chars ? '<span class="tag">' + esc(chars) + '</span>' : '') +
              statusBadge(n.status) +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="news-card-times">' +
          (n.preorder_time ? '<span>开订 <b>' + esc(n.preorder_time) + '</b></span>' : '') +
          (n.release_time ? '<span>出荷 <b>' + esc(n.release_time) + '</b></span>' : '') +
        '</div>' +
        '<div class="news-card-foot">' +
          (n.price != null ? '<span class="news-price num">' + money(n.price) + '</span>' : '<span class="muted">—</span>') +
          (n.channel ? '<span class="muted">' + esc(n.channel) + '</span>' : '') +
        '</div>' +
        '<div class="news-card-actions">' +
          '<button type="button" class="btn btn--secondary btn--sm" data-act="wish">想买</button>' +
          '<button type="button" class="btn btn--primary btn--sm" data-act="order">已订</button>' +
          '<button type="button" class="btn btn--danger btn--sm" data-act="ignore">忽略</button>' +
        '</div>' +
      '</div>' +
      '<div class="swipe-actions"><button type="button" class="swipe-btn swipe-btn--out" data-act="ignore">忽略</button></div>' +
    '</div>';
  }

  function listHTML() {
    var list = filteredNews();
    if (!list.length) return '<p class="empty-line">没有匹配的资讯</p>';
    return '<div class="news-list">' + list.map(cardHTML).join('') + '</div>';
  }

  function pageHTML() {
    return '<div class="page-scroll" id="news-page">' +
      filterHTML() +
      listHTML() +
    '</div>';
  }

  function go(hash) { if (EATG.app && EATG.app.navigate) EATG.app.navigate(hash); }

  function rerender() {
    var page = document.getElementById('news-page');
    if (!page) return;
    page.innerHTML = filterHTML() + listHTML();
    bindFilter();
  }

  function bindFilter() {
    var page = document.getElementById('news-page');
    if (!page) return;
    var ip = document.getElementById('nf-ip');
    var ch = document.getElementById('nf-char');
    var ty = document.getElementById('nf-type');
    var un = document.getElementById('nf-unread');
    if (ip) on(ip, 'change', function () { state.filters.ip = ip.value; rerender(); });
    if (ch) on(ch, 'change', function () { state.filters.char = ch.value; rerender(); });
    if (ty) on(ty, 'change', function () { state.filters.type = ty.value; rerender(); });
    if (un) on(un, 'change', function () { state.filters.unread = un.checked; rerender(); });
  }

  // ---- 三操作 ----
  function setStatus(nid, status) {
    return S.get('news', nid).then(function (n) {
      if (!n) return;
      n.status = status;
      n.is_read = true;
      return S.put('news', n);
    }).then(function () {
      var idx = state.news.findIndex(function (x) { return x.id === nid; });
      if (idx >= 0) { state.news[idx].status = status; state.news[idx].is_read = true; }
      UI.toast(status === 'wish' ? '已加入愿望清单' : status === 'ordered' ? '已标记已订' : '已忽略', 'success');
      rerender();
    });
  }

  function doOrder(nid) {
    setStatus(nid, 'ordered').then(function () {
      return S.get('news', nid);
    }).then(function (n) {
      if (!n) return;
      var params = new URLSearchParams();
      params.set('mode', 'add');
      params.set('from', 'news');
      params.set('name', n.title || '');
      if (n.ip) params.set('ip', n.ip);
      if (n.goods_type) params.set('goods_type', n.goods_type);
      if (n.character_ids && n.character_ids.length) params.set('chars', n.character_ids.join(','));
      if (n.channel) params.set('channel', n.channel);
      params.set('status', 'deposit_pre');
      go('#/goods/edit?' + params.toString());
    });
  }

  function doWish(nid) { setStatus(nid, 'wish'); }
  function doIgnore(nid) { setStatus(nid, 'ignored'); }

  // ---- 左滑 ----
  function onPointerDown(e) {
    var card = e.target.closest('.news-card');
    if (!card || e.target.closest('.swipe-btn') || e.target.closest('.news-card-actions')) return;
    swipe.card = card;
    swipe.row = card.querySelector('.news-card-main');
    swipe.startX = e.clientX;
    swipe.startY = e.clientY;
    swipe.dx = 0;
    swipe.moved = false;
    swipe.dragging = false;
    swipe.base = (swipe.opened === card) ? -SWIPE_OPEN : 0;
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerUp);
  }
  function onPointerMove(e) {
    if (!swipe.card) return;
    var dx = e.clientX - swipe.startX, dy = e.clientY - swipe.startY;
    if (!swipe.dragging) {
      if (Math.abs(dx) < TAP_TOL && Math.abs(dy) < TAP_TOL) return;
      swipe.moved = true;
      if (Math.abs(dx) > Math.abs(dy) * 1.2) { swipe.dragging = true; swipe.row.style.transition = 'none'; }
      else { resetSwipe(); return; }
    }
    if (swipe.dragging) {
      var off = Math.max(-SWIPE_OPEN, Math.min(0, swipe.base + dx));
      swipe.dx = off;
      swipe.row.style.transform = 'translateX(' + off + 'px)';
      if (e.cancelable) e.preventDefault();
    }
  }
  function onPointerUp() {
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointercancel', onPointerUp);
    if (!swipe.card) { resetSwipe(); return; }
    var card = swipe.card, row = swipe.row;
    if (swipe.dragging) {
      row.style.transition = 'transform .2s';
      if (swipe.dx < -SWIPE_OPEN / 2) {
        row.style.transform = 'translateX(-' + SWIPE_OPEN + 'px)';
        if (swipe.opened && swipe.opened !== card) closeCard(swipe.opened);
        swipe.opened = card;
      } else {
        row.style.transform = 'translateX(0)';
        if (swipe.opened === card) swipe.opened = null;
      }
    } else if (!swipe.moved) {
      // 点击卡片 → 详情
      var nid = Number(card.dataset.nid);
      go('#/news/edit?id=' + nid);
    }
    resetSwipe();
  }
  function closeCard(card) {
    if (!card) return;
    var row = card.querySelector('.news-card-main');
    if (row) { row.style.transition = 'transform .2s'; row.style.transform = 'translateX(0)'; }
  }
  function resetSwipe() { swipe.card = null; swipe.row = null; }

  function bind() {
    var page = document.getElementById('news-page');
    if (!page) return;
    bindFilter();
    on(page, 'click', function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      var card = btn.closest('.news-card');
      if (!card) return;
      var nid = Number(card.dataset.nid);
      var act = btn.dataset.act;
      if (act === 'wish') doWish(nid);
      else if (act === 'order') doOrder(nid);
      else if (act === 'ignore') doIgnore(nid);
    });
    on(page, 'pointerdown', onPointerDown);
  }

  // ---- 提醒检查（开订/出荷前 N 天） ----
  function checkReminders() {
    return S.getSetting('reminder').then(function (rem) {
      rem = rem || { preorder_lead: 1, deadline_lead: 1, quiet_start: '22:00', quiet_end: '08:00', enabled: true };
      if (!rem.enabled) return;
      // 免打扰时段
      var now = new Date();
      var hm = now.getHours() * 60 + now.getMinutes();
      var qs = toMin(rem.quiet_start), qe = toMin(rem.quiet_end);
      var inQuiet = qs === qe ? false : (qs < qe ? (hm >= qs && hm < qe) : (hm >= qs || hm < qe));
      if (inQuiet) return;
      var today = U.todayStr();
      var leadDays = rem.preorder_lead || 1;
      var remind = state.news.filter(function (n) {
        if (n.status === 'ordered' || n.status === 'ignored') return false;
        var t = n.preorder_time || n.release_time;
        if (!t) return false;
        var diff = dayDiff(today, t);
        return diff >= 0 && diff <= leadDays;
      });
      if (!remind.length) return;
      fireNotifications(remind);
    }).catch(function () { /* 静默 */ });
  }

  function toMin(hhmm) {
    if (!hhmm) return 0;
    var p = String(hhmm).split(':');
    return Number(p[0]) * 60 + Number(p[1] || 0);
  }
  function dayDiff(a, b) {
    var da = new Date(a + 'T00:00:00'), db = new Date(b + 'T00:00:00');
    return Math.round((db - da) / 86400000);
  }

  function fireNotifications(items) {
    var perm = global.Notification && Notification.permission;
    if (perm !== 'granted') return; // 无权限不弹，由引导条处理
    items.slice(0, 3).forEach(function (n) {
      try {
        new Notification('一咕提醒 · ' + (n.preorder_time ? '开订' : '出荷'), {
          body: n.title + (n.price != null ? ' 参考价 ' + money(n.price) : ''),
          tag: 'eatg-news-' + n.id
        });
      } catch (e) { /* 静默 */ }
    });
  }

  function requestNotifyPermission() {
    if (!global.Notification) { UI.toast('当前环境不支持通知', 'error'); return Promise.resolve(); }
    if (Notification.permission === 'granted') { UI.toast('通知权限已开启', 'success'); return Promise.resolve(); }
    return Notification.requestPermission().then(function (p) {
      UI.toast(p === 'granted' ? '通知权限已开启' : '未授予通知权限', p === 'granted' ? 'success' : 'error');
    });
  }

  function notifyBannerHTML() {
    if (!global.Notification) return '';
    if (Notification.permission === 'granted') return '';
    return '<div class="news-notify-banner"><span>开启通知可在开订/出荷前提醒（免打扰时段不弹）</span>' +
      '<button type="button" class="btn btn--primary btn--sm" id="nf-enable">开启通知</button></div>';
  }

  function mount(container, ctx) {
    resetState();
    dom = { container: container };
    container.innerHTML = '<div class="loading">加载中…</div>';
    ctx.setTitle('资讯');
    ctx.setBack(false);
    ctx.setActiveTab('news');
    ctx.navActions.innerHTML =
      '<button id="nf-wishlist" type="button" class="icon-btn" title="愿望清单">♡</button>' +
      '<button id="nf-sources" type="button" class="icon-btn" title="监控源">⚙</button>' +
      '<button id="nf-add" type="button" class="icon-btn icon-btn--accent" title="手动添加">＋</button>';
    var wl = document.getElementById('nf-wishlist');
    var src = document.getElementById('nf-sources');
    var add = document.getElementById('nf-add');
    if (wl) on(wl, 'click', function () { go('#/wishlist'); });
    if (src) on(src, 'click', function () { go('#/sources'); });
    if (add) on(add, 'click', function () { go('#/news/edit'); });
    return load().then(function () {
      if (state.destroyed) return;
      container.innerHTML = notifyBannerHTML() + pageHTML();
      var en = document.getElementById('nf-enable');
      if (en) on(en, 'click', requestNotifyPermission);
      bind();
      checkReminders();
    }).catch(function (err) {
      if (state.destroyed) return;
      if (!(err && err.expected)) console.error('[EATG] 资讯首页加载失败', err);
      UI.toast('加载失败：' + (err && err.message || err), 'error');
    });
  }

  function unmount() {
    if (state) state.destroyed = true;
    clearOffs();
  }

  EATG.pages['news'] = { key: 'news', mount: mount, unmount: unmount };

})(window);
