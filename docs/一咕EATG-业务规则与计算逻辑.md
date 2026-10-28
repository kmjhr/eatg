# 一咕（EATG）谷子管家APP · 业务规则与计算逻辑

> 本文档是 AI 开发时的**金额/分摊/盈利/状态/统计口径唯一基准**，与《一咕EATG-详细开发指南.md》配套使用。
> 所有金额单位默认“分”（整数）；日期 `YYYY-MM-DD`。

---

## 1. 金额体系

| 概念 | 定义 | 存储字段 |
|---|---|---|
| 本体单价 | 一件谷子的商品价格（不含邮费） | purchase_items.unit_price |
| 邮费分摊 | 该件谷子承担的一次合单邮费份额 | purchase_items.shipping_share |
| 单件购入成本 | 本体单价 + 邮费分摊（估算/未知另有口径，见 §6） | 计算值 |
| 订单实付总额 | 订单内商品本体合计 + 邮费 | orders.paid_total |
| 卖出单价 | 一件谷子的成交价 | sale_items.unit_price |
| 手续费 | 平台抽成（如闲鱼手续费） | sale_items.fee |
| 卖家邮费 | 卖出时买家未承担部分由卖家出的邮费 | sale_items.shipping_cost |
| 单件实收 | 单价×数量 − 手续费 − 卖家邮费 | sale_items.net_amount |
| 单件盈利 | 实收 − 对应购入成本 | 计算值 |

**必须满足的账目平衡（保存前校验，不满足阻止保存）：**
1. 订单：`paid_total === Σ(各件 unit_price×quantity) + Σ(各件 shipping_share)`（打包订单的 unit_price 可为空，此时用已分摊值校验）。
2. 卖出订单：`net_total === Σ(各件 net_amount)`。

---

## 2. 邮费分摊（orders.split_mode）

场景：一次下单 N 件谷子，共用邮费 `S` 分。目标：为每件算出 `shipping_share`。

### 2.1 按件均摊（per_item）
- 每件 = `floor(S / N)`；剩余 `S - floor(S/N)*N` 分计入**最后一件**。
- 例：S=1000 分（10元），N=3 → [333,333,334]。
- 当各件数量不同时，**按件数加权**：总件数 T=Σquantity，每件 = floor(S×quantity/T)，尾差计入最后一件。

### 2.2 按金额比例（by_amount）
- 每件 = floor(S × 该件本体小计 / 本体总合计)；尾差（S − Σ）计入最后一件。
- 仅当订单内所有件本体金额都已知（price_status=filled/estimated）时可用；存在 unknown 时禁止选择该模式并提示“先补录金额或改用手动指定”。

### 2.3 手动指定（manual）
- 逐件填写非负整数（分），实时显示“已分摊 S′ / 应分摊 S”；差值显示为“待分配”，保存时校验 S′ === S；S′ < S 时把差值自动并入最后一件并提示“尾差已并入末件”。

### 2.4 未分摊（none）
- 所有件 shipping_share = 0，订单金额仅记总账；界面明确标注“未分摊”。统计时该订单邮费不计入任何单件成本，但计入全局“邮费合计”。

### 2.5 打包订单本体分摊（is_bundle=true）
- 买盘/整盒以总价购入、单件价不清时：记录订单 goods_total 与 is_bundle=true。
- 拆分方式三选一：按件均摊本体 / 按市场参考价比例拆分 / 手动指定。
- 未拆分的件保持 `unit_price=null`、`price_status='unknown'`，列表显示“价格待分”。
- 该订单在统计中：已分摊部分计入总投入；未分摊部分计入“价格未知”单列，不混入“已填写”。

---

## 3. 卖出收入分摊（sale_orders.split_mode）

与 §2 对称：总实收 `net_total` 分摊到各件 `net_amount`。
- per_item：按件数/数量均摊，尾差计入最后一件。
- by_amount：按各件售价小计占比分摊，尾差计入最后一件。
- manual：逐件填写，校验 Σ === net_total，尾差并入最后一件。
- 分摊结果与单件盈利联动：改分摊后所有相关盈利立即重算。

---

## 4. 盈利计算（唯一口径）

```
单件实收 net = unit_price × quantity − fee − shipping_cost
购入成本 cost = unit_price × quantity + shipping_share        // 对应购入记录
单件盈利 profit = net − cost
```

| 购入记录 price_status | 盈利口径 |
|---|---|
| filled（已填写） | 计入“已实现盈利”，正常展示（正=赚、负=亏） |
| estimated（估算） | 单独统计为“估算盈利”，在盈利处标注“估算”，**不混入**已实现盈利 |
| unknown（未知） | 成本未知：盈利**不计算**，界面显示“成本未知，暂不计盈利”，并计入“待补成本件数” |

- 谷子款累计盈利 = Σ(该款各 sale_items 的 profit，仅 filled 口径)。
- 全局总盈利 = Σ(全部 sale_items 的 profit，仅 filled 口径)；估算盈利单列。
- 盈利排行维度：按谷子款 / 角色 / IP 聚合（仅 filled 口径），亏损标红。
- 成本为估算时，该笔的盈利放入“估算盈利”，即使 result 为负也不进已实现盈利。

---

## 5. 统计口径（唯一口径，不可混用）

| 指标 | 公式/口径 |
|---|---|
| 总件数 | Σ purchase_items.quantity − Σ sale_items.quantity（或 Σ 剩余可卖数量） |
| 总投入（已填写） | Σ filled 记录的（unit_price×quantity + shipping_share） |
| 总投入（估算） | Σ estimated 记录同上，单列 |
| 总投入（未知） | unknown 记录不计金额，仅计件数，单列“价格未知件数” |
| 邮费合计 | Σ 全部 purchase_items.shipping_share（含未分摊订单的 shipping_fee，两者去重：未分摊订单只计一次） |
| 均价 | 总投入（已填写）÷ 总件数（仅 filled 口径，可另算含估算的参考均价） |
| 市价总值 | Σ goods.market_price（最近一次行情或手动指定均价），无行情的谷子不计并计数 |
| 总盈利 | §4 的 filled 口径合计 |
| 估算盈利 | §4 的 estimated 口径合计 |
| 未计价件数 | price_status ∈ {unknown, estimated} 的购入记录件数（可分别计数） |

**总统计并存**：首页/统计页提供“分开统计”默认视图（已填写/估算/未知三栏），并提供“总统计（合并）”切换，合并口径必须标注“含估算”。

---

## 6. 价格状态管理

| price_status | 触发 |
|---|---|
| filled | 录入时填写了单价 |
| unknown | 单价留空保存；打包订单未分摊件 |
| estimated | 用户手动标记；按市场参考价批量补录时自动置 estimated |

操作规则：
- 批量补录：筛选 unknown 件 → 填市场参考价 → 批量写入并置 estimated（可逐条改回 filled）。
- unknown → filled：直接编辑单价并保存。
- filled → estimated：手动改（说明原因场景：价格是回忆/估算）。

---

## 7. 定尾预售与补款

- 状态 `deposit_pre`：可记 deposit（定金）、balance（尾款）、payment_deadline（补款截止）。
- “一键转全款预售”：校验 deposit+balance 已填（至少尾款金额已确定）→ 状态置 `full_pre`，清除 payment_deadline 的待办标记，保留金额记录。
- 提醒：payment_deadline 前 1 天/3 天（按设置）触发本地通知；已过期未补款显示红色角标“待补款”。

---

## 8. 汇率换算（唯一口径）

- 录入时保存 `currency` 与**原币金额**，不换算存储。
- 展示时：CNY 直接显示；JPY 等 → 换算为人民币 = round(原币分 × rate)。
- `rate` 来源：settings.exchange_rate；可为手动值或免费 API 自动更新（失败时沿用最近一次并标注“汇率可能过期”，不阻断使用）。
- 统计、盈利、行情展示统一走 `fmtMoney(amount, currency)` 函数，禁止各处自行换算。

---

## 9. 图鉴三态（唯一口径）

| 状态 | 判定 |
|---|---|
| 已拥有（亮显） | 存在关联 goods 且其任一购入记录 status=on_hand（或 goods 被标记已到手） |
| 已拥有未出荷（半亮） | 存在关联 goods，但记录均处于 deposit_pre/full_pre/shipping，显示对应状态角标 |
| 未拥有（灰） | 无关联 goods，且 owned=false |

- gallery_items.owned 为手动兜底标记；有关联 goods 时以 goods 状态为准并自动覆盖 owned。
- 收藏库状态变更（→on_hand）时：自动点亮图鉴；图鉴页提供“去补录”跳转。

---

## 10. 发售资讯操作（一期）

- 资讯卡片三操作：`wish`（想买→进愿望清单，开订/出荷前提醒）、`ordered`（已订→创建 goods 草稿并进入新增页预填：name/ip/character/type/preorder 时间，状态置对应预售）、`ignored`（忽略，可撤销）。
- 一期**不实现** X/官网自动抓取；RSS 读取受 CORS 限制时提示“网络受限，可手动添加”，不报错崩溃。
- 监控源页仅做管理与占位说明（二期服务端抓取）。

---

## 11. 删除与级联（唯一规则）

| 操作 | 级联行为 |
|---|---|
| 删除 goods | 二次确认 → 删除其 purchase_items、sale_items、price_records；orders 保留但移除关联（若订单空则保留订单本身） |
| 删除 purchase_item | 若有 sale_items 关联 → 阻止，提示“先删除关联卖出记录”；若无 → 直接删并重算 goods.agg |
| 删除 sale_item | 还原对应 purchase_item：sold_quantity 减回、状态还原（原非 sold_out 则还原）、重算 agg |
| 删除 sale_order | 二次确认 → 删除其内 sale_items（按上一条还原） |
| 删除 order | 二次确认 → 其内 purchase_items 的 order_id 置 null（保留记录），重算分摊 |

---

## 12. 校验规则清单（表单与保存前）

1. goods.name 必填；ip、goods_type 必选。
2. purchase_items.quantity > 0；unit_price ≥ 0（可为空）。
3. shipping_share ≥ 0 整数分。
4. 订单：paid_total === Σ 本体 + Σ 分摊（§1）。
5. 卖出订单：net_total === Σ net_amount（§1）。
6. sale_items.quantity ≤ purchase_item 剩余可卖数量（quantity − sold_quantity）。
7. 删除类操作一律二次确认；恢复备份前自动备份当前数据。
8. 分摊模式选 by_amount 时校验订单内本体金额均已知。
9. 图片 ≤ 9 张/款；单张压缩后 ≤ 约 800KB（超出则降质重压）。
10. 日期格式 YYYY-MM-DD；补款截止时间可为空，为空则不做提醒。
