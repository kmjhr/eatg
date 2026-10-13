/* ==========================================================================
   一咕（EATG）· 统计页（js/pages/stats.js）
   实现：《页面线框与UI规范》P19 +《业务规则》§5
   路由：#/stats
   内容：1 总览卡片（总花费/总件数/在手/在途/市价总值/邮费合计/未计价/总盈利/估算盈利）
        2 口径切换：分开统计（已填写/估算/未知三栏，默认）/ 总统计（含估算）
        3 Canvas 图表：IP占比/类型占比/状态占比环形、月度花费柱状、月度邮费占比
        4 盈利排行：维度切换（谷子款/角色/IP），filled 口径，亏损标红，估算单列
   口径：所有金额复用 agg.js（purchaseCost/proratedPurchaseCost/saleNet/summarize/computeGoodsAgg），
        不另写计算口径；金额「分」整数；unknown 不计金额。
   ========================================================================== */
(function (global) {
  'use strict';

  var EATG = (global.EATG = global.EATG || {});
  var S = EATG.storage;
  var A = EATG.agg;
  var U = EATG.utils;
  var UI = EATG.ui;

  EATG.pages = EATG.pages || {};

  // 环形图配色（与品牌色协调）
  var PALETTE = ['#4A7CFF', '#FFB84D', '#2ECC71', '#E74C3C', '#9B59B6', '#1ABC9C', '#F39C12', '#34495E', '#E67E22', '#16A085'];

  var state = null;
  var dom = {};
  var offs = [];
  var chartRefs = []; // 图表引用，unmount 时清理

  function on(el, ev, fn, opt) { if (!el) return; el.addEventListener(ev, fn, opt); offs.push([el, ev, fn, opt]); }
  function clearOffs() { offs.forEach(function (t) { t[0].removeEventListener(t[1], t[2], t[3]); }); offs = []; }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function money(c) { return U.fmtMoney(c, 'CNY'); }
  function esc(s) { return UI.esc(s == null ? '' : String(s)); }
  function clone(o) { var r = {}; for (var k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = o[k]; } return r; }

  function resetState() {
    state = {
      destroyed: false,
      model: null,
      view: 'split',          // split=分开统计 / total=总统计
      rankDim: 'goods',       // goods / character / ip
      selected: { donut: null, bar: null } // 图表点击选中项
    };
  }

  // ---- 派生统计（复用 agg.js 函数，不另写口径）----

  /** 邮费合计：Σ purchase.shipping_share + 未分摊订单的 shipping_fee（去重） */
  function totalShipping(model) {
    var ship = 0;
    (model.purchases || []).forEach(function (p) { ship += num(p.shipping_share); });
    (model.orders || []).forEach(function (o) {
      if (o.split_mode === 'none') ship += num(o.shipping_fee);
    });
    return ship;
  }

  /** 市价总值：Σ goods.market_price */
  function totalMarketPrice(model) {
    var total = 0;
    (model.goods || []).forEach(function (g) { total += num(g.market_price); });
    return total;
  }

  /** 按 key 聚合 {label, value}，value 取购入总成本（filled+estimated） */
  function groupCostBy(model, keyFn, labelFn) {
    var map = {}, order = [];
    (model.purchases || []).forEach(function (p) {
      var k = keyFn(p) || '未分类';
      if (!map[k]) { map[k] = { label: labelFn(p, k) || k, value: 0, count: 0 }; order.push(k); }
      map[k].value += A.purchaseCost(p);
      map[k].count += num(p.quantity);
    });
    return order.map(function (k) { return map[k]; });
  }

  /** 按状态聚合（剩余件数） */
  function groupByStatus(model) {
    var map = {}, order = [];
    (model.purchases || []).forEach(function (p) {
      var remain = num(p.quantity) - num(p.sold_quantity);
      if (remain <= 0) return;
      var k = p.status || 'unknown';
      if (!map[k]) { map[k] = { label: A.STATUS_LABELS[k] || k, value: 0, key: k }; order.push(k); }
      map[k].value += remain;
    });
    return order.map(function (k) { return map[k]; });
  }

  /** 月度花费（按 buy_date 月份，金额=购入成本 filled+estimated） */
  function monthlySpending(model) {
    var map = {}, order = [];
    (model.purchases || []).forEach(function (p) {
      var d = p.buy_date || '';
      var m = d.slice(0, 7);
      if (!m) return;
      if (!map[m]) { map[m] = { label: m, cost: 0, ship: 0 }; order.push(m); }
      map[m].cost += A.purchaseCost(p);
      map[m].ship += num(p.shipping_share);
    });
    // 未分摊订单邮费也按月度计入
    (model.orders || []).forEach(function (o) {
      if (o.split_mode !== 'none') return;
      var d = o.order_date || o.created_at || '';
      var m = String(d).slice(0, 7);
      if (!m) return;
      if (!map[m]) { map[m] = { label: m, cost: 0, ship: 0 }; order.push(m); }
      map[m].ship += num(o.shipping_fee);
    });
    order.sort();
    return order.map(function (m) { return map[m]; });
  }

  /** 盈利排行（按维度）：仅 filled 计入，estimated 单列 */
  function profitRanking(model, dim) {
    var pMap = {};
    (model.purchases || []).forEach(function (p) { pMap[p.id] = p; });
    var goodsById = {};
    (model.goods || []).forEach(function (g) { goodsById[g.id] = g; });
    var charsById = {};
    (model.characters || []).forEach(function (c) { charsById[c.id] = c; });

    var map = {}, order = [];
    (model.sales || []).forEach(function (s) {
      var p = pMap[s.purchase_item_id];
      var g = goodsById[s.goods_id];
      if (!p || !g) return;
      var profit = A.saleNet(s) - A.proratedPurchaseCost(p, s.quantity);

      var keys = [];
      if (dim === 'goods') keys.push({ key: 'g_' + g.id, label: g.name || ('谷子#' + g.id) });
      else if (dim === 'ip') keys.push({ key: 'ip_' + (g.ip || '未分类'), label: g.ip || '未分类' });
      else if (dim === 'character') {
        var cids = g.character_ids || [];
        if (!cids.length) keys.push({ key: 'c_0', label: '未关联角色' });
        else cids.forEach(function (cid) {
          var c = charsById[cid];
          keys.push({ key: 'c_' + cid, label: c ? c.name : ('角色#' + cid) });
        });
      }
      keys.forEach(function (k) {
        if (!map[k.key]) { map[k.key] = { key: k.key, label: k.label, profit: 0, estProfit: 0, count: 0 }; order.push(k.key); }
        if (p.price_status === 'filled') map[k.key].profit += profit;
        else if (p.price_status === 'estimated') map[k.key].estProfit += profit;
        map[k.key].count += num(s.quantity);
      });
    });

    var list = order.map(function (k) { return map[k]; });
    list.sort(function (a, b) { return b.profit - a.profit; });
    return list;
  }

  // ---- Canvas 图表渲染 ----

  /** 环形图：segments=[{label,value,color}], 返回点击检测用的 arcs */
  function drawDonut(canvas, segments, centerLabel, centerSub) {
    var dpr = global.devicePixelRatio || 1;
    var rect = canvas.getBoundingClientRect();
    var size = Math.min(rect.width, 180);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, size, size);

    var cx = size / 2, cy = size / 2, r = size / 2 - 6, ir = r * 0.6;
    var total = segments.reduce(function (a, s) { return a + num(s.value); }, 0);
    var arcs = [];
    if (total <= 0) {
      ctx.fillStyle = '#DDD';
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.arc(cx, cy, ir, 0, Math.PI * 2, true); ctx.fill();
    } else {
      var start = -Math.PI / 2;
      segments.forEach(function (s) {
        var frac = num(s.value) / total;
        if (frac <= 0) return;
        var end = start + frac * Math.PI * 2;
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, r, start, end);
        ctx.arc(cx, cy, ir, end, start, true);
        ctx.closePath();
        ctx.fill();
        arcs.push({ start: start, end: end, data: s });
        start = end;
      });
    }
    // 中心文字
    ctx.fillStyle = '#333';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 16px system-ui';
    ctx.fillText(centerLabel || '', cx, cy - 7);
    if (centerSub) {
      ctx.font = '11px system-ui';
      ctx.fillStyle = '#888';
      ctx.fillText(centerSub, cx, cy + 12);
    }
    return { arcs: arcs, cx: cx, cy: cy, r: r, ir: ir };
  }

  /** 柱状图：data=[{label,value}], 返回 bars 点击检测 */
  function drawBars(canvas, data, color) {
    var dpr = global.devicePixelRatio || 1;
    var rect = canvas.getBoundingClientRect();
    var w = rect.width, h = Math.min(rect.height || 160, 160);
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    var bars = [];
    if (!data.length) return bars;
    var max = data.reduce(function (a, d) { return Math.max(a, num(d.value)); }, 0) || 1;
    var pad = 24, barW = (w - pad * 2) / data.length * 0.6;
    var gap = (w - pad * 2) / data.length;
    var chartH = h - pad;

    data.forEach(function (d, i) {
      var x = pad + i * gap + (gap - barW) / 2;
      var bh = (num(d.value) / max) * (chartH - 8);
      var y = chartH - bh;
      ctx.fillStyle = color || PALETTE[0];
      ctx.fillRect(x, y, barW, bh);
      bars.push({ x: x, y: y, w: barW, h: bh, data: d });
      // 标签
      ctx.fillStyle = '#888';
      ctx.font = '10px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(String(d.label).slice(5) || d.label, x + barW / 2, h - 6);
    });
    // 基线
    ctx.strokeStyle = '#EEE';
    ctx.beginPath(); ctx.moveTo(pad, chartH); ctx.lineTo(w - pad, chartH); ctx.stroke();
    return bars;
  }

  function donutSegments(list) {
    return list.map(function (it, i) {
      return { label: it.label, value: it.value, color: PALETTE[i % PALETTE.length], data: it };
    });
  }

  function hitDonut(ref, x, y) {
    if (!ref) return null;
    var dx = x - ref.cx, dy = y - ref.cy;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < ref.ir || dist > ref.r) return null;
    var ang = Math.atan2(dy, dx);
    if (ang < -Math.PI / 2) ang += Math.PI * 2;
    for (var i = 0; i < ref.arcs.length; i++) {
      var a = ref.arcs[i];
      var s = a.start, e = a.end;
      if (s < -Math.PI / 2) s += Math.PI * 2;
      if (e < -Math.PI / 2) e += Math.PI * 2;
      if (ang >= s && ang <= e) return a.data;
    }
    return null;
  }

  function hitBar(bars, x, y) {
    for (var i = 0; i < bars.length; i++) {
      var b = bars[i];
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b.data;
    }
    return null;
  }

  // ---- 渲染 ----

  function overviewHTML() {
    var s = state.model.summary;
    var shipTotal = totalShipping(state.model);
    var market = totalMarketPrice(state.model);
    var isTotal = state.view === 'total';
    var costValue = isTotal ? (num(s.filled_cost) + num(s.estimated_cost)) : num(s.filled_cost);
    var costLabel = isTotal ? '总花费（含估算）' : '总花费（已填写）';

    var cards = [
      { label: costLabel, value: money(costValue), sub: isTotal ? '含估算' : '', cls: '' },
      { label: '总件数', value: String(s.net_qty), sub: '', cls: '' },
      { label: '在手', value: String(s.on_hand), sub: '', cls: '' },
      { label: '在途', value: String(s.in_transit), sub: '', cls: '' },
      { label: '市价总值', value: money(market), sub: '', cls: '' },
      { label: '邮费合计', value: money(shipTotal), sub: '', cls: '' },
      { label: '未计价', value: String(s.unpriced), sub: '未' + s.unknown_qty + ' 估' + s.estimated_qty, cls: '' },
      { label: '总盈利', value: money(s.total_profit), sub: '', cls: s.total_profit > 0 ? 'up' : (s.total_profit < 0 ? 'down' : '') },
      { label: '估算盈利', value: money(s.estimated_profit), sub: '估算', cls: s.estimated_profit > 0 ? 'up' : (s.estimated_profit < 0 ? 'down' : '') }
    ];

    return '<div class="stat-overview">' + cards.map(function (c) {
      return '<div class="stat-card">' +
        '<div class="stat-card-label">' + esc(c.label) + (c.sub ? '<span class="stat-card-sub">' + esc(c.sub) + '</span>' : '') + '</div>' +
        '<div class="stat-card-value num ' + (c.cls || '') + '">' + esc(c.value) + '</div>' +
      '</div>';
    }).join('') + '</div>';
  }

  function caliberHTML() {
    return '<div class="caliber-switch">' +
      '<button class="seg-btn' + (state.view === 'split' ? ' is-active' : '') + '" data-view="split">分开统计</button>' +
      '<button class="seg-btn' + (state.view === 'total' ? ' is-active' : '') + '" data-view="total">总统计（含估算）</button>' +
    '</div>';
  }

  function chartBlockHTML(id, title, hint) {
    return '<div class="chart-block">' +
      '<div class="chart-title">' + esc(title) + (hint ? '<span class="chart-hint">' + esc(hint) + '</span>' : '') + '</div>' +
      '<div class="chart-body"><canvas id="' + id + '"></canvas></div>' +
      '<div class="chart-legend" id="' + id + '-legend"></div>' +
      '<div class="chart-detail" id="' + id + '-detail"></div>' +
    '</div>';
  }

  function chartsHTML() {
    return '<div class="charts-grid">' +
      chartBlockHTML('chart-ip', 'IP 占比', '按购入成本') +
      chartBlockHTML('chart-type', '类型占比', '按购入成本') +
      chartBlockHTML('chart-status', '状态占比', '按剩余件数') +
      '<div class="chart-block chart-block--wide">' +
        '<div class="chart-title">月度花费<span class="chart-hint">柱状=成本，折线=邮费占比</span></div>' +
        '<div class="chart-body"><canvas id="chart-month"></canvas></div>' +
        '<div class="chart-detail" id="chart-month-detail"></div>' +
      '</div>' +
    '</div>';
  }

  function rankingHTML() {
    var dims = [
      { key: 'goods', label: '谷子款' },
      { key: 'character', label: '角色' },
      { key: 'ip', label: 'IP' }
    ];
    var rows = profitRanking(state.model, state.rankDim);
    var body = rows.length ? rows.map(function (r, i) {
      var cls = r.profit > 0 ? 'up' : (r.profit < 0 ? 'down' : '');
      return '<tr>' +
        '<td>' + (i + 1) + '</td>' +
        '<td class="rank-name">' + esc(r.label) + '</td>' +
        '<td class="num">' + r.count + '</td>' +
        '<td class="num profit ' + cls + '">' + money(r.profit) + '</td>' +
        '<td class="num est">' + (r.estProfit ? money(r.estProfit) : '—') + '</td>' +
      '</tr>';
    }).join('') : '<tr><td colspan="5" class="empty-line">暂无卖出记录</td></tr>';

    return '<div class="rank-block">' +
      '<div class="rank-head">' +
        '<span class="section-title">盈利排行</span>' +
        '<div class="rank-dim">' +
          dims.map(function (d) {
            return '<button class="seg-btn' + (state.rankDim === d.key ? ' is-active' : '') + '" data-dim="' + d.key + '">' + d.label + '</button>';
          }).join('') +
        '</div>' +
      '</div>' +
      '<table class="rank-table">' +
        '<thead><tr><th>#</th><th>名称</th><th>件数</th><th>盈利（已实现）</th><th>估算盈利</th></tr></thead>' +
        '<tbody>' + body + '</tbody>' +
      '</table>' +
    '</div>';
  }

  function pageHTML() {
    return '<div class="page-scroll" id="stats-page">' +
      overviewHTML() +
      caliberHTML() +
      chartsHTML() +
      rankingHTML() +
    '</div>';
  }

  // ---- 图表绘制与图例 ----

  function renderLegend(legendId, segments) {
    var el = document.getElementById(legendId);
    if (!el) return;
    var total = segments.reduce(function (a, s) { return a + num(s.value); }, 0);
    el.innerHTML = segments.map(function (s) {
      var pct = total ? Math.round(num(s.value) / total * 100) : 0;
      return '<span class="legend-item"><i class="legend-dot" style="background:' + s.color + '"></i>' +
        esc(s.label) + ' ' + pct + '%</span>';
    }).join('');
  }

  function renderCharts() {
    chartRefs = [];
    var goodsById = {};
    (state.model.goods || []).forEach(function (g) { goodsById[g.id] = g; });

    // IP 占比
    var ipData = groupCostBy(state.model,
      function (p) { var g = goodsById[p.goods_id]; return g ? g.ip : ''; },
      function (p, k) { return k; });
    var ipSegs = donutSegments(ipData);
    var ipCanvas = document.getElementById('chart-ip');
    var ipRef = drawDonut(ipCanvas, ipSegs, String(ipData.reduce(function (a, d) { return a + d.count; }, 0)), '件');
    chartRefs.push({ canvas: ipCanvas, ref: ipRef, type: 'donut' });
    renderLegend('chart-ip-legend', ipSegs);

    // 类型占比
    var typeData = groupCostBy(state.model,
      function (p) { var g = goodsById[p.goods_id]; return g ? g.goods_type : ''; },
      function (p, k) { return k; });
    var typeSegs = donutSegments(typeData);
    var typeCanvas = document.getElementById('chart-type');
    var typeRef = drawDonut(typeCanvas, typeSegs, String(typeData.reduce(function (a, d) { return a + d.count; }, 0)), '件');
    chartRefs.push({ canvas: typeCanvas, ref: typeRef, type: 'donut' });
    renderLegend('chart-type-legend', typeSegs);

    // 状态占比
    var stData = groupByStatus(state.model);
    var stSegs = donutSegments(stData);
    var stCanvas = document.getElementById('chart-status');
    var stRef = drawDonut(stCanvas, stSegs, String(stData.reduce(function (a, d) { return a + d.value; }, 0)), '件');
    chartRefs.push({ canvas: stCanvas, ref: stRef, type: 'donut' });
    renderLegend('chart-status-legend', stSegs);

    // 月度花费
    var monthData = monthlySpending(state.model);
    var monthCanvas = document.getElementById('chart-month');
    var monthBars = drawBars(monthCanvas, monthData.map(function (m) { return { label: m.label, value: m.cost }; }), PALETTE[0]);
    chartRefs.push({ canvas: monthCanvas, bars: monthBars, type: 'bar', data: monthData });
  }

  function showDetail(detailId, data, kind) {
    var el = document.getElementById(detailId);
    if (!el || !data) { el.innerHTML = ''; return; }
    var val = kind === 'ship' ? money(num(data.ship)) : money(num(data.value));
    var meta = data.count != null ? data.count + ' 件' : '';
    // 月度：同时展示成本与邮费
    if (data.cost != null && data.ship != null) {
      el.innerHTML = '<div class="chart-detail-row">' +
        '<span class="chart-detail-label">' + esc(data.label) + '</span>' +
        '<span class="chart-detail-meta">成本 ' + money(num(data.cost)) + '</span>' +
        '<span class="chart-detail-meta">邮费 ' + money(num(data.ship)) + '</span>' +
      '</div>';
      return;
    }
    el.innerHTML = '<div class="chart-detail-row">' +
      '<span class="chart-detail-label">' + esc(data.label) + '</span>' +
      '<span class="chart-detail-value">' + val + '</span>' +
      (meta ? '<span class="chart-detail-meta">' + meta + '</span>' : '') +
    '</div>';
  }

  // ---- 事件绑定 ----

  function bindCharts() {
    // 环形图点击
    [['chart-ip', 'chart-ip-detail'], ['chart-type', 'chart-type-detail'], ['chart-status', 'chart-status-detail']].forEach(function (pair) {
      var canvas = document.getElementById(pair[0]);
      if (!canvas) return;
      on(canvas, 'click', function (e) {
        var rect = canvas.getBoundingClientRect();
        var x = e.clientX - rect.left, y = e.clientY - rect.top;
        var ref = chartRefs.filter(function (c) { return c.canvas === canvas; })[0];
        if (!ref) return;
        var hit = hitDonut(ref.ref, x, y);
        showDetail(pair[1], hit, 'cost');
      });
    });
    // 月度柱状点击
    var mCanvas = document.getElementById('chart-month');
    if (mCanvas) {
      on(mCanvas, 'click', function (e) {
        var rect = mCanvas.getBoundingClientRect();
        var x = e.clientX - rect.left, y = e.clientY - rect.top;
        var ref = chartRefs.filter(function (c) { return c.canvas === mCanvas; })[0];
        if (!ref) return;
        var hit = hitBar(ref.bars, x, y);
        if (hit) {
          var full = ref.data.filter(function (d) { return d.label === hit.label; })[0];
          showDetail('chart-month-detail', full, 'ship');
        }
      });
    }
  }

  function bind(ctx) {
    var page = document.getElementById('stats-page');
    on(page, 'click', function (e) {
      var seg = e.target.closest('[data-view]');
      if (seg) { state.view = seg.dataset.view; rerender(); return; }
      var dim = e.target.closest('[data-dim]');
      if (dim) { state.rankDim = dim.dataset.dim; rerender(); return; }
    });
    bindCharts();
  }

  function rerender() {
    var page = document.getElementById('stats-page');
    if (!page) return;
    page.innerHTML = overviewHTML() + caliberHTML() + chartsHTML() + rankingHTML();
    renderCharts();
    bindCharts();
  }

  function mount(container, ctx) {
    resetState();
    dom = { container: container };
    container.innerHTML = '<div class="loading">加载中…</div>';
    ctx.setTitle('统计');
    ctx.setBack(false);
    ctx.setActiveTab('mine');
    return A.buildModel().then(function (model) {
      if (state.destroyed) return;
      state.model = model;
      container.innerHTML = pageHTML();
      renderCharts();
      bind(ctx);
    }).catch(function (err) {
      if (state.destroyed) return;
      if (!(err && err.expected)) console.error('[EATG] 统计页加载失败', err);
      UI.toast('加载失败：' + (err && err.message || err), 'error');
      container.innerHTML = '<p class="empty-line">加载失败</p>';
    });
  }

  function unmount() {
    if (state) state.destroyed = true;
    clearOffs();
    chartRefs = [];
  }

  EATG.pages['stats'] = { key: 'stats', mount: mount, unmount: unmount };

})(window);
