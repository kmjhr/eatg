# 一咕（EATG）谷子管家APP · 数据字典与存储规范

> 本文档是 AI 开发时的**数据层唯一基准**，与《一咕EATG-详细开发指南.md》配套使用。
> 实现形态：PWA 本地版（纯前端，IndexedDB + localStorage），无后端、无服务器。

---

## 1. 总体约定

| 项目 | 约定 |
|---|---|
| 存储载体 | IndexedDB（业务数据 + 图片）、localStorage（轻量设置与快捷词） |
| 数据库名 | `eatg_db` |
| 版本策略 | `onupgradeneeded` 中建表/升级；升级时用版本号递增并做兼容迁移 |
| 金额存储 | **一律以“分”为单位的整数（Number）存储**，禁止浮点数直接存元；展示时除以100 |
| 日期存储 | 字符串 `YYYY-MM-DD`；时间戳用 Unix 毫秒整数 |
| 主键 | 每张表自增整数 `id` |
| 外键 | 存对方表 `id`，不建 IndexedDB 真实外键约束，由 storage.js 统一校验 |
| 图片 | 压缩后 base64 字符串，存 IndexedDB（不进 localStorage，避免超配额） |
| 币种 | 每笔金额记录原币种（`CNY`/`JPY`/其他）与原币金额；人民币展示由换算函数完成 |
| 所有写入 | 必须经过 `storage.js` 封装（详见 §5），禁止页面直接裸操作 IndexedDB |

---

## 2. IndexedDB 对象仓库（Object Store）清单

数据库 `eatg_db` 包含以下 objectStore（对应 PRD 第5章表5-1～5-9）：

| 序号 | store 名 | 对应表 | 用途 |
|---|---|---|---|
| 1 | `goods` | goods | 谷子款档案 |
| 2 | `purchase_items` | purchase_items | 购入记录 |
| 3 | `orders` | orders | 订单（合单） |
| 4 | `sale_items` | sale_items | 卖出记录 |
| 5 | `sale_orders` | sale_orders | 卖出订单 |
| 6 | `characters` | characters | 角色 |
| 7 | `gallery_items` | gallery_items | 图鉴条目 |
| 8 | `price_records` | price_records | 行情记录 |
| 9 | `news` | news | 发售资讯 |
| 10 | `sources` | sources | 监控源 |
| 11 | `settings` | settings | 设置（键值对） |
| 12 | `enums` | 枚举（内置） | IP/类型/渠道等选项的当前值集合（含自定义项） |

### 2.1 goods（谷子款）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | number | - | 主键自增 |
| name | string | 是 | 谷子名称 |
| ip | string | 是 | IP（取 enums 中 IP 集合值） |
| goods_type | string | 是 | 谷子类型（取 enums 中类型集合值） |
| character_ids | number[] | 否 | 关联角色 id 列表 |
| images | string[] | 否 | 压缩后 base64 图片，最多9张 |
| market_price | number | 否 | 最近市场参考价（分） |
| market_price_source | string | 否 | 参考价来源与记录日期 |
| tags | string[] | 否 | 自定义标签 |
| gallery_item_id | number | 否 | 关联图鉴条目 id |
| note | string | 否 | 备注 |
| created_at | number | 是 | Unix 毫秒 |
| updated_at | number | 是 | Unix 毫秒 |

索引：`ip`、`goods_type`、`name`。

### 2.2 purchase_items（购入记录）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | number | - | 主键自增 |
| goods_id | number | 是 | 所属谷子款 |
| order_id | number | 否 | 所属订单（可为空=散买） |
| buy_date | string | 否 | YYYY-MM-DD |
| quantity | number | 是（>0） | 购入数量 |
| unit_price | number | 否 | 本体单价（分）；买盘打包可留空 |
| currency | string | 否 | CNY / JPY / 其他 |
| shipping_share | number | 否（默认0） | 邮费分摊（分） |
| channel | string | 否 | 购入渠道 |
| status | string | 是 | 枚举：`deposit_pre`(定尾预售)/`full_pre`(全款预售)/`shipping`(在途)/`on_hand`(现货在手)/`sold_out`(已出荷) |
| price_status | string | 是 | `filled`(已填写)/`unknown`(未知)/`estimated`(估算) |
| deposit | number | 否 | 定金（分，定尾预售） |
| balance | number | 否 | 尾款（分，定尾预售） |
| payment_deadline | string | 否 | 补款截止 YYYY-MM-DD |
| arrived_date | string | 否 | 到货日期 |
| sold_quantity | number | 否（默认0） | 已卖出数量（卖出时扣减） |
| note | string | 否 | 备注 |
| created_at / updated_at | number | 是 | Unix 毫秒 |

索引：`goods_id`、`status`、`price_status`、`order_id`。

### 2.3 orders（订单）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | number | - | 主键自增 |
| order_name | string | 否 | 订单名称 |
| order_date | string | 否 | 下单日期 |
| channel | string | 否 | 渠道 |
| goods_total | number | 是 | 商品本体合计（分） |
| shipping_fee | number | 是 | 邮费（分，可为0） |
| paid_total | number | 是 | 实付总额 = goods_total + shipping_fee |
| currency | string | 否 | 币种 |
| split_mode | string | 否 | `per_item`(按件均摊)/`by_amount`(按金额比例)/`manual`(手动指定)/`none`(未分摊) |
| order_image | string | 否 | 订单截图 base64 |
| is_bundle | boolean | 否（默认false） | 是否打包订单（买盘整盒） |
| note | string | 否 | 备注 |
| created_at / updated_at | number | 是 | Unix 毫秒 |

索引：`order_date`、`channel`。

### 2.4 sale_items（卖出记录）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | number | - | 主键自增 |
| goods_id | number | 是 | 所属谷子款 |
| purchase_item_id | number | 是 | 对应的购入记录（算成本） |
| sale_order_id | number | 否 | 所属卖出订单 |
| sale_date | string | 否 | 卖出日期 |
| quantity | number | 是（>0） | 卖出数量 |
| unit_price | number | 是 | 卖出单价（分） |
| currency | string | 否 | 币种 |
| fee | number | 否（默认0） | 手续费（分） |
| shipping_cost | number | 否（默认0） | 卖家邮费（分） |
| net_amount | number | 是 | 实收 = 单价×数量 − 手续费 − 邮费 |
| channel | string | 否 | 卖出渠道 |
| note | string | 否 | 备注 |
| created_at / updated_at | number | 是 | Unix 毫秒 |

索引：`goods_id`、`purchase_item_id`、`sale_order_id`。

### 2.5 sale_orders（卖出订单）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | number | - | 主键自增 |
| sale_order_name | string | 否 | 卖出订单名称 |
| sale_date | string | 否 | 卖出日期 |
| channel | string | 否 | 渠道 |
| total_price | number | 是 | 总售价（分） |
| total_fee | number | 否（默认0） | 总手续费（分） |
| total_shipping | number | 否（默认0） | 总邮费（分） |
| net_total | number | 是 | 实收总额 = 总售价 − 总手续费 − 总邮费 |
| currency | string | 否 | 币种 |
| split_mode | string | 否 | `per_item`/`by_amount`/`manual`/`none` |
| note | string | 否 | 备注 |
| created_at / updated_at | number | 是 | Unix 毫秒 |

索引：`sale_date`、`channel`。

### 2.6 characters（角色）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | number | - | 主键自增 |
| name | string | 是 | 角色名 |
| ip | string | 是 | 所属 IP |
| avatar | string | 否 | 头像 base64 |
| is_favorite | boolean | 否 | 是否自推（默认素世=true） |

### 2.7 gallery_items（图鉴条目）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | number | - | 主键自增 |
| character_id | number | 是 | 所属角色 |
| name | string | 是 | 条目名称（官方谷子） |
| series | string | 否 | 系列 |
| release_date | string | 否 | 发售日期 |
| image | string | 否 | 图片 base64 |
| owned | boolean | 是 | 是否已拥有（手动标记） |
| goods_id | number | 否 | 关联谷子款 id（可选） |

索引：`character_id`。

### 2.8 price_records（行情记录）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | number | - | 主键自增 |
| goods_id | number | 是 | 所属谷子款 |
| platform | string | 否 | 闲鱼/淘宝/煤炉/日拍/实体店/其他 |
| price | number | 是 | 成交价或挂价（分） |
| condition | string | 否 | 全新/未拆/拆摆/瑕 |
| record_date | string | 否 | YYYY-MM-DD |
| note | string | 否 | 备注 |
| created_at | number | 是 | Unix 毫秒 |

索引：`goods_id`、`record_date`。

### 2.9 news（发售资讯）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | number | - | 主键自增 |
| source_id | number | 否 | 来源监控源 id |
| title | string | 是 | 标题 |
| image | string | 否 | 图片 base64 |
| ip | string | 否 | IP |
| character_ids | number[] | 否 | 角色 id |
| goods_type | string | 否 | 谷子类型 |
| preorder_time | string | 否 | 开订时间 |
| release_time | string | 否 | 出荷/发货时间 |
| price | number | 否 | 参考价格（分） |
| channel | string | 否 | 发售渠道 |
| status | string | 是 | `normal`/`wish`(想买)/`ordered`(已订)/`ignored`(忽略) |
| is_read | boolean | 否 | 已读 |
| created_at | number | 是 | Unix 毫秒 |

索引：`source_id`、`is_read`、`status`。

### 2.10 sources（监控源）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | number | - | 主键自增 |
| name | string | 是 | 名称 |
| url | string | 是 | 地址 |
| type | string | 是 | `official`(官网)/`rss`/`custom` |
| enabled | boolean | 是 | 是否启用 |
| fetch_interval | string | 否 | 抓取频率（二期用） |

### 2.11 settings（设置，键值对）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| key | string | 是（主键） | 设置项标识 |
| value | string | 是 | JSON 编码的值 |

内置键：
- `default_currency`：默认币种，如 `CNY`
- `exchange_rate`：JPY→CNY 汇率（如 0.049），对象 `{rate, updated_at, source:'manual'|'api'}`
- `reminder`：提醒设置 `{preorder_lead:1|3, deadline_lead:1|3, quiet_start:'22:00', quiet_end:'08:00', enabled:true}`
- `image_quality`：压缩质量 0~1（默认0.8）
- `auto_backup_remind`：自动备份提醒开关与周期
- `last_backup_at`：最近备份时间
- `custom_options`：自定义选项 `{ips:[], goods_types:[], channels:[], sale_channels:[], conditions:[]}`

### 2.12 enums（枚举当前值）

为每个枚举存一份当前有效值数组（含预置+自定义），键名：`ip` / `goods_type` / `channel` / `sale_channel` / `condition` / `goods_status` / `price_status` / `split_mode`。

预置值（必须内置，不可删除；自定义项可增可删）：
- ip：`MyGO`、`邦邦`、`无期迷途`、`其他`
- goods_type：`徽章（吧唧）`、`立牌`、`亚克力挂件`、`色纸`、`拍立得`、`卡片`、`文件夹`、`娃娃`、`其他`
- channel：`淘宝`、`闲鱼`、`煤炉`、`日拍`、`官方通贩`、`实体店`、`其他`
- sale_channel：`闲鱼`、`煤炉`、`日拍`、`实体店`、`转出给他人`、`其他`
- condition：`全新`、`未拆`、`拆摆`、`瑕`、`其他`
- goods_status：`deposit_pre`、`full_pre`、`shipping`、`on_hand`、`sold_out`（见 §4 状态机）
- price_status：`filled`、`unknown`、`estimated`

---

## 3. localStorage 键

| 键 | 内容 | 说明 |
|---|---|---|
| `eatg_quick_words` | 各输入字段快捷字词数组 `{field, words:string[]}` | 支持自定义默认快捷字词 |
| `eatg_ui` | 界面偏好 `{theme:'light'|'dark'|'system'}` | 深色模式 |
| `eatg_last_route` | 上次页面路由 | 启动恢复 |

> 图片、业务数据**禁止**进 localStorage。

---

## 4. 状态机（唯一口径）

谷子状态字段 `status` 合法流转：

```
deposit_pre（定尾预售）──补款完成一键──▶ full_pre（全款预售）──发货──▶ shipping（在途）──到手──▶ on_hand（现货在手）──卖出──▶ sold_out（已出荷）
       ▲                                              │
       └─────────────────────── 允许回退任意前序状态 ────────────────┘
```

- 手动流转：任意状态可回退到任意前序状态（需确认）。
- 卖出联动：创建卖出记录时，对应购入记录自动置 `sold_out` 并扣减 `sold_quantity`；删除卖出记录时还原（若原状态不是 sold_out 则恢复原状态并加回数量）。
- 图鉴联动：谷子款任一购入记录状态变为 `on_hand` 时，关联图鉴条目 `owned=true`；状态为预售/在途时图鉴显示“已拥有未出荷”半亮态；无任何记录时图鉴显示“未拥有”。

---

## 5. storage.js 封装接口（数据层唯一入口）

所有页面不得直接调用 `indexedDB.open`，统一走 `storage.js` 导出函数：

| 函数 | 说明 |
|---|---|
| `initDB()` | 建库建表，返回 Promise |
| `add(store, obj)` | 新增，自动补 id/created_at/updated_at |
| `put(store, obj)` | 更新（整体替换，含 updated_at） |
| `get(store, id)` | 按主键取 |
| `getAll(store)` | 全量取 |
| `del(store, id)` | 删除 |
| `query(store, index, value)` | 按索引精确查 |
| `queryRange(store, index, lower, upper)` | 按索引范围查 |
| `bulk(store, ops)` | 事务批量（读改写、分摊保存等必须用事务） |
| `count(store, index, value)` | 计数 |

新增/更新/删除后的**聚合统计**（总数量、总投入、均价、盈利）不实时全表重算，采用增量缓存：`goods` 记录上冗余 `agg` 字段（`total_qty`、`total_cost`、`total_sold`、`total_profit`、`estimated_profit`、`filled_only_cost`），由 storage.js 在 purchase/sale 变更时更新；统计页读取后仍须按 §《业务规则》口径校验。

---

## 6. 导出/备份 JSON 格式（唯一标准）

备份文件为一个 JSON 对象：

```json
{
  "app": "eatg",
  "version": 1,
  "exported_at": "2026-10-13T12:00:00+08:00",
  "data": {
    "goods": [...],
    "purchase_items": [...],
    "orders": [...],
    "sale_items": [...],
    "sale_orders": [...],
    "characters": [...],
    "gallery_items": [...],
    "price_records": [...],
    "news": [...],
    "sources": [...],
    "settings": {...},
    "enums": {...}
  }
}
```

- 五维度单独导出：`goods` / `purchase_items` / `orders` / `sale_items` / `sale_orders` 可单出或合并，文件头同上（data 内只含所选集合）。
- 恢复时校验 `app==='eatg'` 与 `version<=1`，导入前自动把当前数据完整备份一份（追加 `.pre-restore-<时间戳>` 文件）。
- CSV 导出列名必须与本节字段名一致（金额导出为“分”整数，表头注明单位）。

---

## 7. 常见实现错误清单（开发时对照）

1. 金额用浮点元直接存储 → 必须用“分”整数，所有换算在展示层完成。
2. 图片塞进 localStorage → 超配额静默失败，必须存 IndexedDB。
3. 删除谷子款时不同步删 purchase/sale/price → 必须级联清理并二次确认。
4. 卖出时忘记扣减 `sold_quantity`/置 `sold_out` → 在 storage.js 事务内完成，禁止页面手动改两个表。
5. 分摊尾差处理不定义 → 尾差（四舍五入后剩余分）计入最后一项，并在界面上提示。
6. `onupgradeneeded` 只建表不处理版本迁移 → 版本递增时保留旧数据合并。
7. 跨 store 写操作不用事务 → 使用 `bulk()` 保证原子性。
