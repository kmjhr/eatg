/* ==========================================================================
   一咕（EATG）· 卖出订单 新建/编辑/详情 + 单件卖出编辑（js/pages/sale_edit.js）
   实现：《页面线框与UI规范》P08 +《业务规则》§3/§4
   路由：#/sale/edit?mode=new            → 新建卖出订单
        #/sale/edit?id=<sale_order_id>   → 编辑卖出订单
        #/sale/edit?sid=<sale_item_id>   → 编辑单件卖出记录（无订单）
   内容：1 订单表单（名称/日期/渠道/总售价/总手续费/总邮费/币种/分摊模式）
        2 谷子清单：添加（选「现货在手」购入记录）、移除、逐件 单价/数量/手续费/邮费/实收/盈利
        3 收入分摊 4 模式：按件均摊（数量加权）/按售价比例/手动指定/未分摊（各件自有实收）
        4 平衡校验：net_total === Σ各件 net_amount，不平衡红色高亮并阻止保存
        5 单件卖出编辑：直接编辑单条 sale_item（含数量校验、实收/盈利自动计算）
        6 保存联动：事务内扣减 sold_quantity、置 sold_out、更新 goods.agg；删除还原
   口径：金额「分」整数；net = 单价×数量 − 手续费 − 邮费；
        盈利 = 实收 − 按销量分摊的购入成本（filled/estimated/unknown 三档）。
   ========================================================================== */
(function (global) {
  'use strict';

  var EATG = (global.EATG = global.EATG || {});
  var S = EATG.storage;
  var A = EATG.agg;
  var U = EATG.utils;
  var UI = EATG.ui;

  EATG.pages = EATG.pages || {};

  var CURRENCIES = ['CNY', 'JPY', '其他'];
  var SPLIT_MODES = [
    ['per_item', '按件均摊'],
    ['by_amount', '按售价比例'],
    ['manual', '手动指定'],
    ['none', '未分摊']
  ];

  var state = null;
  var dom = {};
  var offs = [];

  function on(el, ev, fn, opt) { if (!el) return; el.addEventListener(ev, fn, opt); offs.push([el, ev, fn, opt]); }
  function clearOffs() { offs.forEach(function (t) { t[0].removeEventListener(t[1], t[2], t[3]); }); offs = []; }
  function clone(o) { var r = {}; for (var k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = o[k]; } return r; }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function money(c) { return U.fmtMoney(c, 'CNY'); }

  function yuanToCents(s) {
    s = String(s == null ? '' : s).trim();
    if (!s) return null;
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
    return Math.round(Number(s) * 100);
  }
  function centsToYuan(cents) {
    if (cents == null || !isFinite(Number(cents))) return '';
    var fixed = (Number(cents) / 100).toFixed(2);
    return fixed.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  }
  function centsOr(el, dflt) {
    var v = yuanToCents(el.value);
    if (v == null) return 0;
    if (isNaN(v)) return dflt;
    return v;
  }

  function resetState() {
    state = {
      destroyed: false,
      busy: false,
      mode: 'order-new',      // order-new / order-edit / item-edit
      orderId: null,
      itemId: null,           // 单件编辑时的 sale_item id
      order: null,            // sale_orders 记录
      item: null,             // 单件编辑时的 sale_item
      items: [],              // 订单内 sale_item 行（内存）
      goodsById: {},
      purchasesById: {},
      goodsList: [],
      enums: { channel: [], sale_channel: [] },
      splitMode: 'per_item',
      fromGoodsId: null,      // 从谷子详情批量卖出进入
      orders: []              // 全部购入订单（用于卖出后补录关联）
    };
  }

  // ---- 模型计算 ----
  function computeModel() {
    var o = state.order || {};
    var items = state.items || [];
    var sumQty = 0, sumPrice = 0, sumFee = 0, sumShip = 0, sumNet = 0;
    items.forEach(function (it) {
      var q = num(it.quantity);
      var up = it.unit_price == null ? 0 : num(it.unit_price);
      sumQty += q;
      sumPrice += up * q;
      sumFee += num(it.fee);
      sumShip += num(it.shipping_cost);
      sumNet += num(it.net_amount);
    });
    var totalPrice = num(o.total_price);
    var totalFee = num(o.total_fee);
    var totalShip = num(o.total_shipping);
    var netTotal = totalPrice - totalFee - totalShip;

    var balanced;
    if (state.splitMode === 'none') {
      // 未分摊：各件 net = 自有实收，校验总和 = net_total
      balanced = (sumNet === netTotal);
    } else {
      balanced = (sumNet === netTotal);
    }

    return {
      sumQty: sumQty, sumPrice: sumPrice, sumFee: sumFee, sumShip: sumShip, sumNet: sumNet,
      totalPrice: totalPrice, totalFee: totalFee, totalShip: totalShip, netTotal: netTotal,
      balanced: balanced, diff: sumNet - netTotal
    };
  }

  // ---- 分摊 net_total 到各件 net_amount（§3）----
  function applySplit() {
    var items = state.items;
    if (!items.length) return;
    var m = computeModel();
    var S = m.netTotal;

    if (state.splitMode === 'none') {
      // 各件用自有实收
      items.forEach(function (it) {
        it.net_amount = (it.unit_price == null ? 0 : num(it.unit_price)) * num(it.quantity) - num(it.fee) - num(it.shipping_cost);
      });
      return;
    }
    if (state.splitMode === 'per_item') {
      var totalQty = m.sumQty || 1;
      var acc = 0;
      items.forEach(function (it, i) {
        if (i === items.length - 1) {
          it.net_amount = S - acc;
        } else {
          var share = Math.floor(S * num(it.quantity) / totalQty);
          it.net_amount = share;
          acc += share;
        }
      });
      return;
    }
    if (state.splitMode === 'by_amount') {
      var base = m.sumPrice || 0;
      if (!base) { UI.toast('存在售价为 0 的件，按售价比例不可用', 'error'); return; }
      var acc2 = 0;
      items.forEach(function (it, i) {
        var line = (it.unit_price == null ? 0 : num(it.unit_price)) * num(it.quantity);
        if (i === items.length - 1) {
          it.net_amount = S - acc2;
        } else {
          var share2 = Math.floor(S * line / base);
          it.net_amount = share2;
          acc2 += share2;
        }
      });
      return;
    }
    if (state.splitMode === 'manual') {
      // 用户已手填 net_amount，校验并把尾差并入最后一件
      var sum = items.reduce(function (a, it) { return a + num(it.net_amount); }, 0);
      if (sum > S) { UI.toast('各件实收之和超过实收总额（差 ' + money(sum - S) + '）', 'error'); return; }
      if (sum < S) {
        items[items.length - 1].net_amount = num(items[items.length - 1].net_amount) + (S - sum);
        UI.toast('尾差 ' + money(S - sum) + ' 已并入最后一件', 'success');
      }
      return;
    }
  }

  // ---- HTML ----
  function selectHTML(id, values, value, labels) {
    var opts = '<option value="" disabled' + (value ? '' : ' selected') + '>请选择</option>';
    values.forEach(function (v) {
      var label = (labels && labels[v]) || v;
      opts += '<option value="' + UI.esc(v) + '"' + (v === value ? ' selected' : '') + '>' + UI.esc(label) + '</option>';
    });
    return '<select id="' + id + '" class="input">' + opts + '</select>';
  }

  function moneyInput(id, val, unit) {
    return '<div class="money-input"><input id="' + id + '" class="input" type="text" inputmode="decimal" autocomplete="off" value="' +
      UI.esc(centsToYuan(val)) + '" placeholder="0.00"><span class="unit">' + UI.esc(unit) + '</span></div>';
  }

  function splitHint() {
    switch (state.splitMode) {
      case 'per_item': return '按各件数量加权均摊实收总额，尾差并入最后一件。';
      case 'by_amount': return '按各件售价小计占比分摊实收总额。';
      case 'manual': return '逐件填写实收，校验总和 = 实收总额，尾差并入最后一件。';
      case 'none': return '各件按自有售价/手续费/邮费计算实收，不做总额分摊。';
      default: return '';
    }
  }

  function modeChips() {
    return '<div class="chip-select">' + SPLIT_MODES.map(function (m) {
      return '<button type="button" class="opt-chip' + (state.splitMode === m[0] ? ' is-on' : '') + '" data-smode="' + m[0] + '">' + m[1] + '</button>';
    }).join('') + '</div>';
  }

  function itemProfit(it) {
    var p = state.purchasesById[it.purchase_item_id];
    if (!p || p.price_status === 'unknown' || p.unit_price == null) return { value: null, kind: 'unknown' };
    var cost = A.proratedPurchaseCost(p, it.quantity);
    var v = num(it.net_amount) - cost;
    return { value: v, kind: p.price_status === 'estimated' ? 'estimated' : 'filled' };
  }

  function itemRowHTML(it, i) {
    var p = state.purchasesById[it.purchase_item_id] || {};
    var g = state.goodsById[p.goods_id] || {};
    var remain = p.quantity != null ? (num(p.quantity) - num(p.sold_quantity)) : 0;
    var pf = itemProfit(it);
    var profitHTML;
    if (pf.value == null) profitHTML = '<span class="tag tag--unknown">成本未知</span>';
    else {
      var cls = pf.value > 0 ? 'up' : (pf.value < 0 ? 'down' : '');
      profitHTML = '<span class="num profit ' + cls + '">' + money(pf.value) + '</span>' +
        (pf.kind === 'estimated' ? '<span class="tag tag--est">估算</span>' : '');
    }
    return '<div class="oi-row" data-i="' + i + '">' +
      '<div class="oi-top">' +
        (g.id ? '<a class="oi-name link-like" href="#/goods/detail?id=' + g.id + '">' + UI.esc(g.name || ('购入#' + it.purchase_item_id)) + '</a>' : '<span class="oi-name">' + UI.esc(g.name || ('购入#' + it.purchase_item_id)) + '</span>') +
        '<span class="muted">剩 ' + remain + ' 件</span>' +
        '<button type="button" class="oi-del" data-act="del-item" data-i="' + i + '">×</button>' +
      '</div>' +
      '<div class="oi-fields">' +
        '<label class="oi-field"><span>数量</span><input class="input input--mini" type="number" min="1" step="1" data-f="qty" data-i="' + i + '" value="' + num(it.quantity) + '"></label>' +
        '<label class="oi-field"><span>售价</span>' + moneyInput('iu-' + i, it.unit_price, '元') + '</label>' +
        '<label class="oi-field"><span>手续费</span>' + moneyInput('if-' + i, it.fee, '元') + '</label>' +
        '<label class="oi-field"><span>邮费</span>' + moneyInput('is-' + i, it.shipping_cost, '元') + '</label>' +
        '<label class="oi-field"><span>实收</span><input class="input input--mini" type="text" inputmode="decimal" data-f="net" data-i="' + i + '" value="' + UI.esc(centsToYuan(it.net_amount)) + '"></label>' +
      '</div>' +
      '<div class="oi-sum" data-sum="' + i + '">盈利 ' + profitHTML + '</div>' +
    '</div>';
  }

  function orderInfoHTML() {
    var o = state.order || {};
    var channels = state.enums.sale_channel.length ? state.enums.sale_channel : state.enums.channel;
    var chanOpts = channels.map(function (c) { return '<option value="' + UI.esc(c) + '"' + (c === o.channel ? ' selected' : '') + '>' + UI.esc(c) + '</option>'; }).join('');
    var curOpts = CURRENCIES.map(function (c) { return '<option value="' + c + '"' + (c === (o.currency || 'CNY') ? ' selected' : '') + '>' + c + '</option>'; }).join('');
    return '<div class="form-section">' +
      '<div class="section-title">订单信息</div>' +
      '<div class="amount-grid">' +
        '<div class="field"><div class="field-head"><label class="field-label" for="o-name">订单名称</label></div><input id="o-name" class="input" value="' + UI.esc(o.sale_order_name || '') + '" placeholder="如：素世吧唧合单出"></div>' +
        '<div class="field"><div class="field-head"><label class="field-label" for="o-date">卖出日期</label></div><input id="o-date" class="input" type="date" value="' + UI.esc(o.sale_date || U.todayStr()) + '"></div>' +
        '<div class="field"><div class="field-head"><label class="field-label" for="o-channel">渠道</label></div><select id="o-channel" class="input"><option value="">不填</option>' + chanOpts + '</select></div>' +
        '<div class="field"><div class="field-head"><label class="field-label" for="o-currency">币种</label></div><select id="o-currency" class="input">' + curOpts + '</select></div>' +
      '</div>' +
      '<div class="amount-grid">' +
        '<div class="field"><div class="field-head"><label class="field-label" for="o-tprice">总售价</label></div>' + moneyInput('o-tprice', o.total_price, '元') + '</div>' +
        '<div class="field"><div class="field-head"><label class="field-label" for="o-tfee">总手续费</label></div>' + moneyInput('o-tfee', o.total_fee, '元') + '</div>' +
        '<div class="field"><div class="field-head"><label class="field-label" for="o-tship">总邮费</label></div>' + moneyInput('o-tship', o.total_shipping, '元') + '</div>' +
      '</div>' +
    '</div>';
  }

  function balanceHTML(m) {
    var bad = !m.balanced;
    var txt = bad ? ('不平衡：差异 ' + money(m.diff) + '，请调整分摊或金额') : '实收平衡（Σ各件实收 = 实收总额）';
    return '<div class="balance-row' + (bad ? ' is-bad' : '') + '" id="o-balance">' +
      '<span id="o-btext">' + txt + '</span>' +
      '<span class="balance-mark">实收总额 ' + money(m.netTotal) + ' · 合计 ' + money(m.sumNet) + '</span>' +
    '</div>';
  }

  function pageHTML() {
    if (state.mode === 'item-edit') return itemEditHTML();
    var m = computeModel();
    var o = state.order || {};
    var itemsHTML = state.items.length
      ? state.items.map(itemRowHTML).join('')
      : '<p class="empty-line">尚无谷子，点击下方「添加谷子」从「现货在手」购入记录中选择</p>';
    return '<div class="page-scroll" id="sale-page">' +
      orderInfoHTML() +
      '<div class="form-section">' +
        '<div class="section-title">谷子清单</div>' +
        '<div class="oi-list" id="oi-list">' + itemsHTML + '</div>' +
        '<button type="button" class="btn btn--secondary add-btn" data-act="add-item">＋ 添加谷子</button>' +
      '</div>' +
      '<div class="form-section">' +
        '<div class="section-title">收入分摊</div>' +
        modeChips() +
        '<p class="hint split-sub">' + splitHint() + '</p>' +
        '<button type="button" class="btn btn--primary apply-split-btn" data-act="apply-split">应用分摊</button>' +
      '</div>' +
      balanceHTML(m) +
      '<div class="detail-actions">' +
        (state.mode === 'order-edit' ? '<button type="button" class="btn btn--danger" data-act="delete">删除订单</button>' : '') +
        '<button type="button" class="btn btn--primary" id="o-save" data-act="save">保存</button>' +
      '</div>' +
    '</div>';
  }

  // ---- 单件卖出编辑（独立 sale_item，无 sale_order）----
  function itemEditHTML() {
    var it = state.item || {};
    var p = state.purchasesById[it.purchase_item_id] || {};
    var g = state.goodsById[p.goods_id] || {};
    var remain = p.quantity != null ? (num(p.quantity) - num(p.sold_quantity)) : 0;
    var net = it.net_amount != null ? it.net_amount : ((it.unit_price || 0) * num(it.quantity) - num(it.fee) - num(it.shipping_cost));
    var pf = itemProfit(it);
    var profitHTML;
    if (pf.value == null) profitHTML = '<span class="tag tag--unknown">成本未知，暂不计盈利</span>';
    else {
      var cls = pf.value > 0 ? 'up' : (pf.value < 0 ? 'down' : '');
      profitHTML = '<span class="num profit ' + cls + '">' + money(pf.value) + '</span>' +
        (pf.kind === 'estimated' ? '<span class="tag tag--est">估算</span>' : '');
    }
    var channels = state.enums.sale_channel.length ? state.enums.sale_channel : state.enums.channel;
    var chanOpts = channels.map(function (c) { return '<option value="' + UI.esc(c) + '"' + (c === it.channel ? ' selected' : '') + '>' + UI.esc(c) + '</option>'; }).join('');
    return '<div class="page-scroll" id="sale-page">' +
      '<div class="form-section">' +
        '<div class="section-title">卖出记录</div>' +
        '<div class="field"><div class="field-head"><span class="field-label">关联谷子</span></div>' +
          (g.id ? '<a class="input is-readonly link-like" href="#/goods/detail?id=' + g.id + '">' + UI.esc(g.name || '—') + '</a>' : '<div class="input is-readonly">' + UI.esc(g.name || '—') + '</div>') +
        '</div>' +
        '<div class="amount-grid">' +
          '<div class="field"><div class="field-head"><label class="field-label" for="s-date">卖出日期</label></div><input id="s-date" class="input" type="date" value="' + UI.esc(it.sale_date || U.todayStr()) + '"></div>' +
          '<div class="field"><div class="field-head"><label class="field-label" for="s-qty">数量</label></div><input id="s-qty" class="input" type="number" min="1" step="1" value="' + num(it.quantity) + '"><p class="hint">剩余可卖 ' + remain + ' 件</p></div>' +
          '<div class="field"><div class="field-head"><label class="field-label" for="s-price">卖出单价</label></div>' + moneyInput('s-price', it.unit_price, '元') + '</div>' +
          '<div class="field"><div class="field-head"><label class="field-label" for="s-fee">手续费</label></div>' + moneyInput('s-fee', it.fee, '元') + '</div>' +
          '<div class="field"><div class="field-head"><label class="field-label" for="s-ship">卖家邮费</label></div>' + moneyInput('s-ship', it.shipping_cost, '元') + '</div>' +
          '<div class="field"><div class="field-head"><label class="field-label" for="s-channel">渠道</label></div><select id="s-channel" class="input"><option value="">不填</option>' + chanOpts + '</select></div>' +
        '</div>' +
        '<div class="field"><div class="field-head"><label class="field-label" for="s-note">备注</label></div><textarea id="s-note" class="textarea">' + UI.esc(it.note || '') + '</textarea></div>' +
        '<div class="balance-row"><span>实收</span><span class="num" id="s-net">' + money(net) + '</span></div>' +
        '<div class="balance-row"><span>盈利</span>' + profitHTML + '</div>' +
      '</div>' +
      '<div class="detail-actions">' +
        '<button type="button" class="btn btn--danger" data-act="delete-item">删除</button>' +
        '<button type="button" class="btn btn--primary" id="o-save" data-act="save-item">保存</button>' +
      '</div>' +
    '</div>';
  }

  // ---- 渲染 / DOM ----
  function render() {
    if (!dom.container) return;
    // 注意：不在此 syncInputs()——各操作 handler 在变更 state 前已显式 syncInputs()。
    // 若在此 sync 会把 DOM 中旧的输入值回写到 state，覆盖 applySplit 等程序化计算结果。
    dom.container.innerHTML = pageHTML();
    cacheDom();
    updateAll();
    bind();
  }

  function cacheDom() {
    dom.page = document.getElementById('sale-page');
    dom.list = document.getElementById('oi-list');
    dom.name = document.getElementById('o-name');
    dom.date = document.getElementById('o-date');
    dom.channel = document.getElementById('o-channel');
    dom.currency = document.getElementById('o-currency');
    dom.tprice = document.getElementById('o-tprice');
    dom.tfee = document.getElementById('o-tfee');
    dom.tship = document.getElementById('o-tship');
    dom.balance = document.getElementById('o-balance');
    dom.btext = document.getElementById('o-btext');
    // 单件编辑
    dom.sDate = document.getElementById('s-date');
    dom.sQty = document.getElementById('s-qty');
    dom.sPrice = document.getElementById('s-price');
    dom.sFee = document.getElementById('s-fee');
    dom.sShip = document.getElementById('s-ship');
    dom.sChannel = document.getElementById('s-channel');
    dom.sNote = document.getElementById('s-note');
    dom.sNet = document.getElementById('s-net');
  }

  function updateAll() {
    if (state.mode === 'item-edit') { updateItemEdit(); return; }
    updateAmounts();
    updateBalance();
  }

  function updateAmounts() {
    // 实时重算实收总额（只读展示，balanceHTML 已含）
  }

  function updateBalance() {
    var m = computeModel();
    if (dom.balance) {
      dom.balance.classList.toggle('is-bad', !m.balanced);
      if (dom.btext) dom.btext.textContent = m.balanced ? '实收平衡（Σ各件实收 = 实收总额）' : ('不平衡：差异 ' + money(m.diff) + '，请调整分摊或金额');
      var mark = dom.balance.querySelector('.balance-mark');
      if (mark) mark.textContent = '实收总额 ' + money(m.netTotal) + ' · 合计 ' + money(m.sumNet);
    }
  }

  function updateItemSums() {
    state.items.forEach(function (it, i) {
      var sumEl = dom.page.querySelector('.oi-sum[data-sum="' + i + '"]');
      if (!sumEl) return;
      var pf = itemProfit(it);
      if (pf.value == null) sumEl.innerHTML = '盈利 <span class="tag tag--unknown">成本未知</span>';
      else {
        var cls = pf.value > 0 ? 'up' : (pf.value < 0 ? 'down' : '');
        sumEl.innerHTML = '盈利 <span class="num profit ' + cls + '">' + money(pf.value) + '</span>' +
          (pf.kind === 'estimated' ? '<span class="tag tag--est">估算</span>' : '');
      }
    });
  }

  function updateItemEdit() {
    var it = state.item;
    if (!it) return;
    var price = centsOr(dom.sPrice, 0);
    var qty = num(dom.sQty.value);
    var fee = centsOr(dom.sFee, 0);
    var ship = centsOr(dom.sShip, 0);
    var net = price * qty - fee - ship;
    if (dom.sNet) dom.sNet.textContent = money(net);
  }

  // ---- 输入同步 ----
  function syncOrderFields() {
    if (!state.order) return;
    var o = state.order;
    if (dom.name) o.sale_order_name = dom.name.value;
    if (dom.date) o.sale_date = dom.date.value;
    if (dom.channel) o.channel = dom.channel.value;
    if (dom.currency) o.currency = dom.currency.value;
    if (dom.tprice) o.total_price = centsOr(dom.tprice, 0);
    if (dom.tfee) o.total_fee = centsOr(dom.tfee, 0);
    if (dom.tship) o.total_shipping = centsOr(dom.tship, 0);
  }

  function readItemFromRow(i) {
    var row = dom.page.querySelector('.oi-row[data-i="' + i + '"]');
    if (!row) return;
    var it = state.items[i];
    if (!it) return;
    var qtyEl = row.querySelector('[data-f="qty"]');
    var priceEl = document.getElementById('iu-' + i);
    var feeEl = document.getElementById('if-' + i);
    var shipEl = document.getElementById('is-' + i);
    var netEl = row.querySelector('[data-f="net"]');
    if (qtyEl) it.quantity = num(qtyEl.value);
    if (priceEl) { var p = yuanToCents(priceEl.value); it.unit_price = (p == null ? null : (isNaN(p) ? it.unit_price : p)); }
    if (feeEl) it.fee = centsOr(feeEl, 0);
    if (shipEl) it.shipping_cost = centsOr(shipEl, 0);
    if (netEl) { var n = yuanToCents(netEl.value); it.net_amount = (n == null ? 0 : (isNaN(n) ? it.net_amount : n)); }
  }

  function syncInputs() {
    syncOrderFields();
    (state.items || []).forEach(function (it, i) { readItemFromRow(i); });
  }

  // ---- 添加谷子 ----
  function openAddItemSheet() {
    // 列出所有「现货在手」且有剩余的购入记录（需扣除已加入本订单的数量）
    var avail = [];
    Object.keys(state.purchasesById).forEach(function (id) {
      var p = state.purchasesById[id];
      var already = (state.items || []).reduce(function (a, it) {
        return a + (Number(it.purchase_item_id) === Number(p.id) ? num(it.quantity) : 0);
      }, 0);
      var remain = num(p.quantity) - num(p.sold_quantity) - already;
      if (p.status === 'on_hand' && remain > 0) avail.push({ p: p, remain: remain });
    });
    if (!avail.length) { UI.toast('暂无「现货在手」且有剩余的购入记录', 'error'); return; }
    var ref = UI.sheet({
      title: '选择购入记录',
      bodyHTML: '<div class="opt-list">' + avail.map(function (entry) {
        var p = entry.p;
        var g = state.goodsById[p.goods_id] || {};
        return '<div class="opt-row" data-pid="' + p.id + '">' +
          '<div class="opt-main"><div class="opt-title">' + UI.esc(g.name || ('购入#' + p.id)) + '</div>' +
          '<div class="opt-sub">' + UI.esc(p.buy_date || '—') + ' · 剩 ' + entry.remain + ' 件 · ' +
          (p.unit_price == null ? '单价未知' : centsToYuan(p.unit_price) + ' 元') + '</div></div>' +
          '<span class="opt-check">＋</span></div>';
      }).join('') + '</div>'
    });
    ref.body.addEventListener('click', function (e) {
      var row = e.target.closest('[data-pid]');
      if (!row) return;
      var pid = Number(row.dataset.pid);
      addItem(pid);
      ref.close();
    });
  }

  function addItem(purchaseId) {
    var p = state.purchasesById[purchaseId];
    if (!p) return;
    var remain = num(p.quantity) - num(p.sold_quantity);
    var it = {
      purchase_item_id: purchaseId,
      goods_id: p.goods_id,
      sale_order_id: state.orderId,
      sale_date: (state.order && state.order.sale_date) || U.todayStr(),
      quantity: 1,
      unit_price: null,
      currency: (state.order && state.order.currency) || p.currency || 'CNY',
      fee: 0,
      shipping_cost: 0,
      net_amount: 0,
      channel: (state.order && state.order.channel) || '',
      note: ''
    };
    state.items.push(it);
    render();
  }

  function removeItem(i) {
    state.items.splice(i, 1);
    render();
  }

  // ---- 选择分摊模式 ----
  function selectMode(mode) {
    syncInputs();
    state.splitMode = mode;
    if (mode === 'by_amount') {
      var hasZero = state.items.some(function (it) { return it.unit_price == null || num(it.unit_price) === 0; });
      if (hasZero) { UI.toast('存在售价为 0 的件，按售价比例不可用', 'error'); state.splitMode = state.splitMode; return; }
    }
    render();
  }

  // ---- 校验 ----
  function validateOrder() {
    var o = state.order;
    if (!o.sale_order_name || !String(o.sale_order_name).trim()) { UI.toast('请填写订单名称', 'error'); return false; }
    if (!state.items.length) { UI.toast('请至少添加一件谷子', 'error'); return false; }
    // 按购入记录聚合：新总卖出数必须 ≤ 剩余 + 本订单原占数
    var newByPid = {};
    state.items.forEach(function (it) {
      var pid = Number(it.purchase_item_id);
      newByPid[pid] = (newByPid[pid] || 0) + num(it.quantity);
    });
    for (var i = 0; i < state.items.length; i++) {
      var it = state.items[i];
      var p = state.purchasesById[it.purchase_item_id];
      if (!p) { UI.toast('第 ' + (i + 1) + ' 件关联的购入记录不存在', 'error'); return false; }
      var pid = Number(p.id);
      var orig = state.origQtyByPid[pid] || 0;
      var remain = num(p.quantity) - num(p.sold_quantity) + orig;
      if (newByPid[pid] > remain) { UI.toast('第 ' + (i + 1) + ' 件卖出数量超过剩余（' + remain + ' 件）', 'error'); return false; }
      if (it.unit_price == null) { UI.toast('第 ' + (i + 1) + ' 件请填写卖出单价', 'error'); return false; }
    }
    var m = computeModel();
    if (!m.balanced) { UI.toast('实收不平衡（差异 ' + money(m.diff) + '），无法保存', 'error'); return false; }
    return true;
  }

  // ---- 保存卖出订单 ----
  function buildOrderRec() {
    var o = state.order;
    return {
      id: state.orderId || undefined,
      sale_order_name: o.sale_order_name,
      sale_date: o.sale_date,
      channel: o.channel,
      total_price: num(o.total_price),
      total_fee: num(o.total_fee),
      total_shipping: num(o.total_shipping),
      net_total: num(o.total_price) - num(o.total_fee) - num(o.total_shipping),
      currency: o.currency || 'CNY',
      split_mode: state.splitMode,
      note: ''
    };
  }

  function buildItemRec(it) {
    return {
      id: it.id || undefined,
      goods_id: it.goods_id,
      purchase_item_id: it.purchase_item_id,
      sale_order_id: state.orderId,
      sale_date: it.sale_date,
      quantity: num(it.quantity),
      unit_price: it.unit_price,
      currency: it.currency || 'CNY',
      fee: num(it.fee),
      shipping_cost: num(it.shipping_cost),
      net_amount: num(it.net_amount),
      channel: it.channel,
      note: it.note || ''
    };
  }

  function refreshAggs(goodsIds) {
    var ids = Array.isArray(goodsIds) ? goodsIds : [goodsIds];
    return Promise.all(ids.map(function (gid) {
      return Promise.all([
        S.get('goods', gid),
        S.query('purchase_items', 'goods_id', gid),
        S.query('sale_items', 'goods_id', gid)
      ]).then(function (r) {
        var g = r[0]; if (!g) return null;
        g.agg = A.computeGoodsAgg(g, r[1] || [], r[2] || []);
        return S.put('goods', g);
      });
    }));
  }

  function persistOrder() {
    var orderRec = buildOrderRec();
    var ops = [];
    var newOrder = state.mode === 'order-new';
    var itemIds = state.items.map(function (it) { return it.id; }).filter(Boolean);
    // 删除编辑过程中移除的卖出明细
    (state.origItemIds || []).forEach(function (oid) {
      if (itemIds.indexOf(oid) === -1) ops.push({ action: 'del', store: 'sale_items', key: oid });
    });

    return (newOrder ? S.add('sale_orders', orderRec) : S.put('sale_orders', orderRec)).then(function (oid) {
      state.orderId = Number(oid);
      orderRec.id = state.orderId;
      // 写入/更新各件
      state.items.forEach(function (it) {
        var rec = buildItemRec(it);
        rec.sale_order_id = state.orderId;
        rec.sale_date = orderRec.sale_date;
        rec.channel = orderRec.channel;
        rec.currency = orderRec.currency;
        if (it.id) ops.push({ action: 'put', store: 'sale_items', value: rec });
        else ops.push({ action: 'add', store: 'sale_items', value: rec });
      });
      // 扣减购入记录（编辑时先还原本订单原占数，再加新数）
      var purchaseOps = {};
      var newByPid = {};
      state.items.forEach(function (it) {
        var pid = Number(it.purchase_item_id);
        newByPid[pid] = (newByPid[pid] || 0) + num(it.quantity);
      });
      Object.keys(newByPid).forEach(function (pid) {
        var p = state.purchasesById[pid];
        if (!p) return;
        var pr = clone(p);
        var orig = state.origQtyByPid[pid] || 0;
        pr.sold_quantity = num(pr.sold_quantity) - orig + newByPid[pid];
        if (pr.sold_quantity >= num(pr.quantity)) pr.status = 'sold_out';
        else if (pr.sold_quantity > 0) pr.status = 'on_hand';
        else pr.status = 'on_hand';
        purchaseOps[pid] = pr;
      });
      Object.keys(purchaseOps).forEach(function (pid) {
        ops.push({ action: 'put', store: 'purchase_items', value: purchaseOps[pid] });
      });
      return S.bulk(['sale_items', 'purchase_items'], ops);
    }).then(function () {
      var gids = {};
      state.items.forEach(function (it) { gids[it.goods_id] = true; });
      return refreshAggs(Object.keys(gids).map(Number));
    }).then(function () {
      UI.toast('卖出订单已保存', 'success');
      var pids = state.items.map(function (it) { return it.purchase_item_id; });
      offerLinkPurchases(pids, goBack);
    });
  }

  function doSave() {
    syncInputs();
    if (state.mode === 'item-edit') { doSaveItem(); return; }
    if (!validateOrder()) return;
    setBusy(true);
    persistOrder().catch(function (err) {
      setBusy(false);
      if (!(err && err.expected)) console.error('[EATG] 保存卖出订单失败', err);
      UI.toast('保存失败：' + (err && err.message || err), 'error');
    });
  }

  // ---- 单件卖出保存 ----
  function doSaveItem() {
    var it = state.item;
    var price = centsOr(dom.sPrice, 0);
    var qty = num(dom.sQty.value);
    var fee = centsOr(dom.sFee, 0);
    var ship = centsOr(dom.sShip, 0);
    if (!qty || qty <= 0) { UI.toast('数量必须大于 0', 'error'); return; }
    if (price == null || isNaN(yuanToCents(dom.sPrice.value))) { UI.toast('请填写合法的卖出单价', 'error'); return; }
    var p = state.purchasesById[it.purchase_item_id];
    var oldQty = num(it.quantity);
    var remain = num(p.quantity) - num(p.sold_quantity) + oldQty; // 加回旧值
    if (qty > remain) { UI.toast('卖出数量超过剩余可卖（' + remain + ' 件）', 'error'); return; }
    var net = price * qty - fee - ship;
    var rec = clone(it);
    rec.sale_date = dom.sDate.value || U.todayStr();
    rec.quantity = qty;
    rec.unit_price = price;
    rec.fee = fee;
    rec.shipping_cost = ship;
    rec.net_amount = net;
    rec.channel = dom.sChannel.value || '';
    rec.note = (dom.sNote.value || '').trim();
    rec.currency = 'CNY';

    var pRec = clone(p);
    pRec.sold_quantity = num(p.sold_quantity) - oldQty + qty;
    if (pRec.sold_quantity >= num(pRec.quantity)) pRec.status = 'sold_out';
    else if (pRec.status === 'sold_out') pRec.status = 'on_hand';

    setBusy(true);
    S.bulk(['sale_items', 'purchase_items'], [
      { action: 'put', store: 'sale_items', value: rec },
      { action: 'put', store: 'purchase_items', value: pRec }
    ]).then(function () {
      return refreshAggs(it.goods_id);
    }).then(function () {
      UI.toast('已保存卖出记录', 'success');
      offerLinkPurchases([it.purchase_item_id], goBack);
    }).catch(function (err) {
      setBusy(false);
      if (!(err && err.expected)) console.error('[EATG] 保存卖出记录失败', err);
      UI.toast('保存失败：' + (err && err.message || err), 'error');
    });
  }

  // ---- 删除 ----
  function doDeleteOrder() {
    UI.confirmDialog({
      title: '删除卖出订单',
      message: '将删除该订单及其全部卖出记录，并还原对应购入记录的剩余数量与状态。确认？',
      confirmText: '删除', danger: true
    }).then(function (ok) {
      if (!ok) return;
      var itemIds = state.items.map(function (it) { return it.id; }).filter(Boolean);
      var purchaseOps = {};
      state.items.forEach(function (it) {
        var p = state.purchasesById[it.purchase_item_id];
        if (!p) return;
        if (!purchaseOps[p.id]) purchaseOps[p.id] = clone(p);
        var pr = purchaseOps[p.id];
        pr.sold_quantity = Math.max(0, num(pr.sold_quantity) - num(it.quantity));
        if (pr.sold_quantity < num(pr.quantity) && pr.status === 'sold_out') pr.status = 'on_hand';
      });
      var ops = [{ action: 'del', store: 'sale_orders', key: state.orderId }];
      itemIds.forEach(function (id) { ops.push({ action: 'del', store: 'sale_items', key: id }); });
      Object.keys(purchaseOps).forEach(function (pid) { ops.push({ action: 'put', store: 'purchase_items', value: purchaseOps[pid] }); });
      setBusy(true);
      S.bulk(['sale_orders', 'sale_items', 'purchase_items'], ops).then(function () {
        var gids = {};
        state.items.forEach(function (it) { gids[it.goods_id] = true; });
        return refreshAggs(Object.keys(gids).map(Number));
      }).then(function () {
        UI.toast('已删除卖出订单', 'success');
        goBack();
      }).catch(function (err) {
        setBusy(false);
        if (!(err && err.expected)) console.error('[EATG] 删除卖出订单失败', err);
        UI.toast('删除失败：' + (err && err.message || err), 'error');
      });
    });
  }

  function doDeleteItem() {
    var it = state.item;
    UI.confirmDialog({
      title: '删除卖出记录',
      message: '将还原对应购入记录的剩余数量与状态。确认？',
      confirmText: '删除', danger: true
    }).then(function (ok) {
      if (!ok) return;
      var p = state.purchasesById[it.purchase_item_id];
      var ops = [{ action: 'del', store: 'sale_items', key: it.id }];
      if (p) {
        var pRec = clone(p);
        pRec.sold_quantity = Math.max(0, num(p.sold_quantity) - num(it.quantity));
        if (pRec.sold_quantity < num(pRec.quantity) && pRec.status === 'sold_out') pRec.status = 'on_hand';
        ops.push({ action: 'put', store: 'purchase_items', value: pRec });
      }
      setBusy(true);
      S.bulk(['sale_items', 'purchase_items'], ops).then(function () {
        return refreshAggs(it.goods_id);
      }).then(function () {
        UI.toast('已删除卖出记录', 'success');
        goBack();
      }).catch(function (err) {
        setBusy(false);
        if (!(err && err.expected)) console.error('[EATG] 删除卖出记录失败', err);
        UI.toast('删除失败：' + (err && err.message || err), 'error');
      });
    });
  }

  function setBusy(b) { state.busy = b; var btn = document.getElementById('o-save'); if (btn) btn.disabled = b; }

  /** 卖出保存后：对未关联订单的购入记录提供「补录购入订单」入口（订单余款随之核销） */
  function offerLinkPurchases(pids, done) {
    pids = pids.filter(function (v, i, a) { return a.indexOf(v) === i && v != null; })
      .filter(function (pid) { var p = state.purchasesById[pid]; return p && p.order_id == null; });
    if (!pids.length || !state.orders.length) { done(); return; }
    var rows = state.orders.map(function (o) {
      return '<button type="button" class="opt-row" data-oid="' + o.id + '"><span>' + UI.esc(o.order_name || '未命名订单') + '</span>' +
        '<span class="muted">' + UI.esc(o.order_date || '—') + ' · ' + UI.esc(o.channel || '') + '</span></button>';
    }).join('');
    var ref = UI.sheet({
      title: '补录购入订单',
      bodyHTML: '<p class="hint">本次卖出的 ' + pids.length + ' 条购入记录还没关联订单。关联后该订单的「余款」会自动核销减少。</p>' +
        '<div class="opt-list">' + rows +
        '<button type="button" class="opt-row" data-act="skip"><span>暂不关联</span><span class="opt-check">›</span></button>' +
        '</div>'
    });
    function finish() { ref.close(); done(); }
    ref.body.addEventListener('click', function (e) {
      var b = e.target.closest('[data-oid],[data-act="skip"]');
      if (!b) return;
      if (b.dataset.act === 'skip') { finish(); return; }
      var oid = Number(b.dataset.oid);
      var ops = pids.map(function (pid) {
        var p = state.purchasesById[pid];
        var rec = clone(p); rec.order_id = oid;
        return { action: 'put', store: 'purchase_items', value: rec };
      });
      S.bulk('purchase_items', ops).then(function () {
        UI.toast('已关联订单，余款自动核销', 'success');
        finish();
      }).catch(function (err) {
        if (!(err && err.expected)) console.error('[EATG] 补录订单失败', err);
        UI.toast('补录失败：' + (err && err.message || err), 'error');
        finish();
      });
    });
  }

  function goBack() {
    if (EATG.app && EATG.app.navigate) EATG.app.navigate('#/sales');
  }

  function go(hash) {
    if (EATG.app && EATG.app.navigate) EATG.app.navigate(hash);
  }

  // ---- 事件绑定 ----
  function bind() {
    if (!dom.page) return;
    on(dom.page, 'click', function (e) {
      // 分摊模式按钮（data-smode，无 data-act）需优先判断，否则会被下方 !act 提前 return
      var sm = e.target.closest('[data-smode]');
      if (sm) { selectMode(sm.dataset.smode); return; }
      var act = e.target.closest('[data-act]');
      if (!act) return;
      var a = act.dataset.act;
      if (a === 'add-item') { syncInputs(); openAddItemSheet(); return; }
      if (a === 'del-item') { syncInputs(); removeItem(Number(act.dataset.i)); return; }
      if (a === 'apply-split') { syncInputs(); applySplit(); render(); return; }
      if (a === 'save') { doSave(); return; }
      if (a === 'save-item') { doSave(); return; }
      if (a === 'delete') { doDeleteOrder(); return; }
      if (a === 'delete-item') { doDeleteItem(); return; }
    });
    // 订单字段变化 → 实时重算平衡
    [dom.name, dom.date, dom.channel, dom.currency, dom.tprice, dom.tfee, dom.tship].forEach(function (el) {
      if (el) on(el, 'input', function () { syncOrderFields(); updateBalance(); });
      if (el) on(el, 'change', function () { syncOrderFields(); updateBalance(); });
    });
    // 单件编辑实时计算
    [dom.sPrice, dom.sQty, dom.sFee, dom.sShip].forEach(function (el) {
      if (el) on(el, 'input', updateItemEdit);
    });
    // 行内字段变化
    (state.items || []).forEach(function (it, i) {
      var row = dom.page.querySelector('.oi-row[data-i="' + i + '"]');
      if (!row) return;
      var fields = row.querySelectorAll('[data-f]');
      fields.forEach(function (f) {
        on(f, 'input', function () { readItemFromRow(i); updateItemSums(); updateBalance(); });
      });
      var priceEl = document.getElementById('iu-' + i);
      var feeEl = document.getElementById('if-' + i);
      var shipEl = document.getElementById('is-' + i);
      [priceEl, feeEl, shipEl].forEach(function (el) { if (el) on(el, 'input', function () { readItemFromRow(i); updateItemSums(); updateBalance(); }); });
    });
  }

  // ---- 加载 ----
  function load(ctx) {
    var params = new URLSearchParams(ctx.query || '');
    var sid = params.get('sid');
    var id = params.get('id');
    var mode = params.get('mode');

    return Promise.all([
      S.getAll('goods'),
      S.getAll('purchase_items'),
      S.get('enums', 'channel'),
      S.get('enums', 'sale_channel'),
      S.getAll('orders')
    ]).then(function (r) {
      state.goodsById = {};
      (r[0] || []).forEach(function (g) { state.goodsById[g.id] = g; });
      state.purchasesById = {};
      (r[1] || []).forEach(function (p) { state.purchasesById[p.id] = p; });
      state.enums.channel = (r[2] && r[2].values) || [];
      state.enums.sale_channel = (r[3] && r[3].values) || [];
      state.orders = (r[4] || []).slice().sort(function (a, b) {
        return String(b.order_date || '').localeCompare(String(a.order_date || '')) || (Number(b.id) - Number(a.id));
      });
      state.fromGoodsId = params.get('goods_id') ? Number(params.get('goods_id')) : null;

      if (sid) {
        // 单件卖出编辑
        state.mode = 'item-edit';
        state.itemId = Number(sid);
        return S.get('sale_items', state.itemId).then(function (it) {
          if (!it) throw new Error('卖出记录不存在');
          state.item = clone(it);
        });
      }
      if (id) {
        // 编辑卖出订单
        state.mode = 'order-edit';
        state.orderId = Number(id);
        return Promise.all([S.get('sale_orders', state.orderId), S.query('sale_items', 'sale_order_id', state.orderId)])
          .then(function (r2) {
            if (!r2[0]) throw new Error('卖出订单不存在');
            state.order = clone(r2[0]);
            state.splitMode = state.order.split_mode || 'per_item';
            state.items = (r2[1] || []).map(clone);
            // 记录本订单原始各购入件数（用于编辑时的余量校验与 sold_quantity 重算）
            state.origQtyByPid = {};
            state.origItemIds = state.items.map(function (it) { return it.id; }).filter(Boolean);
            state.items.forEach(function (it) {
              var pid = Number(it.purchase_item_id);
              state.origQtyByPid[pid] = (state.origQtyByPid[pid] || 0) + num(it.quantity);
            });
          });
      }
      // 新建卖出订单
      state.mode = 'order-new';
      state.origQtyByPid = {};
      state.origItemIds = [];
      state.order = {
        sale_order_name: '',
        sale_date: U.todayStr(),
        channel: '',
        total_price: 0,
        total_fee: 0,
        total_shipping: 0,
        net_total: 0,
        currency: 'CNY',
        split_mode: 'per_item'
      };
      state.items = [];
      // 若从谷子详情批量卖出进入，预填该谷子的现货购入记录
      if (state.fromGoodsId) {
        Object.keys(state.purchasesById).forEach(function (pid) {
          var p = state.purchasesById[pid];
          if (Number(p.goods_id) === state.fromGoodsId && p.status === 'on_hand' && (num(p.quantity) - num(p.sold_quantity)) > 0) {
            state.items.push({
              purchase_item_id: p.id,
              goods_id: p.goods_id,
              sale_order_id: null,
              sale_date: U.todayStr(),
              quantity: 1,
              unit_price: null,
              currency: p.currency || 'CNY',
              fee: 0,
              shipping_cost: 0,
              net_amount: 0,
              channel: '',
              note: ''
            });
          }
        });
      }
    });
  }

  function mount(container, ctx) {
    resetState();
    dom = { container: container };
    container.innerHTML = '<div class="loading">加载中…</div>';
    ctx.setTitle('卖出订单');
    ctx.setBack(true);
    ctx.setActiveTab('mine');
    return load(ctx).then(function () {
      if (state.destroyed) return;
      render();
    }).catch(function (err) {
      if (state.destroyed) return;
      if (!(err && err.expected)) console.error('[EATG] 卖出订单加载失败', err);
      UI.toast('加载失败：' + (err && err.message || err), 'error');
      container.innerHTML = '<p class="empty-line">加载失败</p>';
    });
  }

  function unmount() {
    if (state) state.destroyed = true;
    clearOffs();
  }

  EATG.pages['sale/edit'] = { key: 'sale/edit', mount: mount, unmount: unmount };

})(window);
