/* ==========================================================================
   一咕（EATG）· 行情详情（js/pages/market_detail.js）
   实现：《页面线框与UI规范》P12
   路由：#/market/detail?goods_id=
   内容：1 信息区：名称 / IP·角色 / 当前估值（标注「非交易指导价」）
        2 Canvas 走势折线（时间横轴、价格纵轴，点可悬停显示）
        3 历史明细列表：平台 / 价格 / 品相 / 日期 / 备注，可编辑删除
        4 「+录入新行情」→ #/market/add?goods_id=
   口径：当前估值 = 该谷子最新一条 price_records.price（按 record_date 降序、created_at 降序）。
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
  function money(c) { return U.fmtMoney(c, 'CNY'); }
  function esc(s) { return UI.esc(s == null ? '' : String(s)); }

  function resetState() {
    state = {
      destroyed: false,
      goodsId: null,
      goods: null,
      charsById: {},
      records: []   // 按日期升序（走势图用），recordsAsc
    };
  }

  function load(ctx) {
    var params = new URLSearchParams(ctx.query);
    var gid = params.get('goods_id');
    if (!gid) return Promise.reject(new Error('缺少 goods_id'));
    state.goodsId = Number(gid);
    return Promise.all([
      S.get('goods', state.goodsId),
      S.query('price_records', 'goods_id', state.goodsId),
      S.getAll('characters')
    ]).then(function (r) {
      state.goods = r[0];
      if (!state.goods) throw new Error('谷子款不存在');
      state.charsById = {};
      (r[2] || []).forEach(function (c) { state.charsById[c.id] = c; });
      // 升序（走势图按时间从左到右）
      state.records = (r[1] || []).slice().sort(function (a, b) {
        if (a.record_date !== b.record_date) return (a.record_date || '').localeCompare(b.record_date || '');
        return num(a.created_at) - num(b.created_at);
      });
    });
  }

  function latestRecord() {
    if (!state.records.length) return null;
    return state.records[state.records.length - 1];
  }

  function charNames() {
    var g = state.goods;
    if (!g || !g.character_ids || !g.character_ids.length) return '';
    return g.character_ids.map(function (id) {
      var c = state.charsById[id];
      return c ? c.name : ('角色#' + id);
    }).join('、');
  }

  // ---- 渲染 ----
  function infoHTML() {
    var g = state.goods;
    var latest = latestRecord();
    var valText = latest ? money(latest.price) : '暂无估值';
    var condText = latest ? (latest.condition || '—') : '';
    var platText = latest ? (latest.platform || '—') : '';
    return '<div class="mkt-d-info">' +
      '<div class="mkt-d-name">' + esc(g.name || ('谷子#' + g.id)) + '</div>' +
      '<div class="mkt-d-meta">' +
        (g.ip ? '<span class="tag tag--ip">' + esc(g.ip) + '</span>' : '') +
        (charNames() ? '<span class="tag">' + esc(charNames()) + '</span>' : '') +
      '</div>' +
      '<div class="mkt-d-val">' +
        '<div class="mkt-d-val-label">当前估值 <span class="mkt-d-val-warn">非交易指导价</span></div>' +
        '<div class="mkt-d-val-price num">' + valText + '</div>' +
        (latest ? '<div class="muted">' + esc(platText) + (condText ? ' · ' + esc(condText) : '') + ' · ' + esc(latest.record_date || '') + '</div>' : '') +
      '</div>' +
    '</div>';
  }

  function chartHTML() {
    if (state.records.length < 2) {
      return '<div class="mkt-chart-box">' +
        '<canvas id="mkt-chart" class="mkt-chart"></canvas>' +
        '<p class="hint">至少需要 2 条行情才能绘制走势，当前 ' + state.records.length + ' 条</p>' +
      '</div>';
    }
    return '<div class="mkt-chart-box">' +
      '<canvas id="mkt-chart" class="mkt-chart"></canvas>' +
      '<div class="mkt-chart-tip" id="mkt-chart-tip"></div>' +
    '</div>';
  }

  function historyHTML() {
    var head = '<div class="block-head"><h3 class="block-title">历史行情（' + state.records.length + '）</h3>' +
      '<button type="button" class="block-action" data-act="add">＋ 录入新行情</button></div>';
    if (!state.records.length) {
      return '<section class="block">' + head + '<p class="empty-line">暂无行情记录</p></section>';
    }
    // 倒序列表
    var desc = state.records.slice().reverse();
    var rows = desc.map(function (p) {
      return '<div class="mkt-hist-row" data-pid="' + p.id + '">' +
        '<div class="mkt-hist-main">' +
          '<div class="mkt-hist-price num">' + money(p.price) + '</div>' +
          '<div class="mkt-hist-meta muted">' + esc(p.platform || '—') + ' · ' + esc(p.condition || '—') + ' · ' + esc(p.record_date || '') + '</div>' +
          (p.note ? '<div class="mkt-hist-note">' + esc(p.note) + '</div>' : '') +
        '</div>' +
        '<div class="mkt-hist-actions">' +
          '<button type="button" class="btn btn--secondary btn--sm" data-act="edit" data-pid="' + p.id + '">编辑</button>' +
          '<button type="button" class="btn btn--danger btn--sm" data-act="del" data-pid="' + p.id + '">删除</button>' +
        '</div>' +
      '</div>';
    }).join('');
    return '<section class="block">' + head + '<div class="mkt-hist-list">' + rows + '</div></section>';
  }

  function pageHTML() {
    return '<div class="page-scroll" id="mkt-detail-page">' +
      infoHTML() +
      chartHTML() +
      historyHTML() +
    '</div>';
  }

  // ---- Canvas 走势折线 ----
  function drawChart() {
    var cv = document.getElementById('mkt-chart');
    if (!cv || !cv.getContext) return;
    var pts = state.records;
    var dpr = global.devicePixelRatio || 1;
    var w = cv.clientWidth || 320;
    var h = 180;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    cv.style.width = w + 'px';
    cv.style.height = h + 'px';
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (pts.length < 2) return;

    var padL = 48, padR = 12, padT = 16, padB = 28;
    var cw = w - padL - padR, ch = h - padT - padB;

    var prices = pts.map(function (p) { return num(p.price); });
    var min = Math.min.apply(null, prices);
    var max = Math.max.apply(null, prices);
    var range = max - min || 1;
    // 上下留 10% 余量
    var yMin = min - range * 0.1;
    var yMax = max + range * 0.1;
    var yRange = yMax - yMin || 1;

    function xAt(i) { return padL + (pts.length <= 1 ? cw / 2 : (cw * i / (pts.length - 1))); }
    function yAt(v) { return padT + ch - ((v - yMin) / yRange) * ch; }

    // 网格 + Y 轴刻度（3 条）
    ctx.strokeStyle = '#EEE';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#888';
    ctx.font = '10px system-ui';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (var i = 0; i <= 3; i++) {
      var yy = padT + ch * i / 3;
      var val = yMax - (yRange * i / 3);
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke();
      ctx.fillText((val / 100).toFixed(val >= 1000 ? 0 : 1), padL - 6, yy);
    }

    // X 轴日期（首尾 + 中间，最多 5 个）
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    var xLabels = [];
    var step = Math.max(1, Math.ceil(pts.length / 5));
    for (var j = 0; j < pts.length; j += step) xLabels.push(j);
    if (xLabels[xLabels.length - 1] !== pts.length - 1) xLabels.push(pts.length - 1);
    xLabels.forEach(function (idx) {
      var xx = xAt(idx);
      ctx.fillStyle = '#888';
      ctx.fillText(String(pts[idx].record_date || '').slice(5), xx, h - padB + 6);
    });

    // 折线
    ctx.strokeStyle = '#4A7CFF';
    ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach(function (p, i) {
      var xx = xAt(i), yy = yAt(num(p.price));
      if (i === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
    });
    ctx.stroke();

    // 折线下填充（半透明）
    ctx.lineTo(xAt(pts.length - 1), padT + ch);
    ctx.lineTo(xAt(0), padT + ch);
    ctx.closePath();
    ctx.fillStyle = 'rgba(74,124,255,0.1)';
    ctx.fill();

    // 数据点
    pts.forEach(function (p, i) {
      var xx = xAt(i), yy = yAt(num(p.price));
      ctx.beginPath(); ctx.arc(xx, yy, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#4A7CFF'; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
    });

    // 保存点坐标供点击
    cv._points = pts.map(function (p, i) {
      return { x: xAt(i), y: yAt(num(p.price)), rec: p };
    });
  }

  function bindChart() {
    var cv = document.getElementById('mkt-chart');
    if (!cv) return;
    var tip = document.getElementById('mkt-chart-tip');
    function showTip(e) {
      if (!cv._points || !tip) return;
      var rect = cv.getBoundingClientRect();
      var x = e.clientX - rect.left;
      var best = null, bestDist = 24;
      cv._points.forEach(function (pt) {
        var d = Math.abs(pt.x - x);
        if (d < bestDist) { bestDist = d; best = pt; }
      });
      if (best) {
        tip.innerHTML = '<span class="mkt-tip-price num">' + money(best.rec.price) + '</span>' +
          '<span class="muted">' + esc(best.rec.record_date || '') + (best.rec.platform ? ' · ' + esc(best.rec.platform) : '') + '</span>';
        tip.style.display = 'block';
      } else {
        tip.style.display = 'none';
      }
    }
    on(cv, 'mousemove', showTip);
    on(cv, 'touchstart', showTip, { passive: true });
    on(cv, 'mouseleave', function () { if (tip) tip.style.display = 'none'; });
  }

  function go(hash) { if (EATG.app && EATG.app.navigate) EATG.app.navigate(hash); }

  function rerender() {
    var page = document.getElementById('mkt-detail-page');
    if (!page) return;
    page.innerHTML = infoHTML() + chartHTML() + historyHTML();
    drawChart();
    bindChart();
  }

  function doDel(pid) {
    UI.confirmDialog({
      title: '删除行情',
      message: '删除后该谷子的估值与走势将同步更新，确认删除？',
      confirmText: '删除',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      S.del('price_records', pid).then(function () {
        return recomputeMarketPrice();
      }).then(function () {
        UI.toast('已删除', 'success');
        return reload();
      }).catch(function (err) {
        UI.toast('删除失败：' + (err && err.message || err), 'error');
      });
    });
  }

  /** 重新计算 goods.market_price（取最新一条） */
  function recomputeMarketPrice() {
    return S.query('price_records', 'goods_id', state.goodsId).then(function (list) {
      list.sort(function (a, b) {
        if (a.record_date !== b.record_date) return (b.record_date || '').localeCompare(a.record_date || '');
        return num(b.created_at) - num(a.created_at);
      });
      var g = state.goods;
      if (list.length) {
        g.market_price = num(list[0].price);
      } else {
        delete g.market_price;
      }
      return S.put('goods', g);
    });
  }

  function reload() {
    var ctx = { query: 'goods_id=' + state.goodsId };
    return load(ctx).then(function () { if (!state.destroyed) rerender(); });
  }

  function bind() {
    var page = document.getElementById('mkt-detail-page');
    if (!page) return;
    on(page, 'click', function (e) {
      var actEl = e.target.closest('[data-act]');
      if (!actEl) return;
      var act = actEl.dataset.act;
      if (act === 'add') { go('#/market/add?goods_id=' + state.goodsId); return; }
      var pid = Number(actEl.dataset.pid);
      if (act === 'edit') { go('#/market/add?id=' + pid); return; }
      if (act === 'del') { doDel(pid); return; }
    });
    bindChart();
  }

  function mount(container, ctx) {
    resetState();
    dom = { container: container };
    container.innerHTML = '<div class="loading">加载中…</div>';
    ctx.setTitle('行情详情');
    ctx.setBack(true);
    ctx.setActiveTab('market');
    return load(ctx).then(function () {
      if (state.destroyed) return;
      container.innerHTML = pageHTML();
      drawChart();
      bind();
    }).catch(function (err) {
      if (state.destroyed) return;
      if (!(err && err.expected)) console.error('[EATG] 行情详情加载失败', err);
      UI.toast('加载失败：' + (err && err.message || err), 'error');
    });
  }

  function unmount() {
    if (state) state.destroyed = true;
    clearOffs();
  }

  EATG.pages['market/detail'] = { key: 'market/detail', mount: mount, unmount: unmount };

})(window);
