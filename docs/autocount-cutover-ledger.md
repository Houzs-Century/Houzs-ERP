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

**状态截止:2026-08-10 13:53 UTC**(上一版截止 05:00,§2 W1~W8 是那一版写的,原样保留)。
05:00 之后又走了十波,全部记在 **§2B W9~W18**;当天 owner 定下来的六件事记在 **§9**。
要看现状就跑 §7 的只读工具;**不要改这份文件里的历史行**,历史行是账本,不是仪表盘。

> **2026-08-10 收盘时那句「还没跑完」已经不成立了。** §2 W7 / §5 #1 写的「SO-linked PO 半截」
> 当天 05:41 ~ 08:42 补完了(§2 W9),不要照着旧那一行去「补跑」。旧行留着是因为它记录了
> 当时的真实状态,**不是因为它现在还对**。

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
| W9 | SO-linked PO 回滚 + 补完(W7 的收尾) | 否 |
| W10 | AutoCount GR / PI 单号盖到 PO 上 | 否(只写两个 text 栏) |
| W11 | 导入 SO 行补 `warehouse_id` | 否 |
| W12 | allocation 重算(终于 commit 了) | 否(改的是 SO 行状态,不是库存) |
| W13 | **迁移 GR 291 张 + DO 25 张** | **否 —— 刻意的,见 §3 (4)** |
| **W14** | **余额导入 re-run(沙发排除改按 category)** | **是 —— 全篇第三次,+205 units** |
| W15 | 沙发照片去重 | 否 |
| W16 | 迁移单据编号回归 AutoCount | 否(只改 `doc_no` / `po_number`) |
| W17 | bedframe 解析修正 + variants 重解析 | 否 |
| W18 | 迁移 PO 的单头交期从自己的明细补回来 | 否(只写单头一个日期栏) |

> **上面那句「动库存的只有两波」在 2026-08-10 11:30 之后不再成立。** 第三波是 **W14**,
> `AMN-SOFA PILLOW` / `THL-SOFA PILLOW` 的 **205 units**。W4/W5 那两行不改(它记录的是
> 当时的事实),但**今天起对总数请用「9,679 + 205 = 9,884 units」**,并且这三波全部带
> `source_doc_type = 'AC_CUTOVER'` 签名,§1 第 5 条的谓词照样认得出来。

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

**2026-08-11 修正:这句提示语在 SCM 以外的路径上显示不出来。**
后端只把它放在 `reason` 字段里。`vendor/scm/lib/authed-fetch.ts` 读 `reason`,
所以**所有 SCM 单据页面一直是对的**;但 `frontend/src/api/client.ts` 的 `humanHttpMessage`
只读 `error` / `message` / `detail`,掉回通用 503 文案
*"The service is briefly unavailable. Please try again in a moment."* ——
一个**停机**文案配一个**业务决定**,而且那句话正是 `isColdPool503` 匹配的字串,
所以那条路径上每按一次会再静悄悄重发 4 次。今天走这条路径的 `/api/scm` 写只有一处
(`pages/Team.tsx:3243` showroom parking),但它是非 vendor 代码的默认 client。
另外一个**确实会打到 SCM 主路径**的坑:两个 client 都会丢弃 ≥200 字符的服务器句子并掉回通用 5xx 文案,
而这句提示语是 operator 在 `app_config.description` 里手打的。
修复(`fix/freeze-message-not-outage`):后端 `message` 和 `reason` 同时带这句话,
并在服务端把 operator 自定义提示语限制在 200 字符以内。

表由 `migrations-pg/0272_scm_app_config.sql` 建,seed 是 `'off'` ——
**开闸永远是一个明确的动作,不会是跑 migration 的副作用。**

> 一年后如果有人发现 2026-08-09 / 08-10 这两天 company 1 几乎没有人工单据 ——
> **原因是这个闸门,不是那两天没生意。**

---

## 2B. 2026-08-10 05:00 之后的十波(W9 ~ W18)

上一版写到 05:00 就停了。下面是同一天剩下的十波,按时间排。
**每个数字都是从该 run 的 `##[notice]` 抄回来的**,抄错比不写更糟。

### W9 — SO-linked PO:回滚沙发那一截,然后补完 (05:38 ~ 08:42 UTC)

§2 W7 停在「约 181 张,半截」。当天先**回滚再重导**,原因不是数据错,是**形状错**:
沙发行被整只写进 PO,而 SO 那边早就拆成 compartment,整只行永远认领不到 compartment 行,
于是整套沙发不管收了多少货都卡在 `PENDING`(PR #1832)。

| run (UTC) | 做什么 | 结果 |
|---|---|---|
| 31359253217 (05:38) | 回滚 **DRY-RUN**,只针对带沙发行的 PO | 该 importer 写过 **181** 张 PO(274 行,其中 46 张带沙发行);**安全检查:引用这些 PO 的 GRN 行 = 0**;在范围内 46 PO / 68 行 / 49 沙发行 / 释放 26 条 SO dedication / 110 units 的纸面收货 |
| 31359310298 (05:39) | 回滚 APPLY | 同上范围 |
| 31359369768 (05:41) | 重导 APPLY | 档案 366 张;已在 ERP **267**;**新建 99 张 PO / 197 行 / 192 条 dedication**;沙发解码 44 拆件 + 6 占位(**从不猜**);unresolved → SO line 5 |
| 31369349553 (08:16) | 再跑一次 APPLY | 366 / 366 已存在,**建 0** —— 幂等自证 |
| 31371138883 (08:40) | 换成 378 张那版档案后 APPLY | 已在 ERP 335;**新建 43 张 PO / 73 行 / 17 条 dedication**;沙发解码 8 拆件 + 3 占位 |
| 31371247041 (08:42) | 收尾 APPLY | 378 / 378,**建 0** —— **W7 到此结束** |

那 43 张不是导入失败,是**档案过期**:原档从 outstanding SO 的快照生成,快照之后才开的 PO
根本没进过 importer 的输入(PR #1845)。importer 老老实实报 `to create: 0`,它没错,它的输入错。

每一个 APPLY 的最后一行都是 `no inventory movements written — by design.`

### W10 — AutoCount 的 GR / PI 单号盖到 PO 上 (07:34 / 13:11 UTC)

`stamp-ac-grn-refs.mjs` / **31366394712**(07:34)+ **31391653643**(13:11),两次都 APPLY。

| run | 快照规模 | 已导入 PO | 盖了几张 | AutoCount 有收货但没导进来的 |
|---|---|---|---|---|
| 31366394712 | 683 行 / 241 PO / 150 GR / 127 PI | 406 | **241** | **0** |
| 31391653643 | **82,451 行 / 8,920 PO / 4,939 GR / 4,589 PI** | 449 | **48** | **8,631** |

第二次换成了全量 `ac-gr-refs.json.gz`,所以「没导进来的 8,631 张」不是问题,
**那正是 §9 决定一(历史单据不导)在报表上的样子**。

两次的最后一行都是:`No GRN was created and no stock moved — by design.`
**这一波只写了两个 text 栏(GR / PI 单号),没有建任何单据。**

### W11 — 导入的 SO 行补 `warehouse_id`:整个割接卡住的那一颗螺丝 (09:09 ~ 09:13 UTC)

上一版 §5 #13 记的就是这件事:**导入的 SO 行一条都没有 `warehouse_id`。**
库存按 `(warehouse_id, product_code, variant_key)` 分桶,null 就永远配不到货 ——
**不是沙发的问题,是所有导入行的问题。**

| run (UTC) | 结果 |
|---|---|
| 31373317579 (09:09) DRY-RUN `GROUP=all` | 缺 warehouse 的导入 SO 行:**13,885**;`unresolved location: 0` |
| 31373582517 (09:13) **APPLY** `GROUP=all` | **13,885 行拿到 warehouse**。KL→KL WAREHOUSE **9,434** / PG→PG WAREHOUSE **3,506** / SRW→SRW WAREHOUSE **722** / SBH→SBH WAREHOUSE **223** |

按 item_group 拆(dry-run 全表,APPLY 的数一样):

| item_group | KL | PG | SBH | SRW |
|---|---|---|---|---|
| accessory | 4,498 | 1,629 | 90 | 319 |
| bedframe | 1,641 | 602 | 38 | 100 |
| mattress | 2,317 | 875 | 56 | 184 |
| service | 275 | 95 | 39 | 119 |
| sofa | 687 | 296 | — | — |
| others | 16 | 9 | — | — |

> **数字更正。** 上一版 §5 #13 写的是 **13,881**,依据是 08-10 当天早些时候的 prod 只读实测。
> workflow 的 run log 报的是 **13,885**(dry-run 与 APPLY 两次一致)。**以 run log 为准。**
> 差的 4 行最可能是两次读之间又导进来的(W9 的 08:39/08:40 重导就在中间)。旧行不改。

owner 决定的是 `GROUP=all`(全补),不是脚本默认的「只补沙发 981 行」。
**这一波不动库存**,run 自己写明:`Nothing here touches inventory; lines flip on the next allocation recompute.`

### W12 — allocation 终于 commit 了 (05:48 ~ 09:21 UTC)

`recompute-so-allocation`。**前两次根本没写进去,必须记下来:**

| run (UTC) | 结果 |
|---|---|
| 31359781959 (05:48) | `ok=false linesFlipped=0 ordersAdvanced=0 reason=ad.localeCompare is not a function` → **NOT COMMITTED** |
| 31360427455 (06:00) | **failed** |
| 31361149382 (06:13) | `ok=false ... reason=ra.localeCompare is not a function` → **NOT COMMITTED** |
| 31362161284 (06:29) | `ok=true linesFlipped=10 ordersAdvanced=1 ordersRegressed=0` |
| 31371588512 (08:46) | `ok=true linesFlipped=21 ordersAdvanced=7 ordersRegressed=0` |
| **31374177085 (09:21)** | **`ok=true linesFlipped=1181 ordersAdvanced=147 ordersRegressed=0`** |

09:21 那一次跑在 **W11 补完 warehouse 之后**,前面几次跑在之前 —— **1,181 vs 21 就是那颗螺丝的价值。**
`ordersRegressed=0` 三次都是 0:没有任何一张单被推回去。

> 前两次 `ok=false` 的 run 标题是 **success**(workflow 退出 0,因为「函数拒绝了」也是一个
> 合法答案)。**看 conclusion 会得出错误结论,要看 `canonical result:` 那一行。**

### W13 — 迁移 GR / DO 单据:有单、有量、有链接,**没有库存流水** (09:07 ~ 13:38 UTC)

`create-migrated-documents.mjs` / `create-migrated-documents.yml`,owner 当天拍板:
**"建这一个模式,GR 和 DO 一起用"**。

| run (UTC) | kind | 结果 |
|---|---|---|
| 31373160721 (09:07) | grn DRY-RUN | 有收货量的 PO **291**;already mirrored 0;要建 291(**496 行 / 822 units**) |
| 31373177003 (09:08) | grn APPLY | **failed** —— 建之前就死,没有半截数据 |
| 31373632003 (09:14) | grn **APPLY** | **`DONE. GRNs created: 291. No inventory movement written — by design.`** |
| 31379076596 (10:25) | do DRY-RUN | AutoCount 对未结单开出的送货行 275;要建 **25** 张 DO(57 行 / 68 units) |
| 31391688483 (13:12) | do APPLY | **failed**(GRN 明细表名写错,#1887) |
| 31393950819 (13:38) | do **APPLY** | **`DONE. DOs created: 25. No inventory movement written — by design.`**(**59 行 / 70 units**) |

`no ERP SO line 217` / `unmapped code 0`:AutoCount 那 275 条送货行里,有 217 条找不到对应的
ERP SO 行 —— 因为那条 SO 行本来就没导(整单已交货的行按 owner 的 DO 规则不导,§3 (2))。
run log 会**逐条印出 `MISS <单号> wanted "<品名>"` 和那张单在 ERP 里实际有哪些行**,
所以这 217 条是查得到的,不是黑洞。

**为什么是「一张 PO 一张 GRN」而不是「一张 AutoCount 收据一张 GRN」。**
AutoCount 一张收据经常横跨好几张 PO,ERP 的 GRN 只属于一张 PO。实测:碰到已导入 PO 的
AutoCount 收据 **187 张,其中 118 张同时还收了 ERP 根本没有的 PO**;`GR-000201` 一张收了
**10 张** PO,ERP 只有其中 2 张(PR #1876)。所以 **ERP 那张单的数量比同号的 AutoCount 单小是对的**,
单据备注里已经把这句话写在单子上了。

**每一行都盖了 `migrated_no_stock = true`**(migration `0276_scm_migrated_documents.sql`,
`scm.grns` 和 `scm.delivery_orders` 各一列 + partial index + column comment)。
这个 flag 的用途见 §3 (4) —— **它是写给未来那些「修复」脚本看的。**

### W14 — 余额导入 re-run:沙发排除改成按 category,捞回 205 units (11:30 UTC)

`import-ac-stock-balance.mjs` / **31383828663** APPLY

- `sofa furniture codes excluded: 85`(**按 binding CSV 第 4 栏的 category = `SOFA` 判定,不再按码里有没有 "SOFA" 这四个字母**)
- **`positive adjustments: 2 cells / +205 units (zero-cost: 2)`** → **`DONE. adjustment movements written: 2`**
- `negative deltas: 156 (report-only)`;`unmapped items: 0`;`unresolved-warehouse rows: 0`
- 紧接着 **31383837168**(同一分钟)再跑一次:**`0 cells / +0 units` / `movements written: 0`** —— 幂等自证

捞回来的就是 `AMN-SOFA PILLOW` / `THL-SOFA PILLOW`,上一版 §5 #16 那 **205 units**(KL 130 / PG 75)。
owner 原话两句都要留着:**"沙发库存不准的,因为我们接下来跑 compartment 了"**(沙发家具不导)
和 **"pillow 就ok"**(枕头是 accessory,要导)。

> **两处要留意的更正:**
> 1. **PR #1858 的正文写「排除 21 个家具码」,run log 报的是 85。以 run log 为准,真值是 85。**
>    正文那个 21 是**错的** —— 写的时候手上那份 CSV 不是跑的时候那一份。
>    **一个错数字躺在一个已合并的 PR 正文里,正是最容易变成传说的东西**:
>    它看起来有出处、可以被引用、而且永远不会有人回头改它。
>    所以这里把它点名钉住 —— **下次有人拿「#1858 说 21」来对账,请把他带回这一行。**
> 2. **负数差异从 §5 #3 的 45 个涨到 156 个。** 不是变坏了,是**基准动了**:快照停在
>    2026-08-09,而 ERP 从那之后一直在出货 / 分配。`report-only` 没变,**一个都没扣**(§3 (3))。
>    要拿它当结论前先想清楚在跟哪一天的 AutoCount 比。

### W15 — 一套沙发的照片只挂一行,不是每个 compartment 都挂 (11:41 UTC)

`prune-duplicate-sofa-photos.mjs` / **31384579900** APPLY

- **SALES ORDER**:983 条沙发行 / 470 个 build → **405 行改动,清掉 457 个重复 key**
- **PURCHASE ORDER**:198 条沙发行 / 92 个 build → **103 行改动,清掉 127 个重复 key**

一张 AutoCount 沙发行拆成 N 个 compartment 行时,照片被复制到了每一行,同一张实拍图
在单据上出现 N 次。现在照片落在 build 的**头一件**上。当天早些时候的挂载:
SO **31375710479**(09:40 APPLY,manifest 554,`lines updated: 6; keys attached: 6`,
累计已挂 982 → 988 计划)、PO **31375714432**(09:40 APPLY,manifest 190,
`lines updated: 35; keys attached: 44`)。去重是在这两次之后跑的。

### W16 — 迁移单据的编号回归 AutoCount (11:51 / 13:13 UTC)

owner 当天问了两次:**"我们从 AutoCount 搬进来的东西全部 numbering 都跟着 AutoCount 的不是吗?"**,
接着 **"要确保你从 autocount 拉进来的东西全部 numbering 都是要跟着那边的."**

SO 导入和 outstanding PO 导入本来就是这样做的;**后来加的两个 importer 不是** ——
SO-linked PO 导入和迁移 GR/DO 生成器自己续号,于是 `PO-000596` 在 ERP 里叫 `HC-PO-009844`,
**拿着 AutoCount 单据的人在 ERP 里搜不到它。**

| run (UTC) | 结果 |
|---|---|
| 31384089874 (11:34) / 31384926726 (11:45) DRY-RUN | 要改 **511**(purchase_orders **277**、grns **234**);**没有 AutoCount 收货单号可用、留在流水号上的 GRN:57** |
| **31385323665 (11:51) APPLY** | **`DONE. renamed: 511.`** |
| **31391763361 (13:13) APPLY** | **`DONE. renamed: 49.`**(grns 49);**留在流水号上的 GRN:12** |

**编号规则(记下来,别再重新发明):**

1. **`HC-` + AutoCount 的单号。** 例:`PO-000077` → `HC-PO-000077`;`GR-005177` → `HC-GR-005177`。
2. **一张 AutoCount 收据横跨多张 PO 时,ERP 的 GRN 号要再带上 PO**,因为 ERP 的 GRN 只属于一张 PO,
   光一个 GR 号不唯一。实际改出来的样子:
   `HC-GRN-000250 → HC-GR-000201-PO-000275`、`HC-GRN-000013 → HC-GR-004996-PO-009304`、
   `HC-GRN-000253 → HC-GR-000304-PO-000453`。
   **人读到的号,永远从 AutoCount 的单号起头。**
3. 脚本**拒绝任何会撞号的改名**。
4. **两个 importer 已经同步修好了,重跑不会再制造流水号。**

### W17 — bedframe 解析修正 + variants 重解析(全天)

解析器改了两轮:**#1880**(数字写在词前面、或跟前一个词黏在一起:`12”Divan`、`frontdrawerdivan12”`)
和 **#1883**(hydraulic divan 取**外高**,只写 inner 的按 **+2** 换算,见 §9 决定三)。
改完一律走 **in-place UPDATE**,单据 / 付款 / 日期原样保留(owner 2026-08-09 定的规矩)。

| run (UTC) | 脚本 | 结果 |
|---|---|---|
| 31359533731 (05:44) | `refresh-po-variants` | 362 行;有颜色 360(**新拿到 263**);真 special options 80 |
| 31371287821 (08:42) | 同上 | 406 行;有颜色 404(**新拿到 44**);specials 87 |
| 31391659611 (13:11) | `refresh-so-variants` | 导入的 bedframe 行 2,393,**重解析 2,390**;有颜色 1,048(新拿到 5);真 special options 502 |
| 31393092330 (13:28) | `refresh-po-variants` | 406 行;有颜色 405(**新拿到 1**);specials 87 |

「新拿到」一路从 263 → 44 → 1,**这就是解析器收敛的样子**;收敛到 1 才停手。

### W18 — 迁移 PO 的单头交期:一个**从来没丢过**的日期,在画面上看起来丢了 (13:53 UTC)

`backfill-po-expected-at` / **31395645232** APPLY

| | |
|---|---|
| 迁移 PO | **449** 张 |
| 单头交期是空的 | **449 张 —— 一张不漏,全空** |
| 能从自己的明细补回来 | **401** |
| 补不了,因为**明细也没有任何一行带日期** | **48** |
| **结果** | **`DONE. purchase orders given their delivery date: 401`** |

**为什么这件事值得单独记一笔。** 日期**一直都在**,在明细行上。
两个 importer 都只写了**行**上的交期,**没写单头那一栏**;而 PO 画面读的是**单头**。
于是**每一张**迁移 PO 在画面上都显示「没有交期」——
**一个从来没有丢失的数据,看起来像丢了。**

> **给一年后的人:**这类 bug 最贵的地方不是修它,是**它会让人不相信这批数据**。
> 看到 449 张 PO 全部没交期,正常反应是「导入坏了,重导吧」——
> 而重导会把已经建立的 `so_item_id` dedication 全部打散。
> **真相是:一个显示层的字段没被写,底下的数据一直是完整的。**
> 剩下那 **48** 张是真的没有日期(明细行上也没有),**不是这次没补到**。

### 同一天的沙发件修正(不是导入,是按 owner 逐条核对后的更正)

`apply-sofa-compartment-corrections.yml` / **31393696809**(13:35)APPLY,当天最后一次:

- **builds touched 22 · lines updated 38 · added 30 · removed 2**
- **downstream carried: PO lines 14 · GRN lines 14 · DO lines 0** —— 改动跟着下游单据一起走,不是只改 SO
- **`refused 0 (downstream reference or the money would move)`** —— 会动到钱的一律拒绝,不是改一半
- **2 个 HELD 留给 owner**:`HC-PO-010056 / HC-SO-012696`(照片看得出一个 corner 加三张 30" 座,
  但**件的顺序读不出来**)、`HC-PO-000162`(`5526` 必须先自己成为一个 model,
  现在 mapping 错指到 `8038`)

**读不出来就 HELD,不猜** —— 跟 `SOFA UNPARSED` 占位是同一条规矩。

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

### (4) 迁移进来的 GR 和 DO 单据,一条库存流水都没有 —— 2026-08-10 新增

**这是当天新造出来的一整类单据,也是最容易被「修好」的一类。**
W13 建了 **291 张 GRN** 和 **25 张 DO**,它们有单号、有明细、有数量、有日期、有链接,
状态是 POSTED / DELIVERED —— **背后一条 `scm.inventory_movements` 都没有。**

脚本自己在 header 里写死了(`create-migrated-documents.mjs:7-17`):

> On-hand came into the ERP once, through the AutoCount balance snapshot. That snapshot
> already counts every past receipt as IN and every past delivery as OUT. A GRN posting
> an IN here would receive the same units twice; a DO posting an OUT would ship them twice.

**判据是一列,不是猜的:`migrated_no_stock = true`**(migration `0276_scm_migrated_documents.sql`,
`scm.grns` 和 `scm.delivery_orders` 各一列,带 partial index,column comment 里写了原因)。

**给一年后的人,直白版:**

> 你如果跑一个「找出没有库存流水的已过账单据」的体检,**它会把这 316 张单全部报出来。**
> 那不是 316 个 bug,**那是 316 个刻意。** 先看 `migrated_no_stock`:
>
> ```sql
> SELECT doc_no FROM scm.grns
>  WHERE company_id = 1 AND migrated_no_stock;      -- 291 张,故意没有流水
> SELECT doc_no FROM scm.delivery_orders
>  WHERE company_id = 1 AND migrated_no_stock;      -- 25 张,故意没有流水
> ```
>
> **给它们补流水的后果:GRN 那 822 units 会被再收一次,DO 那 70 units 会被再出一次。**
> 库存和 COGS 同时错,而且**没有人会立刻发现**。
>
> 这一列存在的唯一理由,就是让「修复脚本」在动手之前有机会先问一句。**别绕过它。**

### (5) 迁移单据的下一段链路:GR → PI、DO → Invoice —— 2026-08-11 新增

Owner 2026-08-11:「那些 GR 已经 convert 成 purchase invoice 了,所以你应该要转成
purchase invoice,DO 也应该要转成 sales invoice 吧?跟着它的链路,它的
documentation relationship map 去完善调到完。」然后连着收窄了两次:
**「我说的是我们ERP 的DO to Invoice / 我们ERP的GR to PI」、「而不是全部」** ——
**转的是我们自己的单,不是把 AutoCount 的 4,789 张 PI / 9,245 张 IV 历史搬进来**
(那个 owner 早就说过「这个不要」)。

**为什么不能用画面上那颗 convert 按钮。** `POST /from-grn`、`POST /from-dos` 都在,
也都能跑 —— 现在它们**故意拒绝**迁移单据。走那条路会同时错三件事:

1. 单号会变成 `PI-YYMM-NNNN`,而不是 `HC-<AutoCount 单号>`(违反 owner 的编号规矩)
2. 会记一笔 AutoCount 早就记过的分录(`Dr 1200 / Cr 2000`、`Dr 1100 / Cr 4000`)
3. 会往 AutoCount write-back 丢一张 `gr_to_pi` / `do_to_iv` —— **在 owner 的真账套里
   多开一张发票**。`enqueueConvert` 没有它两个兄弟 (`enqueueSoCreate` /
   `enqueuePoCreate`) 的「已经在 AutoCount 里了」保护,而每一张迁移单都带
   `linked_ac_docno`,所以 `dispatchOne` 会真的解析出 `FromDocNo` 推出去

**闸门是算术,不是信任。** 迁移单是**半张**镜像 —— 25 张迁移 DO 里有 21 张的行数
比 AutoCount 那张少 —— 而且两边都没有行对行的 key(`PIDTL.FromDocDtlKey` 20,777 行里
0 行有值,`IVDTL.FromDocDtlKey` 43,522 行里 0 行有值)。两边都有的只有**发票总额**。
所以规矩是:**我们要开的金额跟 AutoCount 真的开的金额,分到分相等,才写**;不等的
**两个数一起报出来**,然后放着不动。

五条规矩在 `backend/src/scm/lib/migrated-chain.ts`,五条都有测试:

| # | 规矩 | 为什么 |
|---|---|---|
| 1 | 一张 AutoCount 发票 = 一张 ERP 发票,单号从它来 | 一张 AutoCount 发票常常横跨我们好几张单 |
| 2 | 只转 AutoCount 真的开过发票的 | **作废**的发票是**另一个答案**,不等于「没开过」,分开报 |
| 3 | 源单有重复行,拒绝,**不对半砍** | 25 张迁移 DO 里 8 张重复了 `so_item_id`;HC-DO-005452 会开成 RM 14,600.00,AutoCount 开的是 RM 7,300.00。对半砍等于猜哪一行是真的 |
| 4 | 总额必须等于 AutoCount 的 | 顺手解决了「只迁进来一半」:AutoCount 一张发票横跨四张收货、我们只迁了一张,金额永远凑不齐,就拒绝,而不是开一张少的 |
| 5 | 一张发票只能有一个对手方 | 4,789 张 AutoCount PI 里 309 张、9,245 张 IV 里 568 张横跨多张源单。合并出来的单头只能写一个 supplier / debtor,原本是**按单号排序谁在前谁赢** —— 排序不是证据 |

**2026-08-11 DRY-RUN(只读跑 production)的结果,先记下来免得以后被误读:**

```
GR → PI:   291 张源单 →  5 张会开,286 张拒绝
DO → IV:    25 张源单 →  4 张会开, 20 张拒绝
合计 9 张
```

**9 张看起来很少,那是闸门在干活,不是闸门坏了。** 225 笔「总额不等」里有 **222 笔
是我们这边 RM 0.00** —— 496 条迁移 GRN 行里 483 条没有价钱,割接把数量搬进来了、
把钱丢了。**等 AutoCount 的采购发票价钱盖回源单行,这 222 张立刻就能开。**
真正两边都有价钱、而且对不上的,只有 **3 笔**:

```
HC-GR-000069 -> PI-000680   ours RM 450.00   vs AutoCount RM 3715.00
HC-GR-000585 -> PI-001266   ours RM 5888.00  vs AutoCount RM 4943.97
HC-GR-005177 -> PI-007786   ours RM 800.00   vs AutoCount RM 20390.00
```

这 3 笔要 owner 看。**AutoCount 从来没开过发票的:43 张收货 + 3 张交货**
(HC-DO-007466、HC-DO-007525、HC-DO-008624)—— 这些**不会**凭空生一张发票出来。

**这一段不改任何成本。** 迁移 GRN 没有流水、没有 FIFO 层,`recostFromGrn` 在
`recost.ts:398` 就 return 了;开账那批层是 `source_doc_type = 'AC_CUTOVER'`,
它的 filter 永远匹配不到。**这一段补的是 relationship map,不是成本** ——
那 140 个零成本层 / 522 units 要走另外一条 lot 层的路。

> **给一年后的人:**你会看到 `scm.purchase_invoices` / `scm.sales_invoices` 上也有
> `migrated_no_stock`(migration `0280`)。跟 0276 同一个意思、同一个名字,
> **一个谓词就能捞出全系统所有割接单据**。发票本来就不动库存,所以这一列在这里管的是**钱**:
> 不记分录、不动客户余额、不进 write-back。`postPiAccounting` / `postSiRevenue`
> 是在**函数里面**读这一列的,不是在调用点 —— 所以明天新加的第五个调用者自动也守规矩。

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

### 2026-08-10 收盘时这些条目变成什么了(上面的行不改,看这一张)

| # | 收盘状态 | 证据 |
|---|---|---|
| 1 | **已关闭。** SO-linked PO 补完了,不用再「补跑」 | §2B W9:31371247041 报 `378 / 378 已存在,建 0`;`check-cutover-completeness` 31393377431 报 PO `MISSING 0` |
| 3 | **仍开着,而且数字变了:45 → 156**,依旧 report-only,**一个都没扣** | 31383828663:`negative deltas: 156 (report-only)`。基准没动(快照仍是 08-09),动的是 ERP 这一侧 |
| 4 | 仍开着。`backfill-zero-cost-lots` **到收盘为止仍然一次都没跑** | `gh api repos/hello-houzs/Houzs-ERP/actions/workflows/backfill-zero-cost-lots.yml/runs --jq .total_count` = **0** |
| 8 | **换了一个数字继续开着。** 上一版 25 条,收盘时是 **97 条**「已全收的 BOUND dedication 还不是 READY」 | `check-ac-vs-erp-reconcile` 31375330233 §2:`fully-received BOUND dedications still not READY (must be 0 after a recompute): 97` |
| 13 | **已关闭。13,885 行全部补上 warehouse**(不是 13,881,以 run log 为准) | §2B W11:31373582517 `DONE. SO lines given a warehouse: 13885` |
| 14 | **仍开着,而且是 owner 的决定,不是待办**(§9 决定二)。沙发整只库存**到收盘为止从来没有进过 ERP** | `import-ac-sofa-stock` 的 apply **一次都没有**。注意:`gh run list --workflow import-ac-sofa-stock.yml` 现在返回空,是因为这个 workflow 档案当天被 #1848 动过、Actions 的历史按**档名**算 —— **空不等于「那次 DRY-RUN 没发生」**,但 **apply 确实一次都没跑** |
| 16 | **已关闭。205 units 进来了** | §2B W14:31383828663 `positive adjustments: 2 cells / +205 units` → `movements written: 2` |

**收盘时新开的(都是当天量出来的,不是猜的):**

| # | 还开着的 | 证据 | 决策人 / 下一步 |
|---|---|---|---|
| 17 | **12 张迁移 GRN 停在流水号上,不带 AutoCount 号** —— 这是**对的**,见 §9 决定五 | `check-migrated-numbering` 31393456086:`GOODS RECEIPTS: 291 migrated; ... with NO AutoCount receipt number recorded: 12` | 无。**不要给它们编一个号** |
| 18 | 已过账 bedframe / sofa 行的 variant 还缺一些 | `check-cutover-completeness` 31393377431 §2:SO bedframe(已过账)缺 colour **7** / gap **31** / divan **8** / leg **11**;PO bedframe 缺 colour **1** / gap **26** / divan **8** / leg **9**;SO sofa(已过账)缺 seat size **22** / colour **69**,占位 **87**;PO sofa 缺 seat size **29** / colour **81**,占位 **15** | 逐条人工 |
| 19 | **2 条 SO 行的 `item_code` 在产品目录里找不到对应产品** | 同上 §3:`SO lines with no matching product: 2` | 逐条人工 |
| 20 | 160 条 PO 行没有 `so_item_id`,没有东西可以对齐 | `PO + SO completeness audit` 31377964326 §C:`unlinked PO lines: 160` | 信息项;不是每张 PO 都该有 SO |
| 21 | 沙发件修正 **2 个 HELD 留给 owner** | 31393696809:`HELD HC-PO-010056 / HC-SO-012696`(件的顺序读不出来)、`HELD HC-PO-000162`(`5526` 要先自己成为 model) | **owner** |
| 22 | 库存余额跟 AutoCount 比,**505 项里 34 项对不上** | `check-ac-vs-erp-reconcile` 31375330233 §3:`items compared: 505; MATCHING exactly: 471; differing: 34` | 跟 #3 是同一件事的两个面 |
| 23 | **write freeze(#12)在 07:51 开过一分钟,07:52 又关回去。收盘时仍是「冻着」** | 31367561664 (07:51):`DONE. value=off -> OPEN for every company`;31367667779 (07:52):`DONE. value=1 -> FROZEN for company 1 only (others trade normally)` | **owner** 决定什么时候真正开闸。**闸门生效有 ~30s 的 middleware cache TTL**,那一分钟里 company 1 是可以写的 |
| 24 | **48 张迁移 PO 到收盘仍然没有交期** —— 明细行上也没有,**不是补漏了** | 31395645232:`still blank because no LINE carries a date either: 48`(另外 401 张已补,§2B W18) | AutoCount 那边本来就没写。要填只能人工问供应商 |

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
| `ac-gr-refs.json.gz` | **AutoCount 全量收货索引**:`PoNo / PoDtlKey / ItemCode / GrNo / GrDate / GrQty / PiNo / PiDate`。第一版只有碰到已导入 PO 的 683 行,收盘那版是全量 | **82,451 行 / 8,920 PO / 4,939 GR / 4,589 PI** | 2026-08-10 | `stamp-ac-grn-refs`(§2B W10) |
| `ac-outstanding-now.json.gz` | **从 live AutoCount 当场读出来的「现在什么还没结」的单号清单**,只有单号,没有明细。completeness check 就是拿它当标尺 | `so` **2,710** / `po` **157** / `so_linked_po` **378** | 2026-08-10 (#1843/#1845) | `check-cutover-completeness` |
| `ac-partial-dos.json.gz` | AutoCount **对仍然未结的单**已经开出去的送货明细(`DoNo/DoDate/SoNo/DoDtlKey/SoDtlKey/ItemCode/Qty/Location`) | **275 行**(59 张 DO / 50 张 SO / 405 units) | 2026-08-10 (#1850) | `create-migrated-documents`(DO 那一半) |
| `ac-po-photo-manifest.json.gz` | PO 侧 Further Description 里抽出来的实拍图清单(SO 侧那张的对应物) | **190 行** | 2026-08-10 | `import-po-line-photos` |

> **`ac-outstanding-now.json.gz` 跟别的档案不是同一种东西。** 别的档案是「要写进 ERP 的料」,
> 这一张是**尺**:它只记 AutoCount 在**导出的那一刻**说了什么。
> 上一版 §2B W9 里那 43 张「凭空冒出来的 PO」,病根就是拿旧尺量新世界 ——
> 量出 `MISSING 0` 只代表「跟这把尺一致」,**要更新的答案就先重新导出这把尺**
> (`scratchpad/export-outstanding-now.py`)。

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

### 2026-08-10 之后,先跑这四个(全部只读,一次跑完就知道割接现在长什么样)

| workflow | 它回答的**一个**问题 |
|---|---|
| **`check-cutover-completeness.yml`**(Cutover completeness check) | **AutoCount 现在还没结的单,是不是每一张都在 ERP 里?**——外加每条 bedframe / sofa 行的 variant 齐不齐。它拿 `ac-outstanding-now.json.gz` 当标尺,所以答案的新鲜度 = 那张档案的新鲜度 |
| **`check-migrated-numbering.yml`**(Migrated numbering check) | **每一张搬进来的单,是不是都带着 AutoCount 的号?**SO / PO / DO / GRN 四类各报一行,最后给一句 VERDICT。**AutoCount 本来就没记收货单号的那 12 张 GRN 会被单独列出来,那是对的**(§9 决定五) |
| **`check-ac-vs-erp-reconcile.yml`**(AC vs ERP reconcile) | **AutoCount 跟 ERP 现在差多少?**三段:PO↔SO dedication、库存状态(含「已全收却还不是 READY」那个必须归零的数)、库存余额逐项比对 |
| **`so-source-trace-check.yml`**(SO source trace check) | **每一条 READY / SHIPPED / DELIVERED 的行,追不追得回它的来源 PO?**已交货的走 consumption → lot → batch 那条链。`recompute-so-allocation` 的 run log 里那个 `ready-no-open-lots` 镜头,量的就是这个东西 |

**第五个,写这份文件的时候还在路上:**

| workflow | 它回答的**一个**问题 |
|---|---|
| **`check-line-supply-trace.yml`**(PR **#1861**) | **每一条还没 ready 的 SO 行,在等哪一张 PO、那张 PO 几时到?**owner 2026-08-10 原话:*"不 ready 的是什么 PO、几时到?然后我出 DO 的时候,要能看得到对应的是什么 PO。这些信息都要准确."* 报告把 **BOUND**(bedframe / sofa,靠 `purchase_order_items.so_item_id` 的硬链接,PO 的 `delivery_date` 就是 ETA)跟 **POOLED**(mattress / accessories,没有 dedication,得等 lot 被消耗才答得出「哪张 PO」)**分开讲** —— 分清楚这两者正是这份报告的重点 |

> **状态要说准:写这一行的时候 PR #1861 还是 OPEN,没有合并。**
> 也就是说 `main` 的 `.github/workflows/` 里**还没有**这个档案,
> 你 checkout `main` 之后 `gh run list --workflow check-line-supply-trace.yml` 会是空的。
> **合并之后它就是上面那四个的第五个**;在那之前,别把「找不到」当成「不存在」。
>
> **会被误记成它的两个邻居:** **`so-source-trace-check.yml`**(上面第四个)和
> **`check-po-so-completeness.yml`**(PO + SO completeness audit —— 每条沙发 PO 行 +
> 已过账 SO 行的规格完整度,加 SO→PO 对齐)。三个名字都带 "trace" 或 "completeness",
> **问的却是三件不同的事**,别互相代用。

**跑完怎么读:** 报告在 run log 的 `##[notice]` 行里,`gh run view <id> --log | grep '##\[notice\]'`。
**只读检查一律 exit 0** —— 红了代表检查自己坏了,不代表答案是坏的;**答案就是输出本身。**

> **`conclusion: success` 不等于「写进去了」。** §2B W12 里有两个 run 是 success,
> 但 `canonical result: ok=false` + `NOT COMMITTED`。**读结论要读 notice,不要读徽章。**

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
7. **`migrated_no_stock = true` 的单据永远不补库存流水。**(§3 (4))
   291 张 GRN + 25 张 DO,任何「找出没有流水的已过账单据」的体检都会报它们 ——
   **报出来是对的,补上去是错的。**
8. **搬进来的东西一律跟 AutoCount 的号。**(§9 决定五)
   看到一张单的号跟 AutoCount 对不上,那是 bug;看到 12 张 GRN 停在流水号上,那不是。

---

## 9. owner 在 2026-08-10 定下来的六件事

这一节存在的理由就是文件开头那句话。**六个决定,每一个都改变了「系统里有什么」,
而且每一个都可能在一年后被当成 bug 修掉。** 原话原样保留,不改写。

---

### 决定一:历史单据**不导**。ERP 里只有「还没结的那一截」

owner 原话:**"这个不要"**。

**AutoCount 里有的(整个 book 的规模):**

**量过的,不是估的。** 2026-08-10 直接连 live `AED_HOUZS` 数出来的,每张单别一句:

```sql
SELECT COUNT(*) FROM <TABLE> WHERE Cancelled = 'F'
```

| 代号 | 单别 | AutoCount 里有多少 |
|---|---|---|
| SO | Sales Order | **13,010** |
| DO | Delivery Order | **11,134** |
| IV | Sales Invoice | **9,783** |
| CN | Credit Note | **4** |
| DN | Debit Note | **0** |
| PO | Purchase Order | **9,080** |
| GR | Goods Received | **5,179** |
| PI | Purchase Invoice | **5,120** |
| PR | Purchase Return | **4** |
| QT | Quotation | **3** |
| CS | Cash Sales | **0** |

同一次读出来的主档:**Debtor 32 / Creditor 108 / Item 1,561 / ItemUOM 1,566**。
(Item 那个 1,561 跟 `autocount-erp-mapping-1561.csv` 的行数**正好对上** —— 那张翻译表是全量的。)

真正进 ERP 的那一小片:**outstanding SO 2,710**;对这些 outstanding SO 开出去的
**DO 59 张**,其中 **25 张**在 ERP 里找得到对应的行,变成了 W13 的迁移 DO。

**ERP 里有的:**

| 单别 | ERP 里有多少 | 是什么 |
|---|---|---|
| Sales Order | **2,710** 张(migrated 计 2,723) | 只有 outstanding —— **还没转成 DO 的那些** |
| Purchase Order | **407** 张(migrated 计 449) | outstanding 157 + 从 outstanding SO 开出去的 378 |
| Goods Receipt | **291** 张 | 只有 W13 建的迁移 GRN,**且不动库存** |
| Delivery Order | **25** 张 | 只有 W13 建的迁移 DO,**且不动库存** |
| Invoice / Purchase Invoice | **0 张** | **完全没导。发票留在 AutoCount** |

> **给一年后的人:**你在 ERP 里查 2026-08 之前的 Houzs Century,会看到一个**巨大的洞** ——
> 一万三千张 SO 只剩两千七,一万一千张 DO 只剩二十五,发票一张都没有。
>
> **那不是数据丢失,那是 owner 说「这个不要」。**
>
> 历史留在 AutoCount,ERP 从「还没做完的生意」接手。要查历史,去 AutoCount 查,
> **不要试图把它补进 ERP** —— 补进来的每一张已交货 DO 都会再出一次货(§3 (4) 同理)。

**证据链的诚实说明 —— 这一段请连着上表一起读。**

上面那张表**没有 run id 可以指**,因为它不是 workflow 跑出来的:是 2026-08-10 经
**ZeroTier 的 SQL 链路直接读 live `AED_HOUZS`** 数出来的。查询就写在表上面,
**所以它是可以重跑的,只是不能从 Actions 的历史里翻出来。** 这两件事不一样,别混:
「没有 run id」≠「没有证据」,但也**确实**代表**你不能靠这个 repo 自证它** ——
要复核就得再连一次那条链路。

能在这个 repo 里自证的部分,已经跟它对上了,而且是三条独立的路:

| 表上的数 | repo 里能自证的对照 | 关系 |
|---|---|---|
| SO 13,010 | **PR #1846** 在 live AutoCount 上逐条筛的结果:header 13,015 → 未取消 **13,010** → outstanding **2,710** | **完全一致** |
| outstanding SO 2,710 | `ac-outstanding-now.json.gz` 的 `so` 栏 = **2,710** | **完全一致** |
| PO 9,080 / GR 5,179 / PI 5,120 | `ac-gr-refs.json.gz`(全量收货索引)报 **8,920 PO / 4,939 GR / 4,589 PI** | **每一项都 ≤ 总数,方向对**。索引是**按 PO 串起来的**,所以本来就装不下「没连 PO 的 GR/PI」和「从没收过货的 PO」;差的 160 / 240 / 531 正是那三类 |
| DO 59 张(对 outstanding SO 开的) | `ac-partial-dos.json.gz` 自己数:**275 行 / 59 张 DO / 50 张 SO / 405 units** | **完全一致**(PR #1850 正文的数字也是这个) |

> **一个数字要更正:**交办口径里那 59 张 DO 写成了 **61**。
> **档案自己数出来是 59**(`ac-partial-dos.json.gz`,distinct `DoNo`),PR #1850 正文写的也是 59。
> **以档案为准,记 59。**(其中 25 张成为迁移 DO,这个数字是 run 31393950819 的 `DOs created: 25`。)

---

### 决定二:整只沙发的库存**不导**;沙发**枕头**要导

owner 原话:**"沙发库存不准的 因为我们接下来跑compartment了"**,以及 **"pillow 就ok"**。

**为什么不导。** AutoCount 把一套沙发当 **1 个单位**数,ERP 按 **compartment** 数。
一只变四件,那个「1」没有办法在不凭空发明的前提下拆成四件的在手数 —— 而且 owner 自己
就不信那个数。所以:**`scm.inventory_lots` 里没有任何 `AC-BAL-SOFA-*`,一只沙发的开账库存都没有。**

**枕头不是沙发。** `AMN-SOFA PILLOW` / `THL-SOFA PILLOW` 是普通 accessory,没有 compartment。
原本的 `/SOFA/i` 正则**按拼写**判断,把这 **205 units** 真实可数的货一起扔了。
现在改成**按 binding CSV 的 category 栏**(`SOFA` = 家具,`ACC` = 配件),
W14 把这 205 units 放了进来。

> **给一年后的人:**看到有人说「沙发库存对不上,要补一批开账」——
> **先分清楚他说的是家具还是枕头。**
> - **家具**:本来就没有,而且是 owner 决定不要的。补 = 发明库存。
> - **枕头**:2026-08-10 11:30 已经补了 205 units,再补一次 = 重复入账。
>
> 判断只看一条:`scm.inventory_lots` 里有没有 `source_doc_no = 'AC-BAL-SOFA-*'`。
> **没有 = 家具那一块从来没做过,而且不该做。**

---

### 决定三:hydraulic divan 报的是**外高**;只写了 inner 的,**+2** 才是总高

owner 原话两句:**"我们就以12“ 14” 16“ divan 就可以了"**、
**"inner的话就是inner+2 就是total了"**。

一条 AutoCount 的 bedframe 备注里经常同时躺着**两个数**,分清楚它们就是这件事的全部:
外面那个箱体高度(工厂做的 divan),和里面的储物深度(inner)。写法长这样:
`Col:X(hydraulic 16”/ Inner 14”)`。

规则,写在 `backend/scripts/lib/parse-bedframe.mjs:46-70`:

1. **写了外高就用外高**(`DIVAN:` 上的数,或 `HYDRAULIC` 那个词上的数)。
2. **只有 inner,就 `inner + 2`。**(`:67` —— `if (o.divan == null && inner != null) o.divan = inner + 2;`)
3. 那个「外高」其实是 inner 写的(`Div:HydraulicInner(10")`),**一样 +2**。
4. hydraulic 一般没脚,**但备注里明写了脚就不许默认成 0** ——
   `DIVAN:10'INCH 1'INCH LEG/HYDRAULIC` 里那个 1" 是销售真的写下来的。

> 脚本注释里记了一句值得留着的话:**数据跟 owner 说的完全一致,没有例外** ——
> 每一条同时写了两个数的行,读出来都是 `hydraulic 16”/Inner 14”` 这个形状。
> 换句话说 **+2 不是一个近似,是这批数据里的恒等式。**

改完走 §2B W17 的 in-place UPDATE 重解析(31391659611 / 31393092330),**不重导单据**。

---

### 决定四:迁移进来的 GR 和 DO,**故意没有库存流水**

owner 原话:**"建这一个模式,GR 和 DO 一起用"** —— 一个模式,两种单据都用它。

**完整的理由和后果写在 §3 (4),那里是全篇最要紧的一段之一,这里只重复结论:**

> **291 张 GRN + 25 张 DO,背后一条 `inventory_movements` 都没有,而且必须一直没有。**
> 给它们补流水 = GRN 那 **822 units** 再收一次、DO 那 **70 units** 再出一次。
> **库存和 COGS 同时错,而且没有人会立刻发现。**
>
> 判据是 `migrated_no_stock = true`(migration 0276),不是猜。

---

### 决定五:**12 张迁移 GRN 保留流水号**,因为 AutoCount 那边根本没有这张收货单

owner 的规矩是 **"要确保你从 autocount 拉进来的东西全部 numbering 都是要跟着那边的"**。
W16 照做了:511 + 49 张改成了 AutoCount 的号。

**但有 12 张 GRN 改不了 —— AutoCount 对那笔收货压根没有记一张收货单号。**
处理方式是:**留在 ERP 自己的流水号上,不编一个看起来像 AutoCount 的号。**

> **给一年后的人:**`check-migrated-numbering` 每次都会把这 12 张单独报出来:
> `with NO AutoCount receipt number recorded: 12`。
>
> **那不是 12 个漏网的,那是 12 个「AutoCount 那边真的没有」。**
> **千万不要给它们编一个号** —— 编出来的号会指向一张不存在的 AutoCount 单据,
> 而**编造的证据比缺失的证据危险得多**:缺的那个,人还知道自己不知道。

(第一次 dry-run 报的是 **57** 张,那是改名之前的全量;W16 两轮做完之后剩 **12** 张。
以收盘那次 `check-migrated-numbering` 31393456086 报的 **12** 为准。)

---

### 决定六:**SO-000021** —— AutoCount 自己的单头总额跟自己的明细对不上,**照实记,不修**

| | 金额 |
|---|---|
| AutoCount 单头总额 | **9,876** |
| AutoCount 明细加总 | **10,852** |
| **差** | **976** |

明细就三行,自己算得出来(`ac-outstanding-so.json.gz`,DocKey 13554):

| ItemCode | Qty | UnitPrice | 小计 |
|---|---|---|---|
| `DL-D.ULTIMATE SANTUARY (K)` | 1 | 9,298 | 9,298 |
| `DL-ECO COMFORT LATEX PILLOW` | 2 | 598 | 1,196 |
| `DL-MP(K)` | 1 | 358 | 358 |
| | | **合计** | **10,852** |

**没有任何东西可以解释那 976:**不是四舍五入(差太大),不是税(这批单没有税),
不是折扣行(明细就这三行,没有第四行)。

**ERP 存的是明细加总(10,852)。** 理由很简单:明细是能一行一行验的,单头那个数不能。

> **给一年后的人:**有人拿 AutoCount 的 `SO-000021` 跟 ERP 的 `HC-SO-000021` 对账,
> 会发现差 976 块,然后很可能去「修」ERP。
>
> **别修。差异在 AutoCount 那一边,ERP 这边是对的。**
> 这是**记录下来的不一致,不是被改正的不一致** —— 因为我们没有权力判断
> AutoCount 那个单头总额当年是怎么变成 9,876 的,只有 owner 有。

---

## 相关文件

- `docs/modules/autocount-writeback.md` — **反方向**:割接之后 ERP 是 master,每一张单怎么写回 AutoCount(outbox + 下游锁)。跟这份账本是两件事,不要混
- `docs/sofa-import-handoff.md` — 沙发那一路的语法、开件、管线与未完事项(PR #1831)
- `docs/2990-cutover/` — 2990(company 2)的割接,跟这一份是两件事
- `docs/cutover-tally-method.md` — 对数的方法论
- `BUG-HISTORY.md` — 割接期间发现的 bug(最上面三条直接相关)
- `backend/src/db/migrations-pg/0271_scm_mfg_so_linked_ac_docno.sql`、`0272_scm_app_config.sql`
- **`backend/src/db/migrations-pg/0276_scm_migrated_documents.sql`** — `migrated_no_stock`
  那一列(§3 (4) / §9 决定四)。**这一列是唯一一个能把「故意没有流水」跟「漏了流水」分开的东西**,
  column comment 里写了后果,partial index 让它是个谓词而不是猜测
- `backend/src/db/migrations-pg/0275_scm_po_ac_grn_refs.sql` — PO 上的 AutoCount GR / PI 单号(§2B W10)
- `backend/scripts/lib/parse-bedframe.mjs` — bedframe 备注的解析规则,
  **hydraulic divan 的外高 / inner+2 就写在 `:46-70`,连 owner 的原话一起**(§9 决定三)
