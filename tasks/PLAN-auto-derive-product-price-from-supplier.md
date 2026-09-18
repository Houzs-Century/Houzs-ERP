# PLAN — Auto-derive the Product Maintenance price from Supplier prices

Status: OWNER APPROVED 2026-09-16; staged implementation in progress. Read-only
investigation done on production `anogrigyjbduyzclzjgn` ("HOUZS ERP SG") and the
code in this worktree, 2026-09-16. Every count below was read off the live
database at the moment of writing (R07); code claims are labelled PROVEN /
UNKNOWN (R02).

Owner decisions folded in (2026-09-16): (1) "most expensive" = the WHOLE SET
from the single dearest supplier, not a per-cell max. (2) **Backend-only — ZERO
frontend diff**: the recompute overwrites the stored product cost on a
supplier-price change; the frontend keeps reading the same column; the manual
field is NOT made read-only (a stray manual edit is just overwritten on the next
recompute). (3) **Effective dating is IN SCOPE** (not deferred): a supplier
price carries a valid-from with the prior value kept, and the derived cost is
as-of-date-aware. (4) Surface price CONFLICTS (a SKU/combo whose suppliers
disagree) so the owner removes/edits the wrong one. (5) Cost basis CONFIRMED:
the Sales Report SO stage already reads the Product-Maintenance-derived cost
(`total_cost_sen` via `computeMfgLineCost`); the shipped/DO stage stays on actual
FIFO `ship_cost_sen` and is never touched.

---

## 1. 白话文总结（给老板）

**你要的效果**：以后价钱只在「供应商」那边维护（一个供应商就用它的价，多个供应商
就用**最贵**那个）。产品维护（Product Maintenance）里的那个价、沙发 combo 的价、
以及腿/高度/gap/布料 special 的价，全部**自动算出来**，你再也不用手动填。

**现在系统怎么做的（3 行）**：
- 供应商的价钱存在 `supplier_material_bindings`（每个公司、每个供应商、每个 SKU
  一行，带供应商货号 `supplier_sku` + 价钱）。产品维护那个「成本价」是**另外手动
  填**的 `base_price_sen`（Price 2），今天 2,657 个上架 SKU 里有 1,219 个手动填了。
- 现在有个「锚定」功能（is_cost_anchor）：你手动挑一个供应商，产品价和它双向同步。
  **全系统只有 1 个 SKU 真的用了这个功能** —— 所以要改掉它，几乎不会动到任何现有数据。
- 沙发 combo 和 special 也已经分「master（参考价）」和「每个供应商」两套价，今天
  master 是手填的，供应商那套是你另外维护的。

**我建议的做法**：把现有的「锚定同步」反过来用 —— 不再是「手填产品价、同步给一个
供应商」，而是「**产品价 = 所有供应商里最贵的那个，自动写回产品档**」，产品维护那
个价钱变成**只读、自动算**。沙发 combo 和 special 同样：master = 供应商里最贵的。
这样改动最小，因为这条「同步」的管子已经建好、有测试，只要换触发点（从「那一个锚
定供应商」换成「全部供应商取最贵」）和方向。

**最大的风险（要先讲清楚）**：
1. **历史 Sales Report 不会变**。已出货的交货单（DO）用的是**出货当天冻结的实际
   FIFO 成本**（`ship_cost_sen`），不是产品维护那个价 —— 所以改产品价，**不会**倒
   改已经出货的利润数字。这几乎肯定是你要的（过去的账不能动）。但也意味着：产品维
   护那个价，其实主要影响的是**销售单当下算的成本/毛利**，不是已出货那一笔。这一点
   和「DO 出货时抓产品价来算利润」的说法**有出入**，我先摆出来，不替你圆过去（R08）。
2. **没有供应商的 SKU 会算出空价**。今天公司 1 有 343 个、公司 2 有 49 个上架 SKU
   完全没有供应商绑定 —— 这些自动算就是空的。按你的新要求，这些要当成「绑定缺口」
   列出来给你补，不能默默留空。
3. **「最贵」怎么定义**，沙发/床架不是一个价而是一张表（按高度、按 P1/P2），要先
   决定是「整体最贵的那个供应商整套拿过来」还是「每一格各自取最贵」。

**要你拍板的 3 件事**（详见第 8 节）：最贵的定义、按哪个日期算、DO 利润口径确认。

---

## 2. 现在的机制（PROVEN，附证据在第 9 节）

### 2.1 供应商价钱存哪里
`scm.supplier_material_bindings`，主键范围 `(company_id, supplier_id,
material_kind='mfg_product', item_code)`。关键列（PROVEN，`suppliers.ts` 的
`BINDING_COLS`）：
- `supplier_sku` — **供应商自己的货号**。这就是老板说的「内部码 ↔ 供应商码」的绑定。
  生产上 3,196 行 mfg_product 绑定**全部**有 supplier_sku（100%）。PO PDF 印的
  "Supplier Code"、AutoCount write-back 送的 ItemCode 都来自它（PROVEN，
  `po-line-supplier-sku.ts`）。
- `unit_price_sen` — 平价（flat），MATTRESS/ACCESSORY/SERVICE 用。
- `price_matrix`（jsonb）— BEDFRAME `{P1,P2}`、SOFA `{高度:{P1,P2,P3}}`。3,196 行
  里 1,030 行有 matrix。
- `is_main_supplier` — 每个 SKU 一个「主供应商」（写入时自动清掉别的）。很多读取路
  径「取第一行」就靠它排序。
- `is_cost_anchor` — 「成本锚定」旗标（见 2.3）。
- `price_valid_from` / `price_valid_to` — **休眠列，生产上 0 行填了值，没有任何读取
  路径用它**（PROVEN）。也就是说供应商价钱**今天没有生效日期**。

### 2.2 产品维护那个价存哪里
`scm.mfg_products`：
- `base_price_sen` — **PRICE_2 / 成本参考价**。这就是老板说的「产品维护那个价」。
- `price1_sen` — PRICE_1 成本。
- `seat_height_prices`（jsonb）— 沙发按高度的成本网格。
- `sell_price_sen` — 客户售价（另一回事，见下）。`cost_price_sen`、`pwp_price_sen`。

**谁读 `base_price_sen`（每一处，PROVEN）**：
- `computeMfgLineCost`（`shared/mfg-pricing.ts`）—— **销售单一行的成本**
  `unit_cost_sen` / `line_margin_sen` 就是从 `base_price_sen`/`price1_sen`/
  `seat_height_prices` 算出来的。**售价那半（`computeMfgLinePrice`）故意不读它**
  （代码注释：这些字段是「成本，不是售价」）。
- 成本锚定同步（2.3）。
- 沙发定价链（`sofa-build.ts` / `sofa-combo-pricing.ts`）、`product-models.ts`、
  `pos-pools.ts`、`so-revision.ts`、`one-shot-mint.ts`、`free-gift-reconcile.ts`、
  `mfg-pricing-recompute.ts`。
- **注意**：开 PO 的成本**不读** `base_price_sen`，而是读该供应商自己的绑定
  （`deriveMfgPoUnitCost` → `supplier_material_bindings`）。所以「PO 用供应商价」已
  经是现状。

### 2.3 现在怎么把两边连起来（要改掉的「锚定」）
- `suppliers.ts` 管理绑定：新增/批量/修改（带 supplier_sku + 价）、设主供应商、
  **设成本锚定**（`is_cost_anchor`，一个 SKU 一个，设一个清其他）。
- **成本锚定双向同步**（mig 0177，`cost-anchor-sync.ts`）：某个 SKU 有一行标
  `is_cost_anchor` 时——
  - FLAT/BEDFRAME：产品价 ↔ 那一行绑定价 **双向**同步。
  - SOFA：**单向** 产品 → 绑定（产品档为准，老板 2026-07-20「我这用的是产品档」）。
  - 触发点：改产品价时 `syncAnchorBindingFromProduct`；改绑定价时
    `bindingToProductPatch`。
- **生产上只有 1 行绑定 / 1 个 SKU 真的开了这个锚定**（PROVEN）。等于这功能几乎没人
  用 —— 换掉它风险极低。

### 2.4 沙发 combo + special 价
- **Combo**：`scm.sofa_combo_pricing`，scope = `base_model + modules + tier +
  customer_id + supplier_id`。`supplier_id = null` 是 **master / 销售参考**那套，
  `supplier_id = <uuid>` 是**该供应商的成本**。append-only + 生效日期 + 软删。生产
  上 361 行有效，其中 187 行是供应商成本行（两家公司都有）。`sofa_combo_anchor`
  （mig 0283）把一个 base_model 锚定到一个供应商，双向镜像 master ↔ 该供应商行。
- **Special / 腿 / 高度 / gap**：`scm.maintenance_config_history`，scope = `master`
  或 `supplier:<id>`，append-only + 生效日期。resolver `loadConfigForScope` /
  `resolveMaintenanceConfigForSupplier`：先找供应商 scope，没有再退回 master。生产
  上 76 行，其中 8 行是供应商 scope（2 个供应商）。

### 2.5 Sales Report / DO 出货抓价（PROVEN，`docs/modules/delivery-order.md`）
交货单一行捕捉三种钱：
- `unit_price_sen`（售价）— DO 锁定前一直是活的，来自销售单。
- `unit_cost_sen` / `line_cost_sen` / `line_margin_sen` — **就地覆写**，
  `restampDoActualCost` 从**实际入库movement 的 FIFO 成本**重算（出货时、改行时、供
  应商 PI 落地时都会重跑）。
- `ship_cost_sen` — **出货当天冻结**（mig 0143）。第一次出货后成本一旦写了，之后任
  何重算都不再动它。

Sales Report（代码叫 Fair Report）DO 阶段：成本 = `ship_cost_sen ?? unit_cost_sen`
（实际 FIFO），收入 = `unit_price_sen`。**所以：已出货那笔的成本是实际 FIFO 冻结值，
不是产品维护价。** 产品维护价 `base_price_sen` 真正影响的是**销售单当下**的成本/毛
利基准。→ 改 `base_price_sen` 不会倒改已出货的历史 Sales Report。（这是第 1 节风险 1
的证据；也是「历史数字保住」的答案。）

> UNKNOWN / 待确认：老板口中「DO 出货抓产品价算利润」与上述 FIFO 口径的出入。可能是
> 老板想要的是「销售单毛利基准」而非已出货那笔，或另有一个我没看到的报表口径。第 8
> 节列为待答问题 3。

---

## 3. 生产现况（PROVEN，2026-09-16，项目 anogrigyjbduyzclzjgn）

| 事实 | 公司 1 | 公司 2 |
|---|---|---|
| 有供应商绑定的 SKU | 1,996 | 314 |
| — 只有 1 个供应商 | 1,682 | 246 |
| — 有多个供应商（最多） | 314（最多 7） | 68（最多 5） |
| 多供应商里 flat 价真的不同（max>min） | 43 / 314 | 66 / 68 |
| 上架 SKU 总数 | 2,303 | 354 |
| **无任何供应商绑定的上架 SKU（会算出空价 = 绑定缺口）** | **343** | **49** |
| — 其中今天还手填了成本价的 | 7 | 8 |

全系统（两家公司合计，mfg_product 绑定 3,196 行）：
- `price_valid_from/to` 填了值：**0**（供应商价无生效日期）。
- 有 price_matrix：1,030。 supplier_sku 齐全：3,196 / 3,196（100%）。
- flat 价 = 0：1,664（52%，沙发/床架价在 matrix，或「零价伪绑定」待 PI 时补价）。
- **`is_cost_anchor = true`：全系统只有 1 行 / 1 个 SKU。**
- 上架 SKU 手填了 `base_price_sen > 0`：1,219 / 2,657。
- 沙发 combo 有效 361 行（187 供应商 scope）；maintenance_config 76 行（8 供应商 scope）。

**含义**：
- 「多个供应商取最贵」真正会改变 flat 价的，公司 1 只有 43 个 SKU、公司 2 有 66 个。
  但沙发/床架价在 matrix 里，flat 比较看不到，真正影响面要按 matrix 比（见第 8 节问题 1）。
- 要改掉的锚定功能几乎没人用（1 个 SKU），拆除风险极低。
- 绑定缺口是实打实的：392 个上架 SKU（343+49）会算出空价，必须先有报表让老板补。

---

## 4. 要建的规则

产品维护价（成本基准）**改为自动派生**，永远等于：
- 一个供应商 → 该供应商的价。
- 多个供应商 → **最贵**供应商的价。
- 沙发 combo master 行、special/腿/高度/gap 的 master → 同理，取供应商里最贵。

产品维护、沙发 combo、special 的**手动输入取消**（改只读）。供应商 ↔ SKU 的关系
（哪些供应商供这个 SKU、供应商货号 supplier_sku、每个供应商的价）**保留** —— 它是
派生的来源。派生出空价 = 该 SKU 没有供应商绑定 = 「绑定缺口」，要列出来给老板补。

---

## 5. 设计：怎么算、放哪里（R18 三个选项 + 推荐）

### 5.1 派生值放哪里

**选项 A — 存成派生列，供应商价一改就重算**
- 做法：把现有 `cost-anchor-sync` 的方向反过来 —— 任何供应商绑定写入（新增/改价/删）
  后，读该 SKU 所有供应商，取最贵，写回 `mfg_products.base_price_sen` /
  `price1_sen` / `seat_height_prices`。产品维护那个价变只读。
- 好处：**读取路径几乎不动** —— `computeMfgLineCost`、沙发链、所有现有消费者继续读
  `base_price_sen`，照常工作。读很便宜。复用已建好、有测试的同步管子。
- 代价：每次供应商价变都要重算一次；要一次性 backfill 把 1,219 个手填值换成派生值；
  存的派生列理论上会和来源不同步（用触发器 + 校验脚本兜底）。

**选项 B — 读时计算，不存**
- 做法：写一个 resolver `resolveDerivedProductCost(companyId, code, asOf)`，读绑定取
  最贵；`base_price_sen` 退化为「无绑定时的 fallback」。
- 好处：永远准，不存重复数据，天生可按日期算。
- 代价：**要改所有读取路径**（第 2.2 节列的一堆消费者），销售单定价时多几次读，
  改动面大、money-critical、回归风险高。

**选项 C（推荐）— 混合：存派生列（A 的形态）+ 把派生逻辑抽成一个纯函数**
- 派生逻辑（max over suppliers，含 matrix 形态转换）抽成一个 pure function，供
  ①绑定写入后的重算、②一次性 backfill、③绑定缺口校验报表 三处复用（和现有
  `cost-anchor-sync.ts` 同风格：纯函数 + 路由做那一次写）。
- 产品维护价保留为「存着的、只读的、自动维护的」值 —— 现有消费者零改动。
- 日期感知**先不做**（见 5.2），等 Phase 2 供应商价历史落地再加。
- **为什么推荐**：改动最小、复用已验证的管子、money-critical 的读取路径不动、可分阶
  段 inert 上线（R27）。本质上是「把 1 个锚定供应商的同步，换成全部供应商取最贵」。

### 5.2 按哪个日期算（date-aware）
- 今天供应商价**没有生效日期**（`price_valid_from/to` 0 行）。所以「按文件日期算」现
  在无从谈起 —— 要先建供应商价历史（`pricing-effective-dating-design.md` 的 Phase 2，
  `scm.supplier_binding_price_history`，**尚未实现**）。
- 售价那半已有历史表 `mfg_product_price_history` + resolver `resolveSellPriceSenAsOf`
  （按**文件自己的日期**算，Phase 1 已上线），成本这半没有对应历史表。
- 推荐：**先用「当下最贵」派生**（选项 C，inert 安全）；Phase 2 供应商价历史落地后，
  派生改为「按销售单/交货单日期，取当时最贵」。这也符合老板「在供应商那边维护价 + 生
  效日期」的原话。

### 5.3 「最贵」在 matrix 类别怎么定义
沙发/床架不是一个数，是一张表。两种取法（第 8 节问题 1 请老板拍板）：
- **(推荐) 整体最贵供应商整套拿**：先按某个可比口径（如各供应商的代表价/加总）选出
  「最贵的那个供应商」，把它**整套** matrix 拿过来。不会出现 franken 表。
- **每格各自取最贵**：每个 (高度, tier) 格子跨供应商取 max。更「贵」，但会拼出一张
  没有任何单一供应商真的报过的表，PO 对不上。

---

## 6. 迁移（换掉手填价，会坏什么）

- **一次性 backfill**：为每个有绑定的 SKU，用派生纯函数算出 `base_price_sen` /
  `price1_sen` / `seat_height_prices` 写入（复用第 5.1 纯函数；DRY-RUN 默认，
  `apply=1` 才写，符合 R85 脚本纪律）。影响约 1,960 个有绑定 SKU；覆盖今天 1,219 个手
  填值。
- **会坏 / 要处理**：
  - 无绑定的 343（C1）+ 49（C2）个上架 SKU → 派生空价。其中 7+8 个今天还手填着价，
    backfill 后会「失去」那个手填值 → 必须先出绑定缺口报表（第 7 节）让老板补绑定。
  - 产品维护 / 沙发 combo master / special master 的输入框改**只读**。
- **对现有单据的影响**：
  - 销售单已 stamp 的 `unit_cost_sen` 不动，只有重算（改行/re-recompute）时才用新派生
    价 —— 对**未出货的开口单**，成本/毛利会更新成更准的值（这正是老板要的）。
  - **已出货 DO / 历史 Sales Report 不受影响** —— 用的是冻结的 `ship_cost_sen`（实际
    FIFO），不是 `base_price_sen`（PROVEN，2.5 节）。这一条几乎肯定要保：过去的账不能
    动。请在问题 3 确认口径。

## 7. 拆除「绑定」功能（精确范围，按老板澄清）

**移除**（改自动/只读）：
- 产品维护里 `base_price_sen` / `price1_sen` / 沙发成本网格的**手动输入**。
- 沙发 combo master 行、special/腿/高度/gap master 的**手动输入**。
- **成本锚定**：`is_cost_anchor` 开关 + 双向 `cost-anchor-sync` 镜像 + `sofa_combo_anchor`
  镜像 —— 换成「全部供应商取最贵」的自动派生。`is_cost_anchor` 列可弃用（生产仅 1 行）。

**保留**（是派生的来源，绝不能删）：
- `supplier_material_bindings` 整张表 + `supplier_sku`（PO PDF + AutoCount write-back
  必需）+ `is_main_supplier`（多处「取第一行」靠它）+ 每供应商价/matrix + 供应商 ↔ SKU
  链接本身。
- 供应商 scope 的 combo 行、supplier: scope 的 maintenance_config 行 —— 它们变成**唯一
  的价钱来源**。
- `price_valid_from/to` 休眠列：留着给 Phase 2 供应商价历史用（或正式改为历史表）。

**新增**：**绑定缺口报表**（每公司一份，只读）—— 列出没有供应商绑定、因而派生空价的
上架 SKU（今天 C1 343、C2 49），让老板去补供应商绑定。做成脚本 +
`workflow_dispatch`（R87，别让老板自己跑 SQL）。

## 8. 两家公司

全程两家公司都适用。所有表都带 `company_id`，派生、backfill、缺口报表都必须
按 `company_id` scope（R105：service-role 绕过 RLS，谓词是唯一隔离）。公司 2 多供应
商差价比例更高（66/68），受影响更明显。

## 9. 工作量估计 + 分阶段上线（R24，已按老板决定重排）

| 阶段 | 内容 | 状态 | 风险 | 估时 |
|---|---|---|---|---|
| 1 | 绑定缺口报表（每公司只读脚本，走现有 runner，无新 workflow）。 | **DONE** PR #4012 已合并+部署 | 极低 | — |
| 2 | 派生纯函数（whole-set max supplier，含 sofa 反向 matrix）+ 9 单元测试。inert。 | **DONE** PR #4013 inert | 极低 | — |
| 1b | 价格冲突报表（每公司列出供应商价钱不一致的 SKU / 沙发 combo，附各供应商值）。只读。 | 本 PR | 极低（只读） | 0.5 天 |
| 2b | **纯后端**：绑定写入（create/patch/bulk/delete/set-main）后重算受影响 SKU 的派生成本写回 `mfg_products`，替代 `is_cost_anchor` 镜像；`scm.app_config` 旗标默认 OFF（inert）；一次性 backfill（DRY-RUN→apply）。**不动任何前端**。per-SKU 重算 + R43 前后计时。 | 待做 | 中（money，独立 CI PR） | 2–3 天 |
| 3（效期）| 供应商价效期：`supplier_binding_price_history`（valid-from + 旧值留存），派生按日期 as-of；派生变动写入产品成本历史（仿现有 `mfg_product_price_history`）供 SO 重算按订单日期取当时成本。**较大件**（生产 `price_valid_from/to` 今天全空）。 | 待做 | 中 | 3–4 天 |
| 4（重价）| 一次性生产重价：先出前后 diff（多少 SKU 变、变多少、最大变动、每公司），**STOP 等老板 go**，才写。 | 待做（老板 gated）| 高 | 1 天 + 等 |
| 5（combo/special）| 沙发 combo master + special（腿/高度/gap/布料）同样 whole-set max 自动派生。 | 待做 | 中 | 1–2 天 |

已完成阶段 1、2；剩余约 7–10 个工作日，每个独立 PR、先验证再下一个（R25），第 2b/3/5
是 money-critical 各自独立 CI 验证，第 4 步的实际重价永远等老板 go。

## 10. 开放问题 —— 老板已拍板（2026-09-16）

1. ~~「最贵」定义~~ → **整套拿最贵供应商**（whole-set），已定。matrix 用「最贵格」选
   出哪个供应商胜出（报表口径同）。
2. ~~按哪个日期算~~ → **效期 IN SCOPE**（阶段 3）：供应商价带 valid-from、旧值留存，
   派生按日期 as-of。
3. ~~利润口径~~ → **已确认**：SO 阶段 = 产品维护派生成本（预算），已出货 = 实际 FIFO
   `ship_cost_sen`（不动）。这就是预算 vs 实际的分段视图。

**仍需留意（不是拍板，是设计约束）**：SO 阶段成本是**保存时的快照**（`total_cost_sen`
在 SO save/recompute 写入），不是实时算。所以派生价变动只对**之后被重算的订单**生效；
已保存的开口单要刷新预算成本需触发重算（阶段 3 效期设计里，重算按订单日期 as-of 取当
时派生成本，历史数字不动）。是否要对现有开口单做一次重算 sweep，是一个独立的小决定。

---

## 附：证据（identifiers，R12）

**表 / 列**：`scm.supplier_material_bindings`（supplier_sku, unit_price_sen,
price_matrix, is_main_supplier, is_cost_anchor, price_valid_from/to）；
`scm.mfg_products`（base_price_sen, price1_sen, seat_height_prices, sell_price_sen）；
`scm.mfg_product_price_history`（售价历史，已上线）；`scm.maintenance_config_history`
（scope master|supplier:<id>）；`scm.sofa_combo_pricing`（supplier_id null=master）；
`scm.sofa_combo_anchor`（mig 0283）；`scm.master_price_history`（audit-only，无 resolver）。

**代码**：
- 供应商价读取（chunk/page/order）：`backend/src/scm/lib/supplier-bindings.ts`。
- PO 成本从供应商派生：`backend/src/scm/lib/po-pricing.ts::deriveMfgPoUnitCost`。
- 成本锚定镜像（要反转）：`backend/src/scm/lib/cost-anchor-sync.ts`
  (`bindingToProductPatch` / `productToBindingPatch`)，触发点
  `routes/mfg-products.ts::syncAnchorBindingFromProduct`（product→binding）和
  `routes/suppliers.ts`（binding→product，`is_cost_anchor` 分支）。
- 绑定 / supplier_sku 管理：`backend/src/scm/routes/suppliers.ts`（BINDING_COLS,
  create/bulk/patch, set-main, set-cost-anchor）。
- supplier_sku 供 PO/AutoCount：`backend/src/scm/lib/po-line-supplier-sku.ts`。
- 成本基准读取（产品价 → SO 成本/毛利）：`backend/src/scm/shared/mfg-pricing.ts::
  computeMfgLineCost`（`computeMfgLinePrice` 售价那半故意不读）。
- 沙发 combo：`backend/src/scm/routes/sofa-combos.ts`,
  `shared/sofa-combo-pricing.ts`, `shared/sofa-build.ts`（`docs/modules/combo-pricing.md`）。
- special/腿/高度：`backend/src/scm/lib/po-pricing.ts::loadConfigForScope /
  resolveMaintenanceConfigForSupplier`。
- 售价历史 resolver（成本这半可仿）：`backend/src/scm/lib/product-pricing-history.ts`；
  设计文 `docs/pricing-effective-dating-design.md`（Phase 2 供应商价历史尚未实现）。
- DO 出货抓价 / Sales Report：`docs/modules/delivery-order.md`（unit_price_sen /
  unit_cost_sen / ship_cost_sen 三列语义，restampDoActualCost, mig 0143）；
  `backend/src/scm/lib/fair-report.ts`（DO 阶段 cost = ship_cost_sen ?? unit_cost_sen）。

**生产查询**（项目 anogrigyjbduyzclzjgn，2026-09-16，只读 Supabase MCP）：见第 3 节表；
关键值 —— is_cost_anchor 全系统 1 行；绑定缺口 C1 343 / C2 49；多供应商 flat 差价
C1 43 / C2 66；price_valid_from/to 0 行。
