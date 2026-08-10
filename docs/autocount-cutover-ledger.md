# AutoCount → ERP 割接总账 (AutoCount cutover ledger)

**这份文件为什么存在。** owner 2026-08-10 原话:

> **"最重要是你要把这些 transfer / migrate 记录全部写下来,要不然以后担心他们整个系统的数据会全部乱掉"**

一年后没有人记得哪一行是从 AutoCount 导进来的、哪一行是同事在 ERP 里自己做的。
这份文件的唯一职责,是让那件事**查得到,而不是靠记得**。

**每一条都必须能追到证据链**:脚本 → workflow → run id → run log 里的 `##[notice]` 数字。
追不到的地方,写「**找不到执行记录**」,不补一个看起来合理的数字。这份文件里已经有两处
是这样写的(§2 W1、§5 #9)——那两处正是最需要被记下来的地方。

**范围**:`company_id = 1`(Houzs Century)。2990(company 2)的割接是另一件事,
看 `docs/2990-cutover/`。

**状态截止:2026-08-10 05:00 UTC。割接还在进行中** —— SO-linked PO 那一波是半截的(§2 W7)。
要看现状就跑 §7 的只读工具;**不要改这份文件里的历史行**,历史行是账本,不是仪表盘。

---

## 1. 怎么分辨「导入的 row」和「人做的 row」

十个签名。每一个都给了可以直接贴进 SQL 的谓词(全部隐含 `company_id = 1`)。

| # | 对象 | 判定谓词 | 说明 |
|---|---|---|---|
| 1 | Sales Order 单头 | `scm.mfg_sales_orders.linked_ac_docno IS NOT NULL` | 非空 = 从那张 AutoCount SO 导进来的;值就是 AutoCount 原单号(`SO-000021`)。ERP 单号 = `'HC-' \|\| linked_ac_docno` |
| 2 | Purchase Order 单头 | `scm.purchase_orders.linked_ac_docno IS NOT NULL` | 同上。**但 `po_number` 有两种编法,见下面的坑** |
| 3 | PO 单头备注 | `scm.purchase_orders.notes LIKE 'imported from AutoCount%'` | 已收货那一波还多一句 `(already received; stock came in with the balance snapshot)` —— 这句话就是「**这张单故意没有 GRN**」的签名,见 §3 |
| 4 | 收款 | `scm.mfg_sales_order_payments WHERE method = 'imported' AND note LIKE 'imported from AutoCount%'` | 唯一可靠的「这笔钱是导入带进来的」判据。人工补录的付款**不带**这个签名 —— 删单脚本就是靠它把两者分开的 |
| 5 | 库存流水 | `scm.inventory_movements WHERE source_doc_type = 'AC_CUTOVER'` | `source_doc_no` 只有三个值:`AC-BAL-2026-08-09`(平铺开账)、`AC-BAL-RELAYER-2026-08-10`(冲掉平铺层)、`AC-BAL-LAYERS-2026-08-10`(真 FIFO 分层) |
| 6 | 库存批次 | `scm.inventory_lots WHERE source_doc_type = 'AC_CUTOVER'` | 割接开出来的 FIFO 层 |
| 7 | 导入自动建的 salesperson | `scm.staff WHERE staff_code LIKE 'ACIMP-%'` | AutoCount 有这个 agent、ERP 没有这个人,导入自动开的 **inactive** 行(23 个,run 31293581139) |
| 8 | 沙发占位行 | `scm.mfg_sales_order_items WHERE remark LIKE 'SOFA UNPARSED%'` | **故意的占位,不是 bug**。解不出件就占位 + 标原因,绝不猜。见 `docs/sofa-import-handoff.md` §5 |
| 9 | 靠名字认出来的行 | `scm.mfg_sales_order_items WHERE remark = 'name-matched from free-text'` | AutoCount 那行没有 ItemCode,靠名称 + 尺寸在 pick list 里比中的 |
| 10 | PO 行认领了哪条 SO 行 | `scm.purchase_order_items.so_item_id IS NOT NULL`(且其 PO 的 `linked_ac_docno IS NOT NULL`) | 割接给 bound-mode readiness 铺的「这批货是为这条 SO 行买的」 |

反过来一句话:**上面十条全部不成立的 row,才是同事在 ERP 里自己做出来的。**

### 两个必须先知道的坑

**坑一:`po_number` 没有统一规律,只有 `linked_ac_docno` 认得。**

- outstanding PO 那一波(§2 W3):`po_number = 'HC-' || linked_ac_docno`,例 `HC-PO-000136`
- SO-linked 已收货那一波(§2 W7):`po_number = 'HC-PO-' || 六位流水`,由脚本自己续号,
  **跟 AutoCount 的单号对不上**(`import-ac-so-linked-pos.mjs:182-187`)

两波都写 `linked_ac_docno`,所以**永远用第 2 条谓词,不要用 `po_number` 去猜来源**。

**坑二:`scm.purchase_orders.linked_ac_docno` 没有 migration。**

- `scm.mfg_sales_orders.linked_ac_docno` 是 `migrations-pg/0271_scm_mfg_so_linked_ac_docno.sql` 建的 —— 正规。
- `scm.purchase_orders.linked_ac_docno` 是 `import-ac-outstanding-po.mjs:314` 自己
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 加的。`grep -rl linked_ac_docno backend/src/db/migrations-pg/`
  只命中 0271。**你在 migration 树里找不到这一列,不代表它不存在。** 这是一个已知的记录缺口,见 §5 #2。

另外 `migrations-pg/0272_scm_app_config.sql` 建了 `scm.app_config`,割接期间的 write freeze 就存在那里(§2 W8)。

---

## 2. 每一波写了什么、什么时候、哪个脚本哪个 run

全部 `workflow_dispatch` 手动触发,**dry-run 默认**,`apply=1` 才写;删除类还要
`CONFIRM="I HAVE REVIEWED THE DRY-RUN"`。下面只列 **APPLY** 的 run(dry-run 不改数据)。
数字全部取自该 run 的 `##[notice]` 输出。

### 概览:动库存的只有两波

| 波次 | 内容 | 动库存? |
|---|---|---|
| W0 | 主数据(SKU / model / supplier) | 否 |
| W1 / W2 / W6 | Sales Order 导入(non-sofa 两轮 + sofa 一轮) | 否 |
| W3 | outstanding PO | 否 |
| **W4** | **AutoCount 余额快照开账** | **是 —— 唯一一次实物进货** |
| **W5** | **把开账重铺成真 FIFO 层** | **是 —— 但总量不变** |
| W7 | SO-linked PO(含已收货) | **否,而且是刻意的,见 §3** |
| W8 | write freeze 闸门 | 否(不是数据) |

### W0 — 主数据对齐 (2026-08-05 ~ 08-06)

| 做什么 | 脚本 | APPLY run (UTC) | 结果 |
|---|---|---|---|
| 建 SKU + supplier binding | `align-seed-skus.mjs` | 31024825851 (08-05 16:20) | products **+493**、bindings **+1221** |
| 同上,第二次 | 同上 | 31026439931 (08-05 16:41) | bindings **+296** |
| 同上,第三次 | 同上 | 31027873191 (08-05 16:59) | supplier **+1**、bindings **+10** |
| 建 product_models 并把 SKU 挂上去 | `align-link-models.mjs` | 31030235269 (08-05 17:29) | models **+144**(复用 9)、SKU linked **290** |
| 补分类 | `align-categories-cleanup.mjs` | 31000972173 (08-05 11:19) | categories **+3**(bedlines/diffuser/carpet) |
| 收尾清理 | `align-safe-cleanup.mjs` | 31066678769 (08-06 02:48) | supplier `400-H004` **+1**;名称改 **368**(203 乱码 + 165 厚度);沙发 remap bindings **+6**、删 **4** SKU + **4** model;删 `LEAVING (CUSTOMISE)` **1** SKU + model |
| 补 `size_code` | `align-backfill-size-code.mjs` | 31067936582 (08-06 03:15) | **8** |
| 补 KD/QD 尺码 | `align-backfill-kd-qd.mjs` | 31069133278 (08-06 03:41) | **8** |
| 补供应商资料 | `backfill-suppliers-from-autocount.mjs` | 31088257412 (08-06 09:14) | **35 家补资料 + 1 家新增**;fill-empty-only,已有值一律不覆盖,冲突只标记(4 条) |

翻译真源:`backend/scripts/data/autocount-erp-mapping-1561.csv`(AutoCount code ↔ ERP code,1,561 行)。
**这一波全部不动库存。**

### W1 — Sales Order 第一轮 (2026-08-08),后来消失了

| APPLY run (UTC) | 结果 |
|---|---|
| 31269826435 (17:36) `LIMIT=5` | orders **5** / items **15** / payments **5** |
| 31269914326 (17:38) **cancelled**,跑了 8 分钟 | log 只剩 step 头,写了多少**没有记录**;由下一个 run 的 `already imported: 192` 反推 ≈ **187 张** |
| 31270640210 (17:55) | orders **2083** / items **11674** / payments **2056**(skipped-existing 192) |

当晚 prod 共 2,275 张。**不动库存。**

**然后这一批不见了,而且没有执行记录。** 2026-08-09 03:59 的 apply(31293581139)在**同一份
export、同一批 doc_no** 上报的是 `already imported: 0; to insert: 2275` —— 也就是说 08-08 那
2,275 张在这中间被清空了。把 2026-08-08 17:55 到 08-09 04:00 UTC 之间所有 Actions run 翻过一遍:
`delete-ac-iv-orders` / `delete-so-by-docnos` / `delete-test-so` / `restore-owner-data` 在这个时间窗
**一次都没跑**。

> **找不到执行记录。** 最可能是本机直连 prod 删的。写在这里,免得一年后有人把 08-08 那批
> 当成还在系统里,或者反过来以为系统丢过数据没人发现。

### W2 — Sales Order 第二轮,non-sofa (2026-08-09 ~ 08-10)

| APPLY run (UTC) | 结果 |
|---|---|
| 31291170262 (08-09 02:50) `DOC=SO-013152` | 单单验证,orders **1** / items **7** / payments **1** |
| 31292281117 (08-09 03:22) `DOC=SO-013152` | 同上,orders **1** |
| 31292716907 (08-09 03:34) **failed** | 死在自动建 staff 那一步(`null value in column "id" of relation "staff"`),**在写单之前**,没有半截数据 |
| 31293309818 (08-09 03:51) **failed** | 同一处,`initials` NOT NULL;同样没写 |
| 31293581139 (08-09 03:59) | orders **2275** / items **12518** / payments **2163**;顺带建 **23** 个 inactive salesperson;exceptions 37 |
| 31322122729 (08-09 15:48) | export 换成 13,786 行那版后补:orders **+202** / items **+495** / payments **+189** |
| 31348304370 (08-10 01:53) | orders **+24** / items **+154** / payments **+24** |

**不动库存。** 幂等靠 `INSERT ... ON CONFLICT (doc_no) DO NOTHING`,明细和付款只为**新插入的**单头写,所以重跑安全。

### W3 — outstanding Purchase Order (2026-08-09 ~ 08-10)

| APPLY run (UTC) | 结果 |
|---|---|
| 31304458310 (08-09 08:50) | POs **126** / lines **280**(exceptions 2:两条颜色库里没有) |
| 31322307520 (08-09 15:53) | POs **+9** / lines **+11** |
| 31355068715 (08-10 04:18) 含沙发 | POs **+37** / lines **+76** |

累计 **172 张**。`received_qty` 直接照抄 AutoCount(ordered − outstanding)。
**不动库存 —— 带着 `received_qty` 却没有 GRN,是刻意的,见 §3。**

### W4 — 实物库存开账:整个割接里唯一一次真进货 (2026-08-09 17:45 UTC)

`import-ac-stock-balance.mjs` / `import-ac-stock-balance.yml` / **run 31327230655** APPLY

- **1,020 个 cell**(product × warehouse)、**+9,679 units**,写了 **1,020 条 `ADJUSTMENT` movement**
- 数量来源:`data/ac-stock-balance.json.gz`(AutoCount `vItemBalQty` 快照)
- 成本瀑布:`UTDStockCost.AverageCost` → `ItemUOM` cost → ERP 产品成本 → 0(零成本**只报不猜**,当时 866 个 cell)
- **负数差异 45 个只报不做** —— 要 `neg=1` 才会扣,那个开关一次都没开过(§5 #3)
- 正数 delta 由 movement trigger 按给定成本开 FIFO lot

**这是整个割接里唯一一次把实物库存放进 ERP 的动作。** 记住这句话,§3 全部建立在它上面。

### W5 — 把开账重铺成真 FIFO 层 (2026-08-10 01:22 UTC)

`import-ac-stock-layers.mjs` / `import-ac-stock-layers.yml` / **run 31346929790** APPLY

- **963 个 cell** 重铺,写了 **2,261 层**;9,679 units 里 **8,611** 拿到了真实成本
- 做法:每个 cell 先写一条**负** `ADJUSTMENT` 冲掉 W4 的零成本平铺层(`AC-BAL-RELAYER-2026-08-10`),
  再按**真实收货日期 + 真实单价**写 N 条正 `ADJUSTMENT`(`AC-BAL-LAYERS-2026-08-10`),
  让 FIFO 的消耗顺序对得上物理现实
- **总量不变** —— 这一波是把同一批货重新分层,不是再进一次货
- 守卫:平铺 lot 已被消耗过的 cell 直接拒绝重铺

### W6 — 沙发 Sales Order 一轮 (2026-08-10 03:06 UTC)

`import-ac-outstanding-so.mjs` `sofa=yes` / **run 31351638468** APPLY

- orders **+450** / items **+1,289** / payments **+447**
- `SOFA decode: 442 decomposed, 89 placeholder (never guessed)`
- 一行 AutoCount 沙发 = ERP 多行(每个 compartment 一行),**价格挂头一件、其余 0 元**,单据总额跟 AutoCount 分毫不差
- 语法、开件、占位规则全部在 `docs/sofa-import-handoff.md`
- **不动库存。**

### W7 — SO-linked PO(含已收货)—— **半截,截止本文时未跑完** (2026-08-10 04:02 ~ 04:50 UTC)

| run (UTC) | 结果 |
|---|---|
| 31354265153 (04:02) DRY-RUN | 计划 196 POs / 292 lines(那时档案 294 张单) |
| 31354340916 (04:03) APPLY **failed** | `column "po_status" of relation "purchase_orders" does not exist` —— 第一条 INSERT 就死,**没写** |
| 31355278957 (04:22) APPLY **failed** | `invalid input value for enum scm.material_kind: "PRODUCT"` —— 同样**没写** |
| 31356530158 (04:46) APPLY **cancelled 在中途** | 计划 **234 POs / 353 lines**;log 停在 `..150/234`,`DONE` 那一行没出现 |

**写了多少 —— 用只读 reconcile 反推**(`check-ac-vs-erp-reconcile.yml`,`imported POs` 那一行):

| 时刻 (UTC) | run | imported POs |
|---|---|---|
| 04:23 | 31355329530 | **172**(= W3 的全部) |
| 04:46:51 | 31356564590 | **199** |
| 04:51 | 31356787188 | **353** |

→ 被取消的那个 run 实际写进去约 **181 张 PO**,剩下的没写完。

**这一波的状态 = 半截。** 脚本本身幂等(已存在的 `po_number` 会跳过),**重跑 workflow 会补完剩下的**;
但在补完之前,production 里这批 PO 是不完整的。

**这一波不动库存 —— 而且这是全篇最要命的一条,见 §3。**

### 其他波:补字段,不是新建单据

| 做什么 | 脚本 | APPLY run (UTC) | 结果 |
|---|---|---|---|
| 补 processing / delivery date | `backfill-so-dates.mjs` | 31304117373 (08-09 08:41) | 单头 **404** / 行 **2,098** |
| 同上 | 同上 | 31322311557 (08-09 15:53) | 单头 **523** / 行 **2,280** |
| 同上 | 同上 | 31349208508 (08-10 02:13) | 单头 **407** / 行 **2,173** |
| venue 文字规范 + 地址补 | `fix-imported-so-venues-address.mjs` | 31295324294 (08-09 04:47) | venue 规范化 **1,606** 单;地址补 **458** 单 |
| venue 别名归并 | `normalize-venue-aliases.mjs` | 31348076922 (08-10 01:48) | 新建 venue **2** 个;**43** 单改名 |
| bedframe variants 重解析(SO) | `refresh-so-variants.mjs` | 31348346813 (08-10 01:54) | **2,452** 行(最后一次;08-09 起共 APPLY 过 7 次) |
| bedframe variants 重解析(PO) | `refresh-po-variants.mjs` | 31316166801 (08-09 13:34) | **94** 行 |
| 成本回盖 | `restamp-imported-so-costs.mjs` | 31316793446 (08-09 13:49) | 行 **11,633** / 单头 **2,217**;**620** 行盖不上(产品本身没成本) |
| 同上 | 同上 | 31352494948 (08-10 03:24) | 行 **911** / 单头 **383** |
| 沙发行照片挂载 | `import-so-line-photos.mjs` | 31322997602 (08-09 16:08) | **138 行 / 152 个 key** —— **但 jpg 从来没上传到 R2**,缩略图是坏的(§5 #5) |
| SO 行照片补挂(jpg 已上传) | 同上 | 31358095030 (08-10 05:16) | 行 **775** / key **853**;累计 **983 / 983** |
| PO 行照片挂载(第一次) | `import-po-line-photos.mjs` | 31371394117 (08-10 08:26) | 行 **209** / key **242** |

**重解析是 UPDATE,不是重导。** owner 2026-08-09:*"为什么要清旧的SO 不能update进去用旧的"* ——
从那之后解析器改进一律走 in-place UPDATE,单据、付款、日期全部原样保留,只重算 variant 字段。

### W8 — write freeze(不是数据,是闸门)

`set-write-freeze.mjs` / `set-write-freeze.yml`

| run (UTC) | 结果 |
|---|---|
| 31352455122 (08-10 03:23) | `scm.app_config['scm.write_freeze']`: `off` → **`1`**(只冻 company 1,2990 照常做生意) |
| 31353906110 (08-10 03:54) | 换提示语,值仍是 `1` |

提示语原文:*"Editing is paused while the AutoCount data migration is completed. Please do not create
or change orders — ask IT when you need something updated."*

表由 `migrations-pg/0272_scm_app_config.sql` 建,seed 是 `'off'` ——
**开闸永远是一个明确的动作,不会是跑 migration 的副作用。**

> 一年后如果有人发现 2026-08-09 / 08-10 这两天 company 1 几乎没有人工单据 ——
> **原因是这个闸门,不是那两天没生意。**

---

## 3. 什么故意不动库存,为什么(全篇最重要的一节)

### 实物库存只进过一次

整个割接里,只有 **W4 + W5** 碰过 `scm.inventory_movements` / `scm.inventory_lots`:

- **W4** 按 AutoCount `vItemBalQty` 快照,把 1,020 个 cell、**9,679 units** 用 `ADJUSTMENT` 放进来
- **W5** 把**同一批货**重铺成 **2,261 个 FIFO 层**(先冲后放,总量不变)

除此之外,**割接里所有单据一律不动库存**。下面三条是最容易被后人「好心修好」的。

### (1) 已收货的 PO 不开 GRN —— 这是刻意的,不是漏做

`import-ac-so-linked-pos.mjs` 在自己的 header 里就写死了(`:17-21`):

> THESE DOCUMENTS DO NOT MOVE STOCK. The physical stock is already in the ERP from the
> AutoCount balance snapshot; posting a GRN for these would count the same units twice.

它只写四样东西:**PO 单头、PO 行、`received_qty`、`so_item_id`(哪一条 SO 行认领了它)**。
这四样是 **readiness 要读的纸面**,不是库存事件。脚本跑完还会自己再喊一次:
`no inventory movements written — by design.`

**为什么必须这样。** 那批货**已经在 W4 的余额快照里了**。AutoCount 的 `vItemBalQty` 是
「此刻仓库里有多少」——它**已经包含**这些 PO 收进来的货。再给这些 PO 补一张 GRN,
同一批货会被**算两次**。

**给一年后的人,直白版:**

> 你如果看到一张 PO —— `linked_ac_docno` 非空、`notes` 里写着
> `already received; stock came in with the balance snapshot`、`received_qty > 0`,
> **却没有任何 GRN** —— **那不是漏做,那是对的。不要去补那张 GRN。**
>
> 补下去的后果:那个 SKU 在那个仓的账面库存凭空多出 `received_qty` 那么多,
> FIFO 多一层假的层,之后每一次出货的 COGS 都跟着错 —— 而且**没有人会立刻发现**,
> 因为多出来的货长得跟真货一模一样。

同一条道理适用于 **W3 的 outstanding PO**:它也带 `received_qty`(已收部分),
也**没有** GRN,原因完全相同。

### (2) 已交货的单不进来 —— 不是「漏了历史数据」

owner 2026-08-10 定的 outstanding 规则,原话:

> **"outstanding 指的是还没有转成 DO"**、**"如果 convert to PO,它其实依然算作 outstanding"**
> (并特别说明 *"之前我们也有犯过这个错误"*)

写进 `import-ac-outstanding-so.mjs:344-356`:整单每一行都 `TransferedQty >= Qty` = 已交货 → **不导**;
`TransferedPOQty` **一眼都不看**,转 PO 永远不会让一张单被排除。

所以:**你在 ERP 里找不到 2026-08 之前的 Houzs Century 历史销售 —— 那是 AutoCount 的事,
不是 ERP 少了数据。**

### (2b) 沙发是「实物库存只进过一次」的唯一例外 —— 2026-08-10 补记

上面那句「实物库存只进过一次」有一个**必须写下来的例外:沙发根本没进过**。

`import-ac-stock-balance.mjs:54` 是 `!isSofa(r.ItemCode)`,`import-ac-stock-layers.mjs:50`
一样。W4 的 9,679 units / 1,020 cell **一个沙发都没有** —— 脚本头部写明「sofa held for the
sofa round」,而那一轮**没有被做出来**。

所以:

> **给一年后的人:**看到有人要「补一批沙发开账库存」——**那不是重复入账,那是补一个从来没做过的动作。**
> 判断依据只有一条:`scm.inventory_lots` 里有没有 `source_doc_no = 'AC-BAL-SOFA-*'` 的行。
> 没有 = 还没做。W4/W5 的总数(9,679 / 2,261 层)**不包含沙发**,拿它去对沙发会得出错误结论。

同一个 `/SOFA/i` 正则还顺手排掉了 **`AMN-SOFA PILLOW` 205 units**(KL 130 / PG 75)——
那是 ACCESSORY,不是沙发,没有 compartment。它缺货的原因跟沙发完全一样,但修法不一样:
把那个过滤条件收窄成「真沙发」,然后重跑余额导入(它是 delta 的,重跑只补差)。

### (3) 负数差异只报不做

W4 里有 **45 个 cell** 的 AutoCount 余额比 ERP 少。脚本**没有**去扣。
原因:扣库存要去消耗 FIFO 层、产生 COGS —— 那是真金白银的动作,不能在一次对账里顺手做掉。
要做得显式传 `neg=1`,而那个开关**一次都没开过**。这 45 个还开着(§5 #3)。

---

## 4. 事后修正过什么

| 修了什么 | 为什么 | 脚本 / APPLY run (UTC) | 结果 |
|---|---|---|---|
| **删 91 张已交货的单** | AutoCount 的 export 里仍然带着整单已转 DO 的单;在 DO 规则的守卫写进脚本之前,这 92 张被当成 outstanding 导了进来。owner 2026-08-10:*"如果不是 partially delivery 又 delivered 了全部就删掉吧"* | `remove-delivered-imported-so.mjs` / 31354773325 (08-10 04:12) | 删 **91**;**留 1 张 `HC-SO-009988`**(有下游引用,owner 定夺) |
| **删 126 张 SO→IV 的单** | owner 2026-08-09:*"这个不算outstanding"* —— 没开 DO 直接开发票 = 已完成的现金买卖 | `delete-ac-iv-orders.mjs` / 31326496649 (08-09 17:28) | 名单 129 个、ERP 里有 126、**全删**;0 张有 DO/allocation |
| 删 12 张让它重导 | 冻结之前同事改过这些单,要跟 AutoCount 重新对齐 | `delete-so-by-docnos.mjs` / 31348252013 (08-10 01:52) | 删 **12** |
| **撤 28 个错开的 recliner/power 件** | owner 2026-08-10:*"8030 8060 9058 9028 / 9050 8069 5535 都不会有电动 power 或者 recliner"* —— 开件第二批给这些型号开了 R/P 件 | `revert-sofa-recliner-skus.mjs` / 31329060843 (08-09 18:27) | 删 **28** 个 SKU(建于当天、零 SO 引用),清 **7** 个 model 的 `allowed_options` |
| 1B 改分左右 | owner:*"1B 要分"* | `fix-bench-sides.mjs` / 31329553463 (08-09 18:38) | 新铸 **2**,已存在的 **10** 个跳过 |
| 补 31 行漏拆的沙发行 | 走旧(非沙发)通道进来的沙发行没拆件 | `repair-leaked-sofa-lines.mjs` / 31354031243 (08-10 03:57) | 修 **31** 行、加 **38** 个件。**在原行上 UPDATE,不删** —— id 保住,PO allocation 不断 |
| 建 19 个缺的布料色号 | PROC 单用的颜色,库里真的没有(不是比对问题) | `add-missing-sofa-fabrics.mjs` / 31351207634 (08-10 02:57) | `fabric_library` **+6**、`fabric_colours` **+19** |
| venue 归并 | 导入带进来的是 AutoCount 时代的别名,下拉里选不到 | `fix-imported-so-venues-address.mjs` (31295324294) + `normalize-venue-aliases.mjs` (31348076922) | 文字规范 **1,606** 单 + 别名归并 **43** 单 + 新建 venue **2** 个 |

开件(compartment)本身不是修正,是导入的前置动作,一并记在这里:
`open-sofa-so-compartments.mjs` 两批 —— run 31326039191(7 个型号,mint 16)+
run 31327915810(13 个型号,mint 49、skip 4)。第二批开错的部分就是上面那 28 个。

### 另外两件不是修正、但一年后一定会被误会的事

1. **2026-08-08 那批 2,275 张单没了,而 Actions 里找不到删除记录**(§2 W1)。
2. **`SOFA UNPARSED` 占位行不是 bug**,是 owner 选的方案 A:解不出来宁可占位 + 标原因,也不猜。
   体检脚本就是靠这个签名把「占位」和「真漏拆」分开的。见 `docs/sofa-import-handoff.md` §5。

BUG-HISTORY 里跟这次割接直接相关的三条(都在文件最上面):GRN pick-PO picker 跨公司泄漏
——按那条记录的说法,go-live 把 Houzs 的 PO 从个位数抬到 135 张,才让一个早就存在的漏洞在
2990 的 picker 里显形;其后系统排查出的另外七处同类只读泄漏;以及 DIVAN ONLY 行被要求填 Gap。

---

## 5. 故意还开着的(带决策人)

| # | 还开着的 | 证据 | 决策人 / 下一步 |
|---|---|---|---|
| 1 | **W7 SO-linked PO 只写了约 181 / 234 张** | run 31356530158 cancelled,log 停在 `..150/234`;reconcile 31356787188 报 `imported POs: 353` | 执行方:**重跑 workflow 补完**(脚本幂等,已存在的跳过) |
| 2 | **`scm.purchase_orders.linked_ac_docno` 没有 migration** | 只有 `import-ac-outstanding-po.mjs:314` 的 `ALTER TABLE`;migration 树只有 0271(SO 那一列) | 补一条 migration 收口,否则新环境重建不出这一列 |
| 3 | 45 个负数库存差异没做 | run 31327230655:`negative deltas: 45 (report-only)` | **owner**:要不要扣 |
| 4 | 138 个零成本 lot / 317 units | `check-golive-readiness` 31353686328 §A | `backfill-zero-cost-lots.mjs` + workflow **写好了但一次都没跑**(`gh run list --workflow backfill-zero-cost-lots.yml` 是空的) |
| 5 | ~~照片:key 挂上了,jpg 没上传~~ **已解决 2026-08-10** | SO:983/983 key 已挂(31358095030)且 R2 里 983 个 object **逐个查过,0 缺**;PO:242 个 key 已挂(31371394117)。缩略图坏是另一回事,是 `SO_ITEM_PHOTOS_BUCKET_NAME` 没配(见 `BUG-HISTORY.md` 最上面那条),已修 | 无 —— 这一行留着,因为 `sofa-import-handoff.md` §8.1 还写着旧结论 |
| 5b | **AutoCount 里有图、但 ERP 挂不上的还剩 39 张** | 对 live `AED_HOUZS` 逐条比过:SO 端 554 行有图 / 已抽 554,其中 **18 张在已交货单上**(按 DO 规则本来就不导,正确);PO 端 190 张已抽,`import-po-line-photos` RESOLVE 报 **sofa held 36**(这些 PO 根本没导进 ERP) | 沙发 PO 补导之后重跑挂载即可(`sofa-import-handoff.md` §8.2) |
| 6 | 1 张已交货的单没删(`HC-SO-009988`) | 31354773325:`HELD BACK ... 1` | **owner** |
| 7 | 620 行的成本盖不上 | 31352494948:`product-has-no-cost 620` | 产品本身还没有厂价 |
| 8 | 25 条「PO 全收了但行还是 PENDING」 | `check-ac-vs-erp-reconcile` 31356787188 §1 | 跑一次 recompute |
| 9 | **`align-open-skus`(1,242 个 SKU)只跑过 dry-run;`align-rebind-unlinked` 一次都没跑** | 30996573461 是 `align-open-skus` 的**唯一一次** run,`MODE=dry-run`,`WILL_INSERT=1242`;`align-rebind-unlinked.yml` 无任何 run | **没有证据说明它是被 `align-seed-skus` 取代了还是漏了。别当成已做。** |
| 10 | 22 个 venue 值仍不在下拉里;17 条 processed bedframe 行 variant 不全;3 条 SP 行没尺寸 | `check-cutover-metrics` 31328189329 | 逐条人工 |
| 11 | 沙发 89 行占位 + 61 行 PO 没导 + 25 行 PROC 要人写 | `probe-sofa-import-duplicates` 31355923502:`honest placeholders 113` | 见 `sofa-import-handoff.md` §8 |
| 12 | **write freeze 还开着(company 1)** | `scm.app_config['scm.write_freeze'] = '1'`,run 31353906110 | **owner** 决定什么时候关 |
| 13 | **导入的 SO 行一条都没有 warehouse_id(13,881 / 13,881)** | 2026-08-10 prod 只读实测;`import-ac-outstanding-so.mjs` 三处算出了 `warehouseId`,`ICOLS`(:467)里**没有这一列**,只写了 `location` 文字 | 库存按 `(warehouse_id, product_code, variant_key)` 分桶,沙发更早一步:`findCoveringBatch` 见到 null warehouse 直接返回 null。**所有**导入行(不只沙发)因此永远 PENDING。修:`backfill-so-line-warehouse.mjs`(默认只补 sofa 981 行,`GROUP=all` 补全 13,881 行 = **owner 决定**);导入脚本已补上该列防复发 |
| 14 | **沙发实物库存从来没进过(见 §3 (2b))** | `import-ac-stock-balance.mjs:54` / `import-ac-stock-layers.mjs:50` 的 `isSofa` 过滤;prod 只有 20 个 open sofa lot、**0 个带 batch_no** | `import-ac-sofa-stock.mjs` 已写好,**只跑过 DRY-RUN**:97 lots / 97 units / 43 batches,45 个 build;drop = 超余额 4、占位 9。**apply 由 owner 决定** |
| 15 | 沙发 build 里 **29 个拿不到真实收货成本** | 同一次 DRY-RUN:priced 13 / 收货价互相矛盾 3 / 找不到 29(AutoCount 的沙发 PO **不写价**,121/122 行 `PODTL.UnitPrice` 为 NULL) | 不猜价、留 0;`ac-last-purchase-costs.json.gz` 覆盖 44 个沙发码,交给 #4 的 `backfill-zero-cost-lots.mjs` |
| 16 | **`AMN-SOFA PILLOW` 205 units 也不在 ERP 里** | 同一个 `/SOFA/i` 过滤(§3 (2b)) | 收窄过滤条件后重跑余额导入(delta 的,安全) |

---

## 6. 快照档案:每一个是什么的快照、什么时候拿的

`backend/scripts/data/*.json.gz` 是**只读的原件**,不要改;要换就整份换掉,并在这里加一行。
「进 repo」= git 首次提交日期,可以自己复查:
`git log --follow --format='%ad %h %s' --date=short -- backend/scripts/data/<file>`

| 档案 | 是什么的快照 | 行数 | 进 repo | 谁在用 |
|---|---|---|---|---|
| `ac-outstanding-so.json.gz` | AutoCount SO + SODTL,outstanding = **还没转 DO**(owner 的 DO 规则) | 13,703 | 2026-08-09 (#1739),最后一次换 08-10 (#1802) | `import-ac-outstanding-so`、`backfill-so-dates`、`refresh-so-variants`、`remove-delivered-imported-so` |
| `ac-so-dates.json.gz` | 同一批单的 `UDF_PDate`(processing)+ `SODTL.DeliveryDate` | 13,703 | 2026-08-09 (#1758) | `backfill-so-dates` |
| `ac-so-iv-excluded.json.gz` | 没开 DO 直接开 IV 的 SO 单号名单 | 129 | 2026-08-10 (#1780) | `delete-ac-iv-orders` |
| `ac-outstanding-po.json.gz` | AutoCount PO + PODTL,outstanding = `Qty > TransferedQty` | 338 | 2026-08-09 (#1759) | `import-ac-outstanding-po` |
| `ac-so-linked-pos.json.gz` | 从已导入 SO 开出去的 PO,**含已全部收货的**(带 `GrQty`) | 552 行 / **366 张单** | 2026-08-10 (#1823) | `import-ac-so-linked-pos` |
| `ac-stock-balance.json.gz` | AutoCount `vItemBalQty` —— **2026-08-09 那一刻**每个 item × location 的在手数 | 2,637 | 2026-08-09 (#1779) | `import-ac-stock-balance` |
| `ac-stock-layers.json.gz` | 把每个 cell 的余额拆回它真实的收货层(GRN + 直接 PI,从新往旧数到盖满):每层的 qty、真实单价、收货日期、来源单 | 2,339 | 2026-08-10 (#1797) | `import-ac-stock-layers` |
| `ac-utd-stock-cost.json.gz` | `UTDStockCost`(`AverageCost` / `UTDQty`)—— 开账成本第一顺位 | 1,356 | 2026-08-10 (#1780) | `import-ac-stock-balance` |
| `ac-item-costs.json.gz` | `ItemUOM` 的 `Cost`/`RealCost`/`RecentCost` —— 开账成本第二顺位 | 944 | 2026-08-10 (#1780) | `import-ac-stock-balance` |
| `ac-last-purchase-costs.json.gz` | 每个 item **最近一次有价**的采购发票行 | 890 | 2026-08-10 (#1823) | `backfill-zero-cost-lots`(**还没跑**) |
| `ac-photo-manifest.json.gz` | AutoCount Further Description 里抽出来的实拍图清单(档名 `SO-xxxxx__<DtlKey>_<n>.jpg`) | 551 | 2026-08-09 (#1779),08-10 换过 (#1802) | `import-so-line-photos` |
| `ac-sofa-gr-po.json.gz` | 沙发 GR 明细行 → 它的来源 PO(`GRDTL.FromDocNo`)。`ac-stock-layers` 只按 GR 记成本,这张表补上「哪张 PO」那一跳,让一个 build 能用**它自己那次收货的真实成本**定价 | 97 行 / 56 张 GR / 87 张 PO | 2026-08-10(本 PR) | `import-ac-sofa-stock` |

不是从 AutoCount 抽出来的,但同属这次割接的写入依据:

| 档案 | 作用 |
|---|---|
| `autocount-erp-mapping-1561.csv` | AutoCount item code ↔ ERP code 对照表(1,561 行)。**所有导入共用的翻译真源** |
| `align-seed-houzs-century.json` / `align-skus-houzs-century.json` / `align-models-houzs-century.json` | W0 那一波要写的 SKU / model 清单 |
| `autocount-sku-rebind-pairs.tsv` | `align-rebind-unlinked` 的配对表(该脚本**一次都没跑过**) |

---

## 7. 怎么自己重新核对(全部只读,自己跑,不要问 owner)

Actions → 手动触发,报告在 run log 的 `##[notice]` 行里
(`gh run view <id> --log | grep '##\[notice\]'`)。

| 想知道 | workflow / 脚本 |
|---|---|
| AutoCount 跟 ERP 现在差多少(单 / PO / 库存三段) | **AC vs ERP reconcile (read-only)** — `check-ac-vs-erp-reconcile.mjs` |
| 割接完成度:缺哪些单、哪些行 variant 不全、venue 对不上 | `check-cutover-metrics.yml` |
| 能不能上线:成本覆盖、零成本 lot、readiness | `check-golive-readiness.yml` |
| 沙发导入有没有重复 / 漏拆 / 误导已交货单 | `probe-sofa-import-duplicates.yml`(7 项体检) |
| 库存账本本身有没有对不上 | `inventory-integrity-check.yml` / `ledger-divergence-check.yml` / `duplicate-movements-check.yml` |
| 沙发库存缺多少、补了会有几套 SO 变 READY | `import-ac-sofa-stock.yml`(**dry-run 就是报告**:余额 vs 单据、每个被丢弃的 build 及原因、两段 projection) |
| 导入的 SO 行缺 warehouse 缺到什么程度 | `backfill-so-line-warehouse.yml`(dry-run 按 item_group × location 列全表) |

要数「有多少行是导进来的」,直接用 §1 的谓词。

---

## 8. 铁律

1. **已收货的导入 PO 永远不补 GRN。** 补一次,库存就多算一次,而且不会有人立刻发现。(§3)
2. **实物库存只从 `AC_CUTOVER` 那一批进来过一次(9,679 units / 2,261 层)。**
   任何时候有人说要「再补一批开账库存」,先回 §2 W4/W5 对总数。
3. **prod 先 dry-run,数字对得上才 apply。** 每个脚本都是 dry-run 默认;
   删除 / 铸码类还要 `CONFIRM="I HAVE REVIEWED THE DRY-RUN"`。
4. **查不到就写「找不到执行记录」。** 这份文件里每一个数字都指得出 run id;
   指不出来的地方(§2 W1 的消失、§5 #9)已经明说了。**不要为了好看补一个数。**
5. **历史行不改。** 状态变了就加新行 + 新日期。这是账本,不是仪表盘。
6. **owner 的原话就是规范。** 这份文件里的引用不要改写。

---

## 相关文件

- `docs/sofa-import-handoff.md` — 沙发那一路的语法、开件、管线与未完事项(PR #1831)
- `docs/2990-cutover/` — 2990(company 2)的割接,跟这一份是两件事
- `docs/cutover-tally-method.md` — 对数的方法论
- `BUG-HISTORY.md` — 割接期间发现的 bug(最上面三条直接相关)
- `backend/src/db/migrations-pg/0271_scm_mfg_so_linked_ac_docno.sql`、`0272_scm_app_config.sql`
