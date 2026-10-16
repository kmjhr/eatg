/* ==========================================================================
   一咕（EATG）· 聚合服务（js/agg.js）
   实现：《数据字典与存储规范》§5「goods.agg 冗余缓存」+《业务规则与计算逻辑》§4/§5
        —— 从 purchase_items / sale_items 计算 goods.agg，并在缺失时写回缓存；
        —— 产出收藏库首页统计摘要口径（总件数/总投入/总盈利/在手/在途/未计价）。
   口径要点：
        · 金额一律换算为人民币「分」整数后统计（JPY 等按 utils.toCnyCents 汇率换算）。
        · 总投入（已填写/filled）与总投入（估算/estimated）分开；unknown 不计金额。
        · 盈利仅 filled 计入「已实现盈利」；estimated 单列「估算盈利」；unknown 不计。
        · goods.agg 字段：total_qty / total_cost / total_sold / total_profit /
          estimated_profit / filled_only_cost （另有辅助：remaining / status / 未计价件数）。
   ========================================================================== */
(function (global) {
  'use strict';

  var EATG = (global.EATG = global.EATG || {});
  var A = (EATG.agg = EATG.agg || {});

  // 状态机顺序（《业务规则》/《数据字典》§2.2）
  var STATUS_RANK = { deposit_pre: 0, full_pre: 1, shipping: 2, on_hand: 3, sold_out: 4 };
  var STATUS_ORDER = ['deposit_pre', 'full_pre', 'shipping', 'on_hand', 'sold_out'];
  var STATUS_LABELS = {
    deposit_pre: '定尾预售', full_pre: '全款预售', shipping: '在途',
    on_hand: '现货在手', sold_out: '已出荷'
  };
  var PRICE_ORDER = ['filled', 'estimated', 'unknown'];
  var PRICE_LABELS = { filled: '已填写', estimated: '估算', unknown: '未知' };

  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }

  /** 原币分 → 人民币分（缺汇率/非法值按 0 处理） */
  function cny(cents, currency) {
    var r = EATG.utils && EATG.utils.toCnyCents ? EATG.utils.toCnyCents(cents, currency) : Number(cents);
    return (r == null || !isFinite(r)) ? 0 : r;
  }

  /** 单条购入记录的「成本（人民币分）」：filled/estimated 计价；unknown 计 0 */
  function purchaseCost(p) {
    if (!p || p.price_status === 'unknown' || p.unit_price == null) return 0;
    var cur = p.currency || 'CNY';
    return cny(num(p.unit_price) * num(p.quantity), cur) + cny(num(p.shipping_share), cur);
  }

  /**
   * 按卖出数量分摊的购入成本（人民币分）。
   * 部分卖出时：cost = 整条购入成本 × (卖出数量 / 购入数量)，四舍五入到分。
   * 用于单件盈利 = 实收 − 分摊成本（《业务规则》§4）。
   */
  function proratedPurchaseCost(p, saleQty) {
    if (!p || p.price_status === 'unknown' || p.unit_price == null) return 0;
    var full = purchaseCost(p);
    var pq = num(p.quantity) || 1;
    var sq = num(saleQty);
    if (sq >= pq) return full; // 卖完或超卖（超卖由上层校验拦截），按整条成本计
    return Math.round(full * sq / pq);
  }

  /** 单条卖出记录的「实收（人民币分）」：= 单价×数量 − 手续费 − 邮费（业务规则 §4） */
  function saleNet(s) {
    if (!s) return 0;
    var cur = s.currency || 'CNY';
    return cny(num(s.unit_price) * num(s.quantity), cur) - cny(num(s.fee), cur) - cny(num(s.shipping_cost), cur);
  }

  /**
   * 计算单个谷子款的 agg。
   * @param {object} goods 谷子款（仅用于占位，不使用）
   * @param {Array} purchases 该款的购入记录
   * @param {Array} sales 该款的卖出记录
   * @returns {object} agg
   */
  function computeGoodsAgg(goods, purchases, sales) {
    purchases = purchases || [];
    sales = sales || [];

    var pMap = {};
    var totalQty = 0, totalSold = 0;
    var filledCost = 0, totalCost = 0, estCost = 0;
    var unknownQty = 0, estimatedQty = 0;
    var statusesRemaining = [];

    purchases.forEach(function (p) {
      pMap[p.id] = p;
      var q = num(p.quantity);
      totalQty += q;
      var lineCost = purchaseCost(p);
      if (p.price_status === 'filled') { filledCost += lineCost; totalCost += lineCost; }
      else if (p.price_status === 'estimated') { estCost += lineCost; totalCost += lineCost; estimatedQty += q; }
      else { unknownQty += q; } // unknown：不计金额
      if (q - num(p.sold_quantity) > 0) statusesRemaining.push(p.status);
    });

    var totalProfit = 0, estimatedProfit = 0;
    sales.forEach(function (s) {
      totalSold += num(s.quantity);
      var p = pMap[s.purchase_item_id];
      if (!p) return;
      var profit;
      // 未知价格池已结算件：成本=落盘的 cost_base，按已实现盈利计入
      if (s.cost_settled && s.cost_base != null) {
        profit = saleNet(s) - num(s.cost_base);
        totalProfit += profit;
      } else if (p.price_status === 'filled') {
        profit = saleNet(s) - proratedPurchaseCost(p, s.quantity);
        totalProfit += profit;
      } else if (p.price_status === 'estimated') {
        profit = saleNet(s) - proratedPurchaseCost(p, s.quantity);
        estimatedProfit += profit;
      }
      // unknown 且未结算：成本未知，盈利不计算
    });

    // 代表状态：剩余件中「最靠前（最待办）」的状态；否则若已全部出荷为 sold_out
    var status = null;
    if (statusesRemaining.length) {
      status = statusesRemaining.reduce(function (a, b) {
        return (STATUS_RANK[b] < STATUS_RANK[a]) ? b : a;
      });
    } else if (purchases.length) {
      status = 'sold_out';
    }

    return {
      total_qty: totalQty,
      total_sold: totalSold,
      remaining: totalQty - totalSold,
      total_cost: totalCost,          // 可计价总成本（含估算）
      filled_only_cost: filledCost,   // 已填写总投入
      estimated_cost: estCost,        // 估算总投入（单列）
      total_profit: totalProfit,      // 已实现盈利（filled）
      estimated_profit: estimatedProfit, // 估算盈利（单列）
      unknown_qty: unknownQty,        // 未知计价件数
      estimated_qty: estimatedQty,    // 估算计价件数
      status: status                  // 聚合代表状态（UI 展示用）
    };
  }

  /**
   * 全局统计摘要（《业务规则》§5 口径）。
   * @returns {object} { net_qty, filled_cost, estimated_cost, total_profit, estimated_profit,
   *                     on_hand, in_transit, unpriced, unknown_qty, estimated_qty }
   */
  function summarize(purchases, sales, orders) {
    purchases = purchases || [];
    sales = sales || [];
    orders = orders || [];

    var pMap = {};
    var s = {
      total_qty: 0, total_sold: 0, net_qty: 0,
      filled_cost: 0, estimated_cost: 0,
      total_profit: 0, estimated_profit: 0,
      on_hand: 0, in_transit: 0,
      unpriced: 0, unknown_qty: 0, estimated_qty: 0,
      order_unalloc: 0,   // 订单未核销支出（实付 − 已关联谷子核销），已计入 filled_cost
      total_net: 0        // 卖出实收总额：Σ saleNet（售价×数量 − 手续费 − 卖家邮费）
    };

    // 订单已核销额（关联记录的已知本体 + 分摊）
    var allocByOrder = {};
    purchases.forEach(function (p) {
      pMap[p.id] = p;
      if (p.order_id != null) {
        var k = Number(p.order_id);
        var v = (p.unit_price != null ? num(p.unit_price) * num(p.quantity) : 0) + num(p.shipping_share);
        allocByOrder[k] = (allocByOrder[k] || 0) + v;
      }
      var q = num(p.quantity);
      s.total_qty += q;
      var remaining = q - num(p.sold_quantity);
      if (remaining > 0) {
        if (p.status === 'on_hand') s.on_hand += remaining;
        else if (p.status === 'shipping') s.in_transit += remaining;
      }
      var lineCost = purchaseCost(p);
      if (p.price_status === 'filled') s.filled_cost += lineCost;
      else if (p.price_status === 'estimated') { s.estimated_cost += lineCost; s.estimated_qty += q; s.unpriced += q; }
      else { s.unknown_qty += q; s.unpriced += q; }
    });

    // 订单未核销支出：实付 − 已关联谷子核销（含未知池/未关联谷子的空余款）
    // 按订单实付价格状态分桶：已知→已填写投入；估计→估算投入；未知→不计
    orders.forEach(function (o) {
      var paid = num(o.paid_total);
      if (!(paid > 0)) return;
      var ps = o.price_status || 'filled';
      if (ps === 'unknown') return;
      var unalloc = paid - (allocByOrder[Number(o.id)] || 0);
      if (unalloc > 0) {
        s.order_unalloc += unalloc;
        if (ps === 'estimated') s.estimated_cost += unalloc;
        else s.filled_cost += unalloc;
      }
    });

    sales.forEach(function (sl) {
      s.total_sold += num(sl.quantity);
      s.total_net += saleNet(sl);
      var p = pMap[sl.purchase_item_id];
      if (!p) return;
      if (sl.cost_settled && sl.cost_base != null) {
        s.total_profit += saleNet(sl) - num(sl.cost_base);
      } else if (p.price_status === 'filled') {
        s.total_profit += saleNet(sl) - proratedPurchaseCost(p, sl.quantity);
      } else if (p.price_status === 'estimated') {
        s.estimated_profit += saleNet(sl) - proratedPurchaseCost(p, sl.quantity);
      }
    });

    s.net_qty = s.total_qty - s.total_sold;
    return s;
  }

  /**
   * 读取全部相关数据，为每个谷子款计算 agg（内存中，保持最新），并把「原本缺少
   * agg」的记录写回缓存（《数据字典》§5 要求 storage 维护 goods.agg）。
   * @returns {Promise<{goods, purchases, sales, orders, characters, enums, summary, byGoods, salesByGoods}>}
   */
  function buildModel() {
    var S = EATG.storage;
    return Promise.all([
      S.getAll('goods'),
      S.getAll('purchase_items'),
      S.getAll('sale_items'),
      S.getAll('orders'),
      S.getAll('characters'),
      S.getAll('enums')
    ]).then(function (r) {
      var goods = r[0], purchases = r[1], sales = r[2], orders = r[3], chars = r[4], enumsRows = r[5];

      var byGoods = {}, salesByGoods = {};
      purchases.forEach(function (p) { (byGoods[p.goods_id] = byGoods[p.goods_id] || []).push(p); });
      sales.forEach(function (sl) { (salesByGoods[sl.goods_id] = salesByGoods[sl.goods_id] || []).push(sl); });

      // 记录原本缺少 agg 的 goods，稍后写回缓存
      var lackedAgg = goods.filter(function (g) { return !g.agg; });

      goods.forEach(function (g) {
        g.agg = computeGoodsAgg(g, byGoods[g.id] || [], salesByGoods[g.id] || []);
      });

      var enums = {};
      (enumsRows || []).forEach(function (row) { enums[row.key] = row.values || []; });

      var model = {
        goods: goods,
        purchases: purchases,
        sales: sales,
        orders: orders,
        characters: chars,
        enums: enums,
        byGoods: byGoods,
        salesByGoods: salesByGoods,
        summary: summarize(purchases, sales, orders)
      };

      // 缓存写回（best-effort，不阻断渲染）
      if (lackedAgg.length) {
        var ops = lackedAgg.map(function (g) {
          return { action: 'put', store: 'goods', value: g };
        });
        S.bulk('goods', ops).catch(function (err) {
          console.warn('[EATG] agg 缓存写回失败（不影响本次展示）:', err);
        });
      }
      return model;
    });
  }

  A.STATUS_RANK = STATUS_RANK;
  A.STATUS_ORDER = STATUS_ORDER;
  A.STATUS_LABELS = STATUS_LABELS;
  A.PRICE_ORDER = PRICE_ORDER;
  A.PRICE_LABELS = PRICE_LABELS;
  A.computeGoodsAgg = computeGoodsAgg;
  A.summarize = summarize;
  A.buildModel = buildModel;
  A.purchaseCost = purchaseCost;
  A.proratedPurchaseCost = proratedPurchaseCost;
  A.saleNet = saleNet;

})(window);
