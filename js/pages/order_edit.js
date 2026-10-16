/* ==========================================================================
   一咕（EATG）· 订单详情/新建订单页（js/pages/order_edit.js）
   实现：《详细开发指南》第5步 +《页面线框与UI规范》P07 +《业务规则》§1/§2
   路由：#/order/edit?mode=new | #/order/edit?id=<order_id>
   内容：1 订单信息（名称/日期/渠道/截图/备注）
        2 金额区（本体合计、邮费、实付总额＝本体合计+邮费 自动）
        3 邮费分摊模式（per_item 按件均摊(含数量加权) / by_amount 按金额比例 / manual 手动指定 / none 未分摊）
          + 应用按钮；实时重算 + 逐件微调
        4 打包订单（is_bundle）+ 本体拆分（按件均摊本体 / 按市场参考价比例 / 手动指定）；
          未分摊件 unit_price=null、price_status='unknown'，显示“价格待分”
        5 谷子清单：添加（选已有/新建，自动生成购入记录）/ 移除 / 逐件显示 本体·邮费分摊·小计
        6 账目平衡校验：paid_total === Σ本体 + Σ分摊，不平衡红色高亮并阻止保存；尾差并入最后一件并提示
        7 订单详情 ↔ 谷子款详情 互跳
   口径：金额「分」整数；尾差处理见《业务规则》§2；平衡校验见《业务规则》§1；
        未分摊（none）时各件 shipping_share=0，订单邮费仅计入全局“邮费合计”（O-06）。
   数据：一律走 EATG.storage；聚合走 EATG.agg。
   ========================================================================== */
(function (global) {
  'use strict';

  var EATG = (global.EATG = global.EATG || {});
  var S = EATG.storage;
  var A = EATG.agg;
  var U = EATG.utils;
  var UI = EATG.ui;

  EATG.pages = EATG.pages || {};

  var state = null;
  var dom = {};
  var offs = [];

  function on(el, ev, fn, opt) { if (!el) return; el.addEventListener(ev, fn, opt); offs.push([el, ev, fn, opt]); }
  function clearOffs() { offs.forEach(function (t) { t[0].removeEventListener(t[1], t[2], t[3]); }); offs = []; }
  function clone(o) { var r = {}; for (var k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = o[k]; } return r; }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function money(c) { return U.fmtMoney(c, 'CNY'); }
  function expectedError(msg) { var e = new Error(msg); e.expected = true; return e; }

  // 金额：元（字符串）<-> 分（整数），严格无浮点误差
  function yuanToCents(s) {
    s = String(s == null ? '' : s).trim();
    if (!s) return null;
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
    return Math.round(Number(s) * 100);
  }
  function centsToYuan(c) {
    if (c == null || !isFinite(Number(c))) return '';
    var fixed = (Number(c) / 100).toFixed(2);
    return fixed.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  }
  /** 读取金额输入框为分：空串→0，非法→dflt */
  function centsOr(el, dflt) {
    if (!el) return dflt;
    var raw = String(el.value == null ? '' : el.value).trim();
    if (raw === '') return 0;
    var c = yuanToCents(raw);
    if (c == null || isNaN(c)) return dflt;
    return c;
  }

  function resetState() {
    state = {
      destroyed: false,
      busy: false,
      isNew: true,
      orderId: null,
      order: {},
      items: [],
      removed: [],            // 移除的订单行：保存时解除关联（order_id=null），不删除购入记录
      goodsList: [],
      goodsById: {},
      purchasesByGoods: {},
      enums: { channel: [], ip: [], goods_type: [] },
      isBundle: false,
      splitMode: 'per_item',
      bodyMode: 'per_item',
      paidManual: false,   // 实付总额是否手动填写（不再自动跟随本体+邮费）
      orderImage: null,
      preAddGid: null,
      preAddApplied: false
    };
  }

  // ---- 数据加载 ----

  function load(ctx) {
    var params = new URLSearchParams(ctx.query || '');
    var idParam = params.get('id');
    var hasId = !!(idParam != null && idParam !== '' && isFinite(Number(idParam)) && Number(idParam));
    state.isNew = !hasId;
    var addGid = params.get('add_gid');
    state.preAddGid = (addGid != null && addGid !== '' && isFinite(Number(addGid))) ? Number(addGid) : null;

    return Promise.all([S.getAll('goods'), S.getAll('enums'), S.getAll('purchase_items')]).then(function (r) {
      state.goodsList = r[0] || [];
      state.goodsById = {};
      state.goodsList.forEach(function (g) { state.goodsById[Number(g.id)] = g; });
      var em = {};
      (r[1] || []).forEach(function (row) { em[row.key] = row.values || []; });
      state.enums = { channel: em.channel || [], ip: em.ip || [], goods_type: em.goods_type || [] };
      // 全部购入记录按谷子款分组（用于「复用未关联订单的记录」）
      state.purchasesByGoods = {};
      (r[2] || []).forEach(function (p) {
        (state.purchasesByGoods[Number(p.goods_id)] = state.purchasesByGoods[Number(p.goods_id)] || []).push(p);
      });

      if (state.isNew) {
        state.order = {
          order_date: U.todayStr(),
          currency: (EATG.runtime && EATG.runtime.defaultCurrency) || 'CNY',
          goods_total: 0,
          shipping_fee: 0
        };
        state.splitMode = 'per_item';
        state.bodyMode = 'per_item';
        return null;
      }

      var id = Number(idParam);
      return Promise.all([S.get('orders', id), S.query('purchase_items', 'order_id', id)]).then(function (rr) {
        var o = rr[0];
        if (!o) throw expectedError('未找到该订单（id=' + id + '）');
        state.order = o;
        state.orderId = Number(o.id);
        state.isNew = false;
        state.paidManual = !!o.paid_manual;
        state.splitMode = o.split_mode || 'per_item';
        state.bodyMode = 'per_item';
        state.isBundle = !!o.is_bundle;
        state.orderImage = o.order_image || null;
        state.items = (rr[1] || []).map(function (p) {
          var rec = clone(p);
          var g = state.goodsById[p.goods_id];
          rec._gname = g ? (g.name || '未命名') : ('谷子#' + p.goods_id);
          rec._market_price = (g && g.market_price != null) ? g.market_price : null;
          return rec;
        }).sort(function (a, b) { return Number(a.id) - Number(b.id); });
      });
    });
  }

  // ---- 派生计算（《业务规则》§1/§2） ----

  function computeModel() {
    var shipFee = num(state.order.shipping_fee);
    var sumBody = 0, sumAlloc = 0, count = 0;
    state.items.forEach(function (it) {
      var q = num(it.quantity);
      count += q;
      if (it.unit_price != null) sumBody += it.unit_price * q;
      sumAlloc += num(it.shipping_share);
    });
    var goodsTotal = state.isBundle ? num(state.order.goods_total) : sumBody;
    // 实付：手动填写则用手动值，否则自动 = 本体合计 + 邮费
    var paid = state.paidManual ? num(state.order.paid_total) : (goodsTotal + shipFee);

    var balanced, diff = 0, pendingBody = 0, pendingShip = 0;
    if (state.paidManual) {
      // 手动实付：允许「余款」（订单还没核销完的钱），关联谷子本体合计与分摊不得超过实付与邮费
      var overBody = sumBody - paid;
      var overShip = sumAlloc - shipFee;
      balanced = (overBody <= 0) && (overShip <= 0);
      diff = Math.max(overBody, overShip, 0);
    } else if (state.isBundle) {
      var overBody = sumBody - goodsTotal;
      var overShip = sumAlloc - shipFee;
      balanced = (overBody <= 0) && (overShip <= 0);
      diff = Math.max(overBody, overShip, 0);
      pendingBody = Math.max(0, -overBody);
      pendingShip = Math.max(0, -overShip);
    } else if (state.splitMode === 'none') {
      balanced = (sumBody === goodsTotal);   // 未分摊：邮费不计入各件（O-06）
      diff = goodsTotal - sumBody;
    } else {
      balanced = (sumBody === goodsTotal) && (sumAlloc === shipFee);
      diff = shipFee - sumAlloc;
    }
    var remain = paid - sumBody - sumAlloc;
    return {
      goodsTotal: goodsTotal, shipFee: shipFee, sumBody: sumBody, sumAlloc: sumAlloc,
      paid: paid, count: count, balanced: balanced, diff: diff, remain: remain,
      pendingBody: pendingBody, pendingShip: pendingShip
    };
  }

  // ---- 模板 ----

  function skeletonHTML() {
    return '<div class="skeleton skeleton-bar" style="width:45%;height:22px;margin-bottom:12px"></div>' +
      '<div class="skeleton skeleton-bar" style="width:100%;height:180px;margin-bottom:12px"></div>' +
      '<div class="skeleton skeleton-bar" style="width:100%;height:160px"></div>';
  }

  function infoHTML() {
    var channels = state.enums.channel || [];
    var chOpts = '<option value=""' + (state.order.channel ? '' : ' selected') + '>不填渠道</option>' +
      channels.map(function (c) {
        return '<option value="' + UI.esc(c) + '"' + (state.order.channel === c ? ' selected' : '') + '>' + UI.esc(c) + '</option>';
      }).join('');
    var img = state.orderImage
      ? '<div class="order-img"><img src="' + state.orderImage + '" alt="" data-act="edit-img"><button type="button" class="cell-edit" data-act="edit-img">编辑</button><button type="button" class="cell-del" data-act="rm-img" aria-label="移除截图">×</button></div>'
      : '<span class="order-img-add" style="position:relative">＋<span>订单截图</span>' +
        '<input type="file" id="o-file" class="input-cover" accept="image/*"></span>';
    return '<div class="form-section">' +
      '<h2 class="section-title">订单信息</h2>' +
      '<div class="field"><div class="field-head"><label class="field-label" for="o-name">订单名称</label></div>' +
        '<input id="o-name" class="input" type="text" autocomplete="off" placeholder="如：5月 MyGO 合单" value="' + UI.esc(state.order.order_name || '') + '"></div>' +
      '<div class="field"><div class="field-head"><label class="field-label" for="o-date">下单日期</label></div>' +
        '<input id="o-date" class="input" type="date" value="' + UI.esc(state.order.order_date || '') + '"></div>' +
      '<div class="field"><div class="field-head"><label class="field-label" for="o-channel">渠道</label></div>' +
        '<div class="input-row"><select id="o-channel" class="input">' + chOpts + '</select>' +
        '<button type="button" class="add-btn" data-act="add-channel">＋ 新增</button></div></div>' +
      '<div class="field"><div class="field-head"><span class="field-label">订单截图</span></div>' +
        '<div class="order-img-grid" id="o-img">' + img + '</div>' +
        '<p class="hint">压缩后存本机（剥离 EXIF），不上传。</p></div>' +
      '<div class="field"><div class="field-head"><label class="field-label" for="o-note">备注</label></div>' +
        '<textarea id="o-note" class="textarea" placeholder="如：合单说明、分摊备注">' + UI.esc(state.order.note || '') + '</textarea></div>' +
      '</div>';
  }

  function amountHTML() {
    var body;
    if (state.isBundle) {
      body = '<div class="agg-cell">' +
        '<div class="money-input"><input id="o-goods-total" class="input amount-input" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00" value="' + UI.esc(centsToYuan(state.order.goods_total)) + '"><span class="unit">元</span></div>' +
        '<div class="agg-label">整盒总价（本体合计）</div></div>';
    } else {
      body = '<div class="agg-cell">' +
        '<div class="agg-num num" id="o-body">' + money(state.order.goods_total || 0) + '</div>' +
        '<div class="agg-label">本体合计（自动 Σ各件）</div></div>';
    }
    return '<div class="form-section"><h2 class="section-title">金额</h2>' +
      '<div class="agg-grid amount-grid">' + body +
      '<div class="agg-cell"><div class="money-input"><input id="o-ship" class="input amount-input" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00" value="' + UI.esc(centsToYuan(state.order.shipping_fee)) + '"><span class="unit">元</span></div>' +
        '<div class="agg-label">邮费</div></div>' +
      '<div class="agg-cell"><div class="money-input"><input id="o-paid-input" class="input amount-input" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00" value="' + UI.esc(centsToYuan(state.paidManual ? num(state.order.paid_total) : ((num(state.order.goods_total) || 0) + num(state.order.shipping_fee)))) + '"><span class="unit">元</span></div>' +
        '<div class="agg-label">实付总额（默认=本体合计+邮费，可手动改）</div></div>' +
      '</div></div>';
  }

  function modeChip(mode, label, cur, attr) {
    return '<button type="button" class="opt-chip' + (cur === mode ? ' is-on' : '') + '" data-' + attr + '="' + mode + '">' + label + '</button>';
  }

  function splitHintText() {
    var t = {
      per_item: '按件数加权均摊邮费；尾差并入最后一件。',
      by_amount: '按各件本体金额占比摊邮费（所有件单价须已知）；尾差并入最后一件。',
      manual: '逐件填写邮费分摊；应用时不足部分自动并入最后一件（尾差提示）。',
      none: '各件邮费分摊记为 0；订单邮费仅计入全局「邮费合计」。'
    }[state.splitMode] || '';
    if (state.isBundle) t += ' 打包订单：本体可留空显示「价格待分」，未分摊部分计入「价格未知」单列。';
    return t;
  }

  function splitHTML() {
    var modes = [['per_item', '按件均摊'], ['by_amount', '按金额比例'], ['manual', '手动指定'], ['none', '未分摊']];
    var chips = modes.map(function (m) { return modeChip(m[0], m[1], state.splitMode, 'mode'); }).join('');
    var bmodes = [['per_item', '按件均摊本体'], ['market', '按市场参考价比例'], ['manual', '手动指定']];
    var bchips = bmodes.map(function (m) { return modeChip(m[0], m[1], state.bodyMode, 'bmode'); }).join('');
    return '<div class="form-section">' +
      '<h2 class="section-title">分摊设置</h2>' +
      '<label class="switch switch--row"><input type="checkbox" id="o-bundle"' + (state.isBundle ? ' checked' : '') + '><span class="switch-track"></span>' +
        '<span class="switch-label">打包订单（整盒/买盘，本体待拆分）</span></label>' +
      '<p class="split-sub">邮费分摊模式</p>' +
      '<div class="chip-select" id="o-modes">' + chips + '</div>' +
      '<button type="button" class="btn btn--secondary apply-split-btn" data-act="apply-split">应用邮费分摊</button>' +
      (state.isBundle
        ? '<p class="split-sub">本体拆分模式</p><div class="chip-select" id="o-bmodes">' + bchips + '</div>' +
          '<button type="button" class="btn btn--secondary apply-split-btn" data-act="apply-body">应用本体拆分</button>'
        : '') +
      '<p class="hint" id="o-split-hint">' + splitHintText() + '</p>' +
      '</div>';
  }

  function itemRowHTML(it, i) {
    var q = num(it.quantity) || 1;
    var unitVal = it.unit_price == null ? '' : centsToYuan(it.unit_price);
    var shareVal = num(it.shipping_share) ? centsToYuan(num(it.shipping_share)) : '';
    var ph = state.isBundle ? '价格待分' : '0.00';
    var statusOpts = A.STATUS_ORDER.map(function (s) {
      return '<option value="' + s + '"' + (it.status === s ? ' selected' : '') + '>' + UI.esc(A.STATUS_LABELS[s]) + '</option>';
    }).join('');
    return '<div class="oi-row" data-i="' + i + '">' +
      '<div class="oi-top">' +
        '<button type="button" class="oi-name" data-act="goto-goods" data-gid="' + it.goods_id + '">' + UI.esc(it._gname || ('谷子#' + it.goods_id)) + '</button>' +
        '<button type="button" class="oi-del" data-act="rm-item" data-i="' + i + '">移除</button>' +
      '</div>' +
      '<div class="oi-fields">' +
        '<label class="oi-field"><span>数量</span><input class="input input--mini" data-f="qty" data-i="' + i + '" type="number" min="1" step="1" inputmode="numeric" value="' + q + '"></label>' +
        '<label class="oi-field"><span>本体单价</span><input class="input input--mini" data-f="unit" data-i="' + i + '" type="text" inputmode="decimal" autocomplete="off" placeholder="' + ph + '" value="' + UI.esc(unitVal) + '"></label>' +
        '<label class="oi-field"><span>邮费分摊</span><input class="input input--mini" data-f="share" data-i="' + i + '" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00" value="' + UI.esc(shareVal) + '"></label>' +
        '<label class="oi-field"><span>状态</span><select class="input input--mini" data-f="status" data-i="' + i + '">' + statusOpts + '</select></label>' +
      '</div>' +
      '<div class="oi-sum" data-sum="' + i + '"></div>' +
      '</div>';
  }

  function itemsHTML() {
    var n = state.items.reduce(function (a, it) { return a + num(it.quantity); }, 0);
    var head = '<div class="block-head"><h2 class="section-title">谷子清单（' + n + ' 件）</h2>' +
      '<button type="button" class="block-action" data-act="add-item">＋ 添加谷子</button></div>';
    var body = state.items.length
      ? '<div class="oi-list" id="o-items">' + state.items.map(itemRowHTML).join('') + '</div>'
      : '<p class="empty-line">暂无谷子，点右上「＋ 添加谷子」</p>';
    return '<div class="form-section">' + head + body + '</div>';
  }

  function balanceHTML() {
    return '<div class="balance-row" id="o-balance"><span class="balance-mark" id="o-bmark">✓</span><span id="o-btext">账目平衡</span></div>';
  }

  function actionsHTML() {
    var del = state.isNew ? '' : '<button type="button" class="btn btn--danger" data-act="del-order">删除</button>';
    return '<div class="detail-spacer"></div>' +
      '<div class="detail-actions">' + del +
      '<button type="button" class="btn btn--primary" id="o-save" data-act="save">保存</button></div>';
  }

  function pageHTML() {
    return '<section class="page page--order">' +
      infoHTML() + amountHTML() + splitHTML() + itemsHTML() + balanceHTML() + actionsHTML() +
      '</section>';
  }

  // ---- 渲染 ----

  function render() {
    clearOffs();
    dom.container.innerHTML = pageHTML();
    cacheDom();
    bind();
    updateAll();
  }

  function cacheDom() {
    var c = dom.container;
    dom.page = c.querySelector('.page--order');
    dom.name = c.querySelector('#o-name');
    dom.date = c.querySelector('#o-date');
    dom.channel = c.querySelector('#o-channel');
    dom.note = c.querySelector('#o-note');
    dom.ship = c.querySelector('#o-ship');
    dom.goodsTotal = c.querySelector('#o-goods-total');
    dom.body = c.querySelector('#o-body');
    dom.paid = c.querySelector('#o-paid');
    dom.paidInput = c.querySelector('#o-paid-input');
    dom.items = c.querySelector('#o-items');
    dom.balance = c.querySelector('#o-balance');
    dom.bmark = c.querySelector('#o-bmark');
    dom.btext = c.querySelector('#o-btext');
    dom.saveBtn = c.querySelector('#o-save');
    dom.file = c.querySelector('#o-file');
  }

  function updateAll() {
    updateItemSums();
    updateAmounts();
    updateModeChips();
  }

  function updateItemSums() {
    state.items.forEach(function (_, i) { updateSum(i); });
  }

  function updateSum(i) {
    var it = state.items[i];
    var el = dom.items && dom.items.querySelector('[data-sum="' + i + '"]');
    if (!el || !it) return;
    var q = num(it.quantity);
    var bodyHtml;
    if (it.unit_price == null) {
      bodyHtml = state.isBundle ? '<span class="tag tag--unknown">价格待分</span>' : '<span class="muted">单价未知</span>';
    } else {
      bodyHtml = '<span class="num">' + money(it.unit_price * q) + '</span>';
    }
    var share = num(it.shipping_share);
    var sub = it.unit_price == null ? (money(share) + '（含待分）') : money(it.unit_price * q + share);
    el.innerHTML = '本体 ' + bodyHtml + ' · 分摊 <span class="num">' + money(share) + '</span> · 小计 <span class="num">' + sub + '</span>';
  }

  function updateAmounts() {
    var m = computeModel();
    if (!state.isBundle && dom.body) dom.body.textContent = money(m.goodsTotal);
    if (!state.paidManual && dom.paidInput) dom.paidInput.value = centsToYuan(m.paid);
    updateBalance(m);
  }

  function updateBalance(m) {
    if (!dom.balance) return;
    if (state.paidManual) {
      if (m.balanced) {
        dom.balance.classList.remove('is-bad');
        dom.bmark.textContent = '✓';
        dom.btext.textContent = '账目平衡 · 订单余款 ' + money(Math.max(0, m.remain)) + '（卖出/关联谷子后自动核销）';
      } else {
        dom.balance.classList.add('is-bad');
        dom.bmark.textContent = '!';
        dom.btext.textContent = '关联谷子超订单实付 ' + money(m.diff) + '：请调低谷子价格或实付总额';
      }
      return;
    }
    if (m.balanced) {
      dom.balance.classList.remove('is-bad');
      dom.bmark.textContent = '✓';
      var extra = '';
      if (state.isBundle && (m.pendingBody > 0 || m.pendingShip > 0)) {
        extra = '（本体待分 ' + money(m.pendingBody) + '，邮费待分摊 ' + money(m.pendingShip) + '）';
      }
      dom.btext.textContent = '账目平衡' + extra;
    } else {
      dom.balance.classList.add('is-bad');
      dom.bmark.textContent = '!';
      var label = state.isBundle ? '超额' : '差异';
      dom.btext.textContent = '不平衡：' + label + ' ' + money(Math.abs(m.diff)) + '，请调整分摊或金额';
    }
  }

  function updateModeChips() {
    var m = dom.container.querySelector('#o-modes');
    if (m) {
      Array.prototype.forEach.call(m.querySelectorAll('[data-mode]'), function (b) {
        b.classList.toggle('is-on', b.dataset.mode === state.splitMode);
      });
    }
    var bm = dom.container.querySelector('#o-bmodes');
    if (bm) {
      Array.prototype.forEach.call(bm.querySelectorAll('[data-bmode]'), function (b) {
        b.classList.toggle('is-on', b.dataset.bmode === state.bodyMode);
      });
    }
  }

  function updateHint() {
    var el = dom.container.querySelector('#o-split-hint');
    if (el) el.textContent = splitHintText();
  }

  // ---- 输入同步 ----

  function syncOrderFields() {
    if (dom.name) state.order.order_name = dom.name.value;
    if (dom.date) state.order.order_date = dom.date.value;
    if (dom.channel) state.order.channel = dom.channel.value;
    if (dom.note) state.order.note = dom.note.value;
    if (dom.ship) state.order.shipping_fee = centsOr(dom.ship, num(state.order.shipping_fee));
    if (dom.goodsTotal) state.order.goods_total = centsOr(dom.goodsTotal, num(state.order.goods_total));
    if (dom.paidInput) {
      var pc = yuanToCents(dom.paidInput.value);
      if (pc != null && !isNaN(pc)) { state.order.paid_total = pc; state.paidManual = true; }
    }
  }

  function readItemFromRow(i) {
    var it = state.items[i];
    if (!it || !dom.items) return;
    var row = dom.items.querySelector('.oi-row[data-i="' + i + '"]');
    if (!row) return;
    var q = row.querySelector('[data-f="qty"]');
    var u = row.querySelector('[data-f="unit"]');
    var sh = row.querySelector('[data-f="share"]');
    var st = row.querySelector('[data-f="status"]');
    var qty = Number(q && q.value);
    it.quantity = (isFinite(qty) && qty > 0) ? Math.floor(qty) : 0;
    var uc = yuanToCents(u && u.value);
    it.unit_price = (uc == null || isNaN(uc)) ? null : uc;
    it.price_status = (it.unit_price == null) ? 'unknown' : (it.price_status === 'estimated' ? 'estimated' : 'filled');
    var sc = yuanToCents(sh && sh.value);
    it.shipping_share = (sc == null || isNaN(sc)) ? 0 : sc;
    if (st) it.status = st.value;
  }

  function syncInputs() {
    syncOrderFields();
    state.items.forEach(function (_, i) { readItemFromRow(i); });
  }

  // ---- 分摊计算（《业务规则》§2） ----

  function applySplit() {
    syncInputs();
    var S = num(state.order.shipping_fee);
    var items = state.items;
    if (!items.length) { UI.toast('请先添加谷子', 'error'); return; }
    var mode = state.splitMode;

    if (mode === 'none') {
      items.forEach(function (it) { it.shipping_share = 0; });
    } else if (mode === 'per_item') {
      var T = items.reduce(function (a, it) { return a + num(it.quantity); }, 0);
      if (T <= 0) { UI.toast('请先填写各件数量', 'error'); return; }
      var sum = 0;
      items.forEach(function (it, i) {
        if (i === items.length - 1) { it.shipping_share = S - sum; }
        else { var v = Math.floor(S * num(it.quantity) / T); it.shipping_share = v; sum += v; }
      });
    } else if (mode === 'by_amount') {
      var base = 0, bad = false;
      items.forEach(function (it) {
        if (it.unit_price == null) bad = true; else base += it.unit_price * num(it.quantity);
      });
      if (bad) { UI.toast('存在单价未知的件，无法按金额比例分摊；请先补录金额或改用手动指定', 'error'); return; }
      if (base <= 0) { UI.toast('本体合计为 0，无法按金额比例分摊', 'error'); return; }
      var sum2 = 0;
      items.forEach(function (it, i) {
        if (i === items.length - 1) { it.shipping_share = S - sum2; }
        else { var v2 = Math.floor(S * (it.unit_price * num(it.quantity)) / base); it.shipping_share = v2; sum2 += v2; }
      });
    } else if (mode === 'manual') {
      var tot = items.reduce(function (a, it) { return a + num(it.shipping_share); }, 0);
      if (tot > S) { UI.toast('手动分摊合计 ' + money(tot) + ' 超过邮费 ' + money(S) + '，请调整', 'error'); return; }
      if (tot < S) {
        var last = items[items.length - 1];
        last.shipping_share = num(last.shipping_share) + (S - tot);
        UI.toast('尾差已并入最后一件', 'success');
      }
    }
    render();
  }

  /** 本体拆分：把整盒总价按权重分摊为各件本体（行级 floor + 尾差并入最后一件） */
  function distributeBody(total, weightFn) {
    var items = state.items;
    var weights = items.map(function (it) { return weightFn(it); });
    var totalW = weights.reduce(function (a, w) { return a + (isFinite(w) && w > 0 ? w : 0); }, 0);
    if (totalW <= 0) return false;
    var sum = 0;
    items.forEach(function (it, i) {
      if (weights[i] == null || !(weights[i] > 0)) { it.unit_price = null; it.price_status = 'unknown'; return; }
      var line;
      // 最后一个有权重的件吸收尾差
      var isLastWeighted = true;
      for (var j = i + 1; j < items.length; j++) { if (weights[j] != null && weights[j] > 0) { isLastWeighted = false; break; } }
      if (isLastWeighted) line = total - sum; else line = Math.floor(total * weights[i] / totalW);
      var q = num(it.quantity) || 1;
      it.unit_price = Math.round(line / q);
      it.price_status = 'filled';
      sum += it.unit_price * q;
    });
    return true;
  }

  function applyBodySplit() {
    syncInputs();
    var total = num(state.order.goods_total);
    if (total <= 0) { UI.toast('请先填写整盒总价（本体合计）', 'error'); if (dom.goodsTotal) dom.goodsTotal.focus(); return; }
    var mode = state.bodyMode;
    var ok;
    if (mode === 'per_item') {
      ok = distributeBody(total, function (it) { return num(it.quantity) || 1; });
    } else if (mode === 'market') {
      var anyMarket = state.items.some(function (it) { return it._market_price != null && it._market_price > 0; });
      if (!anyMarket) { UI.toast('各件均无市场参考价，无法按市场参考价比例拆分，请改用手动指定', 'error'); return; }
      ok = distributeBody(total, function (it) {
        if (it._market_price == null || it._market_price <= 0) return null;
        return it._market_price * (num(it.quantity) || 1);
      });
    } else { // manual
      var tot = state.items.reduce(function (a, it) { return a + (it.unit_price != null ? it.unit_price * num(it.quantity) : 0); }, 0);
      if (tot > total) { UI.toast('各件本体合计 ' + money(tot) + ' 超过整盒总价 ' + money(total) + '，请调整', 'error'); return; }
      UI.toast('请逐件填写本体单价（可留空显示「价格待分」）', 'success');
      render();
      return;
    }
    if (!ok) { UI.toast('无法拆分：缺少可用的权重', 'error'); return; }
    render();
    UI.toast('已按模式拆分本体', 'success');
  }

  // ---- 添加谷子 ----

  /** 从谷子库跳转进入（add_gid）：把该谷子预填进清单（已存在则不重复添加） */
  function applyPreAdd() {
    var gid = state.preAddGid;
    if (gid == null || !state.goodsById[gid]) return;
    var g = state.goodsById[gid];
    var dup = state.items.some(function (it) { return Number(it.goods_id) === Number(gid); });
    if (dup) {
      UI.toast('该谷子已在订单中，未重复添加', 'info');
      state.preAddGid = null;
      return;
    }
    state.items.push({
      id: null, _new: true, goods_id: Number(g.id), _gname: g.name || '未命名',
      _market_price: (g.market_price != null ? g.market_price : null),
      quantity: 1, unit_price: null, currency: state.order.currency || 'CNY',
      shipping_share: 0, channel: state.order.channel || '', status: 'shipping',
      price_status: 'unknown', note: '', sold_quantity: 0
    });
    state.preAddGid = null;
    state.preAddApplied = true;
    UI.toast('已从谷子库带入：' + (g.name || '未命名') + '，请填写本体单价', 'success');
  }

  function askText(opts) {
    return new Promise(function (resolve) {
      var ref = UI.sheet({
        title: opts.title,
        bodyHTML: '<input class="input" id="ask-input" autocomplete="off" placeholder="' + UI.esc(opts.placeholder || '') + '" value="' + UI.esc(opts.initial || '') + '">' +
          (opts.hint ? '<p class="hint">' + UI.esc(opts.hint) + '</p>' : ''),
        footerHTML: '<button type="button" class="btn btn--secondary" data-act="cancel">取消</button>' +
          '<button type="button" class="btn btn--primary" data-act="ok">确定</button>'
      });
      var input = ref.body.querySelector('#ask-input');
      function done(v) { ref.close(); resolve(v); }
      if (input) {
        setTimeout(function () { input.focus(); }, 0);
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); done(input.value.trim() || null); }
        });
      }
      if (ref.foot) {
        ref.foot.addEventListener('click', function (e) {
          var b = e.target.closest('[data-act]');
          if (!b) return;
          done(b.dataset.act === 'ok' ? (input && input.value.trim() || null) : null);
        });
      }
    });
  }

  function openAddGoodsSheet() {
    var ref = UI.sheet({
      title: '添加谷子',
      bodyHTML: '<div class="opt-list">' +
        '<button type="button" class="opt-row" data-src="pick"><span>选择已有谷子</span><span class="opt-check">›</span></button>' +
        '<button type="button" class="opt-row" data-src="new"><span>新建谷子</span><span class="opt-check">›</span></button>' +
        '</div>'
    });
    ref.body.addEventListener('click', function (e) {
      var b = e.target.closest('[data-src]');
      if (!b) return;
      ref.close();
      if (b.dataset.src === 'pick') openGoodsPicker();
      else openNewGoodsSheet();
    });
  }

  function openGoodsPicker() {
    var ref = UI.sheet({
      title: '选择已有谷子',
      bodyHTML: '<input class="input" id="pick-search" placeholder="搜索名称 / IP" autocomplete="off">' +
        '<div class="opt-list" id="pick-list"></div>'
    });
    var listEl = ref.body.querySelector('#pick-list');
    var searchEl = ref.body.querySelector('#pick-search');
    function paint() {
      var kw = String(searchEl.value || '').trim().toLowerCase();
      var list = state.goodsList.filter(function (g) {
        if (!kw) return true;
        return ((g.name || '') + ' ' + (g.ip || '')).toLowerCase().indexOf(kw) >= 0;
      });
      listEl.innerHTML = list.length
        ? list.map(function (g) {
          return '<button type="button" class="opt-row" data-gid="' + g.id + '"><span>' + UI.esc(g.name || '未命名') + '</span>' +
            '<span class="muted">' + UI.esc(g.ip || '') + ' · ' + UI.esc(g.goods_type || '') + '</span></button>';
        }).join('')
        : '<p class="empty-line">无匹配谷子</p>';
    }
    paint();
    on(searchEl, 'input', paint);
    on(listEl, 'click', function (e) {
      var b = e.target.closest('[data-gid]');
      if (!b) return;
      var g = state.goodsById[Number(b.dataset.gid)];
      ref.close();
      if (g) addToOrder(g);
    });
  }

  /** 添加谷子到订单：若谷子已有「未关联订单的购入记录」→ 优先复用（不重复记账）；否则新建记录 */
  function addToOrder(g) {
    var gid = Number(g.id);
    var reusable = (state.purchasesByGoods[gid] || []).filter(function (p) {
      return p.order_id == null && (num(p.quantity) - num(p.sold_quantity)) > 0;
    });
    if (!reusable.length) { addItemFromGoods(g); return; }
    var rows = reusable.map(function (p) {
      var price = (p.unit_price != null) ? centsToYuan(p.unit_price) + '元' : '未知';
      return '<button type="button" class="opt-row" data-pid="' + p.id + '"><span>' + UI.esc(g.name || '未命名') + '</span>' +
        '<span class="muted">×' + num(p.quantity) + ' · ' + UI.esc(A.STATUS_LABELS[p.status] || p.status) + ' · 单价 ' + price + '</span></button>';
    }).join('');
    var ref = UI.sheet({
      title: '关联已有购入记录',
      bodyHTML: '<p class="hint">该谷子已有未关联订单的购入记录：复用可避免重复记账（记录数不变，订单与谷子款共用一条记录）。</p>' +
        '<div class="opt-list">' + rows +
        '<button type="button" class="opt-row" data-act="new"><span>＋ 新建一条购入记录</span><span class="opt-check">›</span></button>' +
        '</div>'
    });
    ref.body.addEventListener('click', function (e) {
      var b = e.target.closest('[data-pid],[data-act="new"]');
      if (!b) return;
      ref.close();
      if (b.dataset.act === 'new') { addItemFromGoods(g); return; }
      var p = null;
      (state.purchasesByGoods[gid] || []).forEach(function (x) { if (Number(x.id) === Number(b.dataset.pid)) p = x; });
      if (!p) { addItemFromGoods(g); return; }
      addReuseItem(p, g);
    });
  }

  /** 复用已有购入记录加入订单（记录 id 不变，保存时关联到本订单） */
  function addReuseItem(p, g) {
    syncInputs();
    var dup = state.items.some(function (it) { return Number(it.id) === Number(p.id); });
    if (dup) { UI.toast('该购入记录已在订单中', 'info'); return; }
    state.items.push({
      id: Number(p.id), _reuse: true, goods_id: Number(p.goods_id),
      _gname: g.name || '未命名',
      _market_price: (g.market_price != null ? g.market_price : null),
      quantity: num(p.quantity) || 1,
      unit_price: (p.unit_price != null ? p.unit_price : null),
      currency: p.currency || state.order.currency || 'CNY',
      shipping_share: num(p.shipping_share),
      channel: p.channel || state.order.channel || '',
      status: p.status || 'shipping',
      price_status: p.price_status || (p.unit_price != null ? 'filled' : 'unknown'),
      note: p.note || '',
      sold_quantity: num(p.sold_quantity) || 0
    });
    if (state.splitMode !== 'manual') { render(); applySplit(); } else render();
    UI.toast('已复用购入记录：' + (g.name || '未命名') + '（记录数不变）', 'success');
  }

  function openNewGoodsSheet() {
    var ipOpts = (state.enums.ip || []).map(function (v) { return '<option value="' + UI.esc(v) + '">' + UI.esc(v) + '</option>'; }).join('');
    var typeOpts = (state.enums.goods_type || []).map(function (v) { return '<option value="' + UI.esc(v) + '">' + UI.esc(v) + '</option>'; }).join('');
    var ref = UI.sheet({
      title: '新建谷子',
      bodyHTML: '<div class="field"><div class="field-head"><label class="field-label" for="ng-name">名称 <span class="req">*</span></label></div>' +
          '<input id="ng-name" class="input" autocomplete="off" placeholder="如：长崎素世 1st 吧唧"></div>' +
        '<div class="field"><div class="field-head"><label class="field-label" for="ng-ip">IP</label></div>' +
          '<select id="ng-ip" class="input"><option value="">不填</option>' + ipOpts + '</select></div>' +
        '<div class="field"><div class="field-head"><label class="field-label" for="ng-type">类型</label></div>' +
          '<select id="ng-type" class="input"><option value="">不填</option>' + typeOpts + '</select></div>',
      footerHTML: '<button type="button" class="btn btn--secondary" data-act="cancel">取消</button>' +
        '<button type="button" class="btn btn--primary" data-act="ok">确定</button>'
    });
    var nameEl = ref.body.querySelector('#ng-name');
    var ipEl = ref.body.querySelector('#ng-ip');
    var typeEl = ref.body.querySelector('#ng-type');
    setTimeout(function () { if (nameEl) nameEl.focus(); }, 0);
    ref.foot.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'cancel') { ref.close(); return; }
      var name = String(nameEl.value || '').trim();
      if (!name) { UI.toast('请填写谷子名称', 'error'); nameEl.focus(); return; }
      var rec = { name: name, ip: ipEl.value || '其他', goods_type: typeEl.value || '其他', character_ids: [], tags: [], note: '' };
      ref.close();
      S.add('goods', rec).then(function (id) {
        var g = clone(rec); g.id = Number(id);
        state.goodsList.push(g);
        state.goodsById[Number(id)] = g;
        addItemFromGoods(g);
      }).catch(function (err) {
        if (!(err && err.expected)) console.error('[EATG] 新建谷子失败', err);
        UI.toast('新建失败：' + (err && err.message || err), 'error');
      });
    });
  }

  function addItemFromGoods(g) {
    syncInputs();
    state.items.push({
      id: null, _new: true, goods_id: Number(g.id), _gname: g.name || '未命名',
      _market_price: (g.market_price != null ? g.market_price : null),
      quantity: 1, unit_price: null, currency: state.order.currency || 'CNY',
      shipping_share: 0, channel: state.order.channel || '', status: 'shipping',
      price_status: 'unknown', note: '', sold_quantity: 0
    });
    if (state.splitMode !== 'manual') {
      // 自动按当前模式带入初始分摊金额（O-09 带入分摊金额）
      render();
      applySplit();
    } else {
      render();
    }
    UI.toast('已添加：' + (g.name || '未命名'), 'success');
  }

  function removeItem(i) {
    syncInputs();
    var it = state.items[i];
    if (!it) return;
    if (num(it.sold_quantity) > 0) { UI.toast('该件已有卖出记录，请先在谷子款详情处理后再移除', 'error'); return; }
    // 移除 = 解除关联：保存时该购入记录 order_id 置空（保留记录，不重复删除）
    if (it.id != null) state.removed.push(buildItemRec(it));
    state.items.splice(i, 1);
    render();
    if (state.splitMode !== 'manual') applySplit();
  }

  // ---- 截图 ----

  function openEditor(src) {
    if (!src || !U.openImageEditor) return;
    U.openImageEditor(src).then(function (newSrc) {
      if (state.destroyed || !newSrc || newSrc === src) return;
      state.orderImage = newSrc;
      render();
      UI.toast('已保存编辑', 'success');
    });
  }

  function handleFile(file) {
    if (!file) return;
    UI.toast('正在压缩图片…');
    var q = (EATG.runtime && EATG.runtime.imageQuality) || 0.8;
    U.compressImage(file, { maxEdge: 1920, quality: q, stripExif: true }).then(function (dataUrl) {
      if (state.destroyed) return;
      state.orderImage = dataUrl;
      render();
      UI.toast('已添加订单截图', 'success');
      openEditor(dataUrl);
    }).catch(function (err) {
      console.error('[EATG] 订单截图压缩失败', err);
      UI.toast('图片处理失败：' + (err && err.message || err), 'error');
    });
  }

  // ---- 事件 ----

  function bind() {
    on(dom.page, 'click', function (e) {
      var modeBtn = e.target.closest('[data-mode]');
      if (modeBtn) { selectMode(modeBtn.dataset.mode); return; }
      var bmodeBtn = e.target.closest('[data-bmode]');
      if (bmodeBtn) { state.bodyMode = bmodeBtn.dataset.bmode; updateModeChips(); return; }
      var act = e.target.closest('[data-act]');
      if (!act) return;
      var a = act.dataset.act;
      if (a === 'add-item') { openAddGoodsSheet(); return; }
      if (a === 'rm-item') { removeItem(Number(act.dataset.i)); return; }
      if (a === 'goto-goods') { go('#/goods/detail?id=' + act.dataset.gid); return; }
      if (a === 'apply-split') { applySplit(); return; }
      if (a === 'apply-body') { applyBodySplit(); return; }
      // 订单截图：input 覆盖按钮真实触摸；覆盖失效时点击落在此处 → 兜底 JS click（两路互斥）
      if (e.target.closest('.order-img-add')) {
        if (dom.file && e.target !== dom.file) { try { dom.file.click(); } catch (err) { console.error('[EATG] 截图兜底失败', err); } }
        return;
      }
      if (a === 'rm-img') { syncInputs(); state.orderImage = null; render(); UI.toast('已移除截图', 'success'); return; }
      if (a === 'edit-img') { if (state.orderImage) openEditor(state.orderImage); return; }
      if (a === 'add-channel') { onAddChannel(); return; }
      if (a === 'save') { doSave(); return; }
      if (a === 'del-order') { doDelete(); return; }
    });

    on(dom.page, 'input', onItemField);
    on(dom.page, 'change', onItemField);

    var bundle = dom.container.querySelector('#o-bundle');
    on(bundle, 'change', function () {
      syncInputs();
      state.isBundle = bundle.checked;
      render();
    });
    if (dom.ship) on(dom.ship, 'input', function () { state.order.shipping_fee = centsOr(dom.ship, 0); updateAmounts(); });
    if (dom.goodsTotal) on(dom.goodsTotal, 'input', function () { state.order.goods_total = centsOr(dom.goodsTotal, 0); updateAmounts(); });
    if (dom.paidInput) on(dom.paidInput, 'input', function () {
      var pc = yuanToCents(dom.paidInput.value);
      if (pc != null && !isNaN(pc)) { state.order.paid_total = pc; state.paidManual = true; }
      updateAmounts();
    });
    if (dom.channel) on(dom.channel, 'change', function () { state.order.channel = dom.channel.value; });
    if (dom.date) on(dom.date, 'change', function () { state.order.order_date = dom.date.value; });
    if (dom.file) on(dom.file, 'change', function () { handleFile(dom.file.files && dom.file.files[0]); dom.file.value = ''; });
  }

  function onItemField(e) {
    var f = e.target.closest('[data-f]');
    if (!f) return;
    var i = Number(f.dataset.i);
    if (!isFinite(i)) return;
    readItemFromRow(i);
    if (f.dataset.f === 'share') { state.splitMode = 'manual'; updateModeChips(); updateHint(); }
    updateSum(i);
    updateAmounts();
  }

  function selectMode(mode) {
    if (mode === 'by_amount') {
      var bad = state.items.some(function (it) { return it.unit_price == null; });
      if (bad) { UI.toast('订单内存在单价未知的件，按金额比例分摊不可用；请先补录金额或改用手动指定', 'error'); return; }
    }
    state.splitMode = mode;
    updateModeChips();
    updateHint();
    updateAmounts();
  }

  function onAddChannel() {
    askText({ title: '新增渠道', placeholder: '渠道名称' }).then(function (val) {
      if (!val) return;
      var arr = (state.enums.channel || []).slice();
      if (arr.indexOf(val) === -1) arr.push(val);
      state.enums.channel = arr;
      S.put('enums', { key: 'channel', values: arr }).then(function () {
        state.order.channel = val;
        render();
        UI.toast('已新增渠道：' + val, 'success');
      }).catch(function (err) {
        console.error('[EATG] 新增渠道失败', err);
        UI.toast('新增失败：' + (err && err.message || err), 'error');
      });
    });
  }

  // ---- 校验与保存 ----

  function validateInputs() {
    var issues = [];
    state.items.forEach(function (it, i) {
      if (!(num(it.quantity) > 0)) issues.push({ i: i, msg: '第 ' + (i + 1) + ' 件数量需为大于 0 的整数' });
      var row = dom.items && dom.items.querySelector('.oi-row[data-i="' + i + '"]');
      if (row) {
        var u = row.querySelector('[data-f="unit"]');
        var sh = row.querySelector('[data-f="share"]');
        if (u && String(u.value || '').trim() !== '' && isNaN(yuanToCents(u.value))) issues.push({ i: i, msg: '第 ' + (i + 1) + ' 件本体单价格式不正确' });
        if (sh && String(sh.value || '').trim() !== '' && isNaN(yuanToCents(sh.value))) issues.push({ i: i, msg: '第 ' + (i + 1) + ' 件邮费分摊格式不正确' });
      }
    });
    return issues;
  }

  function buildItemRec(it) {
    var rec = (it.id != null) ? clone(it) : {};
    rec.goods_id = it.goods_id;
    rec.order_id = state.orderId;
    rec.quantity = num(it.quantity);
    rec.unit_price = (it.unit_price == null) ? null : it.unit_price;
    rec.currency = it.currency || state.order.currency || 'CNY';
    rec.shipping_share = num(it.shipping_share);
    rec.channel = it.channel || state.order.channel || '';
    rec.status = it.status || 'shipping';
    rec.price_status = (it.unit_price == null) ? 'unknown' : (it.price_status === 'estimated' ? 'estimated' : 'filled');
    rec.note = it.note || '';
    if (rec.sold_quantity == null) rec.sold_quantity = 0;
    delete rec._gname; delete rec._market_price; delete rec._new;
    return rec;
  }

  function collectOrder() {
    var m = computeModel();
    var rec = state.isNew ? {} : clone(state.order);
    rec.order_name = state.order.order_name || '';
    rec.order_date = state.order.order_date || U.todayStr();
    rec.channel = state.order.channel || '';
    rec.goods_total = m.goodsTotal;
    rec.shipping_fee = m.shipFee;
    rec.paid_total = m.paid;
    rec.paid_manual = !!state.paidManual;
    rec.currency = state.order.currency || 'CNY';
    rec.split_mode = state.splitMode;
    rec.is_bundle = !!state.isBundle;
    rec.note = state.order.note || '';
    if (state.orderImage) rec.order_image = state.orderImage; else delete rec.order_image;
    return rec;
  }

  function refreshAggs(ids) {
    ids = ids.filter(function (v, i, a) { return a.indexOf(v) === i && v != null; });
    return Promise.all(ids.map(function (gid) {
      return Promise.all([
        S.get('goods', gid),
        S.query('purchase_items', 'goods_id', gid),
        S.query('sale_items', 'goods_id', gid)
      ]).then(function (r) {
        if (!r[0]) return null;
        var g = r[0];
        g.agg = A.computeGoodsAgg(g, r[1] || [], r[2] || []);
        return { action: 'put', store: 'goods', value: g };
      });
    })).then(function (ops) {
      ops = ops.filter(Boolean);
      if (!ops.length) return;
      return S.bulk('goods', ops);
    });
  }

  function persistOrder() {
    var orderRec = collectOrder();
    var ops = [], affected = {};
    state.items.forEach(function (it) {
      ops.push({ action: it.id != null ? 'put' : 'add', store: 'purchase_items', value: buildItemRec(it) });
      affected[it.goods_id] = 1;
    });
    state.removed.forEach(function (rec) {
      var r = clone(rec); r.order_id = null;
      ops.push({ action: 'put', store: 'purchase_items', value: r });
      affected[r.goods_id] = 1;
    });
    var ids = Object.keys(affected);

    if (state.isNew) {
      return S.add('orders', orderRec).then(function (id) {
        state.orderId = Number(id);
        state.isNew = false;
        ops.forEach(function (op) { if (op.action === 'add') op.value.order_id = state.orderId; });
        return S.bulk(['orders', 'purchase_items'], ops).catch(function (err) {
          return S.del('orders', state.orderId).catch(function () {}).then(function () { throw err; });
        });
      }).then(function () { return refreshAggs(ids); });
    }
    orderRec.id = state.orderId;
    ops.push({ action: 'put', store: 'orders', value: orderRec });
    return S.bulk(['orders', 'purchase_items'], ops).then(function () { return refreshAggs(ids); });
  }

  function setBusy(b) {
    state.busy = b;
    if (dom.saveBtn) {
      dom.saveBtn.disabled = b;
      dom.saveBtn.textContent = b ? '保存中…' : '保存';
    }
  }

  function doSave() {
    if (state.busy) return;
    syncInputs();
    var issues = validateInputs();
    if (issues.length) {
      var row = dom.items && dom.items.querySelector('.oi-row[data-i="' + issues[0].i + '"]');
      if (row) { try { row.scrollIntoView({ block: 'center' }); } catch (e) {} }
      UI.toast(issues[0].msg, 'error');
      return;
    }
    var m = computeModel();
    if (!m.balanced) {
      updateBalance(m);
      if (dom.balance) { try { dom.balance.scrollIntoView({ block: 'center' }); } catch (e) {} }
      UI.toast('账目不平衡，无法保存：请调整分摊或金额', 'error');
      return;
    }
    setBusy(true);
    persistOrder().then(function () {
      UI.toast('已保存', 'success');
      go('#/orders');
    }).catch(function (err) {
      setBusy(false);
      if (!(err && err.expected)) console.error('[EATG] 订单保存失败', err);
      UI.toast('保存失败：' + (err && err.message || err), 'error');
    });
  }

  function doDelete() {
    UI.confirmDialog({
      title: '删除订单',
      message: '将删除该订单；其购入记录保留但解除关联（order_id 置空），并重算相关谷子款聚合。此操作不可撤销。',
      confirmText: '删除',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      S.query('purchase_items', 'order_id', state.orderId).then(function (list) {
        var ops = [], affected = {};
        (list || []).forEach(function (p) {
          var rec = clone(p); rec.order_id = null;
          ops.push({ action: 'put', store: 'purchase_items', value: rec });
          affected[p.goods_id] = 1;
        });
        ops.push({ action: 'del', store: 'orders', key: state.orderId });
        return S.bulk(['orders', 'purchase_items'], ops).then(function () { return refreshAggs(Object.keys(affected)); });
      }).then(function () {
        UI.toast('已删除订单', 'success');
        go('#/orders');
      }).catch(function (err) {
        if (!(err && err.expected)) console.error('[EATG] 删除订单失败', err);
        UI.toast('删除失败：' + (err && err.message || err), 'error');
      });
    });
  }

  function go(hash) {
    if (EATG.app && EATG.app.navigate) EATG.app.navigate(hash);
    else global.location.hash = hash;
  }

  // ---- 挂载 / 卸载 ----

  function mount(container, ctx) {
    resetState();
    dom = { container: container, ctx: ctx };
    ctx.setTitle('订单');
    ctx.setBack(true);
    container.innerHTML = skeletonHTML();

    return load(ctx).then(function () {
      if (state.destroyed) return;
      ctx.setTitle(state.isNew ? '新增订单' : '订单详情');
      applyPreAdd();
      render();
      if (state.preAddApplied) {
        state.preAddApplied = false;
        if (state.splitMode !== 'manual') setTimeout(function () { applySplit(); }, 0);
      }
    }, function (err) {
      if (!(err && err.expected)) console.error('[EATG] 订单编辑页加载失败', err);
      UI.toast('加载失败：' + (err && err.message || err), 'error');
      container.innerHTML = '<div class="empty"><p class="empty-title">加载失败，请返回重试</p>' +
        '<button type="button" class="btn btn--secondary" data-act="back">返回</button></div>';
      var b = container.querySelector('[data-act="back"]');
      if (b) on(b, 'click', function () {
        if (global.history.length > 1) global.history.back();
        else global.location.hash = '#/orders';
      });
    });
  }

  function unmount() {
    state && (state.destroyed = true);
    clearOffs();
    dom = {};
    state = null;
  }

  EATG.pages['order/edit'] = { key: 'order/edit', mount: mount, unmount: unmount };

})(window);
