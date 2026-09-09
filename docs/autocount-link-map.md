# AutoCount ↔ Houzs ERP 整条链路地图 (the link map)

**这份文件为什么存在。** owner 2026-09-08 原话:

> **「你要确保检查整个链路 整个 autocount 和 Houzs ERP 的连接线 然后整个历史 做了什么
> 改了什么 fix 了什么等等 确保你真的清楚了 帮我一次性解决 要不然 你解决不完
> 你解决了很多次了」**

他说对了一件事:**之前每次都在修「一个症状」,没有人先把整条线画完。**
这份文件是那张图 —— 每一条线、两个方向、它搬什么、谁触发、
**上一次真的对生产跑是什么时候**、现在哪里断了。

**范围**:`company_id = 1`(Houzs Century)。
**时间**:全部写**本地时间(马来西亚 UTC+8)**。GitHub 的 run 页显示 UTC,差 8 小时。
**证据**:每一行都指得出 run id。指不出来的写「**没有执行记录**」,不补一个看起来合理的数字。

**这份文件跟 `docs/autocount-cutover-ledger.md` 的分工**:
账本(ledger)记**历史 —— 哪一波什么时候写了什么**,历史行永不修改。
这份地图记**现状 —— 现在有几条线、哪条活着、哪条断了**。
账本回答「当时做了什么」,地图回答「今天能不能用」。

---

## 0. 一句话总览(2026-09-08 13:2x 本地实测)

| | 数目 | 说明 |
|---|---|---|
| **进来的线**(AutoCount → ERP) | **6 类** | 1 条常驻(5 分钟一次),其余是割接期的一次性搬运 + 修补 |
| **出去的线**(ERP → AutoCount) | **9 个动作,只有 1 个用过** | `edit` 送出 28 笔;其余 **8 个从来没有排过一行队** |
| **量尺**(只读检查,不改数据) | **~40 个** | 其中 **37 个 workflow 从头到尾一次都没跑过**(全仓 502 个之中) |

**最重要的三句话:**

1. **进来的方向是活的。** 5 分钟一次的增量拉取,checkpoint 是当前的,今天还在进数据。
2. **出去的方向几乎是空的。** 开关是开的,但九个动作里**八个从来没有用过**;
   唯一用过的 `edit` **最后一笔是 2026-09-04**,之后四天没有任何东西送出去。
3. **挡住出去那条线的,是同一个东西:行没有 AutoCount 的号(line key)。**
   卡住的四笔全部是 `KeylessLineError`。这不是 bug,是 migration `0280` **故意**这样设计的 ——
   但它的后果没有人算过:**搬进来的单据,第一次改就会被拒绝。**

---

## 1. 整条链路长什么样

```
                    AutoCount (AED_HOUZS, 办公室主机 DESKTOP-TDH50IT)
                                      |
        +-----------------------------+------------------------------+
        |                             |                              |
   [进来 A] 常驻                 [进来 B] 快照档案              [出去] 写回
   Worker cron 5 分钟            桌面 SQL 导出 .json.gz          outbox 队列
   只搬 SO 单头                  → 割接搬运 + 修补脚本            5 分钟 drain
        |                             |                              |
        v                             v                              ^
  public.sales_orders          scm.* 正式表                    ERP 存单 → 排队
        |                             |                              |
        +-------------> Houzs ERP (Cloudflare Worker + Supabase) <----+
                                      |
                              [量尺] ~40 个只读检查
```

**三条通道,一条隧道。** 进来和出去走的是**同一条** Cloudflare tunnel
(`https://autocount.houzscentury.com` → 办公室主机 `localhost:8900`)。
主机上跑的是我们自己写的 `AcSyncService.cs`(单一 .NET 程序,驱动正版 AutoCount 2.2 SDK)。

> **不要跟另一条线搞混。** `index.ts:561` 的 `drainCommands` **不是 AutoCount**,
> 那是 Houzs ↔ **2990** 的 amendment 镜像(`scm/lib/amendment-command.ts`)。
> 名字很像,查错了会浪费半天。

---

## 2. 进来的方向(AutoCount → ERP)

### 2A. 常驻线 —— Worker 自己跑,不用人管

全部由一个开关控制:`AUTOCOUNT_SYNC_DISABLED`
(`backend/src/services/autocount.ts:290`)。生产 `wrangler.toml:24` = `"false"` = **开着**。
staging 是 `"true"` 而且 `crons = []` —— staging **永远不碰** AutoCount。

| # | 线 | 搬什么 | 触发 | 上次真的跑 | 断在哪 |
|---|---|---|---|---|---|
| 1 | `services/pull.ts` `runPull` | AutoCount **SO 单头**(23 栏)→ `public.sales_orders` | cron **5 分钟**(`index.ts:551`) | **今天 13:10** — sentinel 报 HEALTHY,checkpoint 是当前的 | ⚠️ **两个静默丢行**,见下 |
| 2 | `services/po.ts` `runPOPull` | PO **明细**(未结)→ `public.purchase_orders` | cron **每天 02:00** | 有跑 | 先 `DELETE` 再 bulk insert;已取消 / 已收完的单**永远看不到** |
| 3 | `services/po.ts` `runPODocsPull` | PO **单据层** → `public.purchase_order_docs` | cron 每天 02:00 | 有跑 | 同上的 wipe-and-reload |
| 4 | `services/doMirror.ts` | DO 单头 → `public.autocount_delivery_orders` | cron 每天 02:00 | 有跑 | `getAll` 约 70MB;`so_doc_nos` 至今是 NULL(migration `0215` 自己写明) |
| 5 | `services/acSnapshot.ts` ×2 | SO / PO **全量**(不过滤)→ `ac_snapshot_*` | cron 每天 02:00 | 有跑 | 这是**分母**,故意不过滤 —— 用来量第 1 条丢了多少 |
| 6 | `routes/assr.ts` 单张重拉 | 一张 SO | 人手按钮 | — | 仍套用 routeRegion,拉不到会 422 |
| 7 | `routes/autocount-relink.ts` `/relink-lines` | 读活账本 → **写** `linked_ac_dtlkey` | 人手按钮 | — | ⚠️ **整条链路唯一没有 plan 模式的写入** —— 按下去就写 |

**第 1 条的两个静默丢行(这是进来方向最重要的两个洞):**

- **`routeRegion` 丢行不留痕。** `autocount.ts:311-321`:`SalesLocation` 不在
  `{KL, PG, HQ, SBH, SRW}` 里、地址又不含 SINGAPORE 的单,直接 `skipped++`,
  **数据库里不留任何记录**。`ac_snapshot_*` 那两张表存在的唯一理由,就是把这个损失变成可以数的东西。
- **checkpoint 只在「零失败」时前进。** `pull.ts:92`:
  `mode === "filtered" && !since && failed === 0` 才推进 checkpoint。
  **一行坏行就把整个窗口永远冻住** —— 这是 bug `0386`,Postgres 割接期间整段就是这样丢的。

### 2B. 快照档案线 —— 割接的搬运工

办公室主机上用只读 SQL 导出 `.json.gz`,commit 进 repo,再由 workflow 写进 ERP。

**全部脚本都是 plan 默认、`apply=1` 才写**,删除 / 铸码类还要 confirm 字串。**这一条我逐个查过,没有例外。**

| 线 | 搬什么 | 上次 **APPLY**(本地时间) | 断在哪 / 属于哪一类缺陷 |
|---|---|---|---|
| `import-ac-outstanding-so` | SO 单头 + 明细 + 收款 | **09-07 18:33** | `ON CONFLICT DO NOTHING` —— **重跑会静默跳过所有改过的单** |
| `import-ac-outstanding-po` | PO 单头 + 明细 | 09-07 18:39 | 同上 |
| `import-ac-so-linked-pos` | 从 SO 开出的 PO(含已收货) | 09-07 18:44 | 刻意不开 GRN(账本铁律 1) |
| `import-ac-stock-balance` | 实物开账 ADJUSTMENT | 08-29 21:54 | 沙发被 `isSofaFurniture()` 排除;负数差异要 `NEG=1` |
| `import-ac-stock-layers` | 平铺层 → 真 FIFO 层 | 08-28 21:46 | 沙发同样排除 |
| `import-ac-sofa-stock` | 沙发:收货 PO 行 → compartment lot | **09-07 (有 APPLY)** | 账本 §5 #14 写「apply 一次都没有」—— **已经过时,不要照着补跑** |
| `create-migrated-documents` | 迁移 GRN + DO,`migrated_no_stock` | 09-07 (有 APPLY) | GRN 那一半 **09-07 已被 `reshape-migrated-grns` 取代** |
| `create-migrated-invoices` | 我们自己的 GR→PI / DO→SI | 09-08 01:29 | AutoCount 自己的 4,789 PI / 9,245 SI 历史**故意不导** |
| `reshape-migrated-grns` | 一张 GRN 对一次收货 × 一张 PO | **今天 08:59** | 会写 dtlkey |
| `stamp-ac-grn-refs` | GR / PI 单号字串 | **今天 11:15** | 只写两个 text 栏,不开单不动库存 |
| `sync-ac-delta` | **唯一看得见「已搬进来又被改过」的单**(实测 437 张) | **今天 13:06** | ⚠️ `hdr` / `hdrstaff`(主数据)**默认关闭** |
| `refresh-so-tail-from-book` | 单头 remark / note / 日期 | 今天 10:34 | 只补空白;人动过的单一律拒绝 |
| `topup-ac-so-lines` / `topup-ac-po-lines` | 账本有、我们没有的行 | 今天 08:23 / 09:49 | 没有 key 的行报 **UNJUDGEABLE**,不猜 —— 这是对的 |
| `backfill-ac-line-keys` | SO + 下游的 dtlkey | **08-28 22:43**(11 天前) | **PO 故意跳过** |
| `backfill-ac-sofa-line-keys` | 沙发行的 dtlkey | 09-08 03:26 | |
| **`backfill-po-ac-dtlkey`** | **PO 行的 dtlkey** | ** 唯一一次 run 是红的(08-11)** | ⚠️ **多余的死线,不是断线 —— 见 §4.1** |
| `repair-*-from-autocount` / `-from-book` ×约 12 | 价 / 量 / 收款 / 折扣 / 连结 / desc2 | 多数 09-07~09-08 | 逐项见账本 |

### 2C. 快照档案本身:哪几张是「量不准的尺」

档案清单和它们的来历在账本 §6。这里只记**地图关心的一件事:哪一张的取样范围会静默漏掉东西。**

| 档案 | 取样条件 | 会漏掉什么 |
|---|---|---|
| **`ac-gr-refs.json.gz`** | `WHERE po.DocNo IN ('<po1 ∪ po2 导出的单号>')` | ❌ **不在那批 PO 里的收货,永远看不见。** 一张已结束的采购单,它的收货和发票就此隐形 |
| `ac-outstanding-so.json.gz` | `Cancelled='F'` + 有未转 DO 的行 + **排除只开发票没开 DO 的** | 已取消、现金销售、`HC-`/`ZZ` 测试单 |
| `ac-outstanding-po.json.gz` | 有 `Qty > TransferedQty` 的行 | 已全部收货的 PO |
| `ac-partial-dos.json.gz` | 父 SO 必须仍未结 | 已结单的送货 |
| `ac-item-costs.json.gz` | `Cost<>0 OR RealCost<>0 OR MostRecentlyCost<>0` | **零成本的料完全不在成本瀑布里** |
| `ac-reconcile-truth` / `ac-convert-edges` / `ac-fidelity-*` | 全账本,一行一个 DtlKey | 没有漏 —— **这几张才是分母** |

**另外七张 `.json.gz` 在这个 repo 里找不到导出程式**,是当时在主机上临时写 SQL 切的,
**换台机器重现不出来**:`ac-stock-layers`、`ac-sofa-gr-po`、`ac-last-purchase-costs`、
`ac-line-desc2`、`ac-line-truth`、`ac-po-line-costs`、`ac-seed-baseline-balance`。

### 2D. 手写的档案 —— 没有人拿账本批改过的那一类

`sofa-compartment-corrections-2026-08.json` 写错过三个沙发型号,而
`apply-sofa-compartment-corrections.mjs` 照单全收(`c.model || modelOf(...)`),
**算出来的那个备胎一直是对的,写下来的那个没有东西在管它**。现在有 grader 了
(`check-sofa-corrections-vs-book.mjs`),但**它是 2026-09-08 才写的 —— 在档案已经套用之后**。

**同一个问题,还有 12 个档案:**

`autocount-erp-mapping-1561.csv`(约 20 条线共用的翻译真源,只在 2026-08-11 对过一次账本)、
`agent-staff-binding.csv`、`autocount-sku-rebind-pairs.tsv`、`special-order-phrase-map.json`、
`sofa-tier-shift-2026-08.json`、`minted-sofa-skus-2026-08.json`、
`derived-recliner-cells-2026-08.json`、`costing-gap-fill-round2.json`、
`supplier-combos-2026-08.json`、`align-{seed,models,skus,safe-cleanup}-houzs-century.json`、
`r2-{so,po}-photo-keys-2026-08-10.txt`、`sofa-compartment-corrections-2026-09.json`。

---

## 3. 出去的方向(ERP → AutoCount)

### 3A. 机制

存单 → `enqueueAcOp` 排进 `scm.autocount_outbox` → **5 分钟 cron** drain
(`index.ts:571`)→ 经 tunnel POST 给办公室主机 → 主机用 SDK 写进账本 →
回报它建立的行,ERP 把 `linked_ac_docno` / `linked_ac_dtlkey` **盖回来**。

**两道闸,两道都要开:**
1. `AC_SYNC_URL`(`wrangler.toml:42`,有)+ `AC_SYNC_KEY`(Worker secret)。
   **URL 没设 = 整个 drain 静默跳过,一行都不标失败。**
2. `scm.app_config['scm.autocount_writeback']` —— 今天实测 = **`"1"` = company 1 开着**。
   `0277` 出厂是 `'off'`;解析失败一律 fail-closed 回 `'off'`。

### 3B. 九个动作,八个从来没用过 ⚠️

`autocount-outbox-health` run **34188...(今天 08:04)** 实测:

| 动作 | 队列里有过几行 | 状态 |
|---|---|---|
| `create_so` | **0** | ❌ **从来没有排过队** |
| `create_po` | **0** | ❌ 从来没有排过队 |
| `so_to_do` | **0** | ❌ 从来没有排过队 |
| `so_to_po` | **0** | ❌ 从来没有排过队 |
| `po_to_gr` | **0** | ❌ 从来没有排过队 |
| `do_to_iv` | **0** | ❌ 从来没有排过队 |
| `gr_to_pi` | **0** | ❌ 从来没有排过队 |
| `cancel` | **0** | ❌ 从来没有排过队 |
| `edit` | 32 行:**sent 28** / failed 1 / skipped 3 | ✅ 唯一用过的,**最后一笔 2026-09-04 14:51** |

**这就是「出去的方向几乎不存在」的证据。** 整个队列有史以来 **32 行**,全部是 `edit`。
在 ERP 里新开一张单、转一张 DO、开一张发票、取消一张单 —— **一次都没有送进过账本。**

> **这不必然是缺陷,但必须是一个决定。** 割接期间 AutoCount 仍是主账本,
> 单还是在 AutoCount 开的,所以 ERP 不需要往回开单。
> **但上线之后如果 ERP 是唯一开单的地方,这八个动作就必须先各跑通一次** ——
> 现在没有任何证据说它们能用。**这是本地图给上线定的第一个门槛。**

### 3C. 卡住的四笔,全部是同一个原因

```
SO HC-SO-013361 (edit): Gave up after 6 attempts. Last error: line 913803 not found on SO-013361
SO HC-SO-013361 (edit): refused (KeylessLineError): 1 of 9 line(s) carry no AutoCount DtlKey — line 9 (HOK-1013 (Q))
SO HC-SO-013394 (edit): refused (KeylessLineError): 1 of 8 line(s) carry no AutoCount DtlKey — line 1 (HOK-1013 (S))
SO HC-SO-013394 (edit): refused (KeylessLineError): 同上
```

`composeEdit`(`autocount-writeback.ts:1412`)在**送出之前**就拒绝,理由写在错误讯息里:
送一张有无号行的 edit,会在**活账本上长出重复的行,而 PO 上的重复行删不掉**。
**这个拒绝是对的。** 问题不在拒绝,在于**为什么那些行没有号**。

---

## 4. 现在断在哪 —— 按「重复出现的缺陷类型」归类

前面每一次修,都是一次抓一个。这一节把**同一类的全部列在一起**。

### 4.1 ❌ 缺行号 → 只能用猜的(class 1)—— 全篇最贵的一类

**先讲一件差点被我写错的事。**
`backfill-po-ac-dtlkey.yml` **整个历史只有 1 次 run,而且是红的** ——
run `31483323605`,2026-08-11 18:41 本地,`APPLY: 1`,最后 rolled back:

```
purchase-order lines            873
  already keyed                 280
  KEY RECOVERED                 0        <-- 一个都没补到
  refused, item code disagrees  108
  refused, WRONG DOCUMENT       173
Error: REFUSED: 2 AutoCount keys would identify more than one line. Rolled back.
```

**看起来像「PO 的号从来没补上」。查下去不是。** 两件事:

1. **那 2 个重复的 key 不是这次跑出来的。** `KEY RECOVERED = 0` 表示计划是空的,
   UPDATE 迴圈一行都没写;但守卫查的是**整张表**
   (`backfill-po-ac-dtlkey.mjs:113-121`,`WHERE p.company_id = 1` 全表 GROUP BY),
   不是它自己写进去的那些。所以**它是被两笔本来就存在的重复挡下来的,而且它本来就没事要做。**
   → 这本身是 class 3(检查器数的不是它自己声称的东西),只是这次的后果是「假红」。
2. **PO 的号其实是齐的。** `repair-migrated-po-lines` run `33189216543`(08-28,DRY-RUN)实测:
   `migrated purchase orders: 480; their lines: 1070` → **`missing linked_ac_dtlkey 0`**。
   今天的 reconcile 也印证:**PO 是五种单据里唯一一个「判不了」= 0 的**。

> **结论:`backfill-po-ac-dtlkey` 是一条多余的死线,不是断掉的活线。**
> 真正写 PO 行号的是 `repair-migrated-po-lines.mjs`(`backfill-ac-line-keys.mjs` 自己写明
> 故意跳过 PO,因为「repair-migrated-po-lines.mjs is the single writer」)。
> **但它红了四个星期没有人回头看** —— 一条永远红着的线,跟一条没有的线一样没用。

**真正缺号的是这四种单据(PROVEN,今天 reconcile):**

| 单据 | 判不了的张数 | 说明 |
|---|---|---|
| GR 收货单 | **44** | 割接批次 `grn_items` 带号的是 **0 / 636** |
| PI 采购发票 | **31** | |
| DO 送货单 | **25** | **173 张迁移 DO 的 `linked_ac_dtlkey` 全部是 NULL** |
| SO 销售单 | **23** | 只有部分行缺;卡住写回的 `HOK-1013` 就是这一类 |
| IV 销售发票 | **13** | |
| **PO 采购单** | **0** ✅ | 唯一齐的 |

migration `0280` 的档头自己写明了原因,原话:

> "Nullable by design... **Nothing backfills it: the keys are stamped forward**...
> A document created before the write-back was switched on keeps NULL keys and its
> first edit is refused LOUDLY... **That is the intended behaviour, not a gap to paper over.**"

**这句话是对的,但它的后果没有被算过。** 「往前盖」的意思是:
**只有 ERP 自己开的单才会有号,搬进来的单永远没有。**
所以「第一次改就被拒绝」不是边角案例,**是搬进来那 4,000 多张单的常态**。

**今天已经量出来了(`check-keyless-lines` run `34190327078`,13:21 本地):**

```
KEYLESS MULTISET TOTAL — 137 份单据 reconcile 判不了:
  124 份 PROVEN 两边完全一样(用 multiset 比对证明的)
    5 份 真的有差异
    8 份 真的判不出来
```

**这是好消息。** 137 份「对不了」里,**124 份已经用另一种方法证明是对的**。
真正要人看的只有 **5 + 8 = 13 份**。

### 4.2 ❌ 手写档案没有人拿账本批改(class 2)

见 §2D。**13 个档案,只有沙发那一个有 grader,而且是事后才补的。**
`autocount-erp-mapping-1561.csv` 风险最高 —— **约 20 条线共用它**,只在 2026-08-11 对过一次。

### 4.3 ❌ 检查器在数自己的猜测(class 3)

reconcile 今天自己已经把这一类分开报了,**这是修好的样子**:

- `GR — 34 个 item-code 差异是 CHECKER 自己的猜测,不是拿错货`
- `IV — 2 个同上`

**我自己今天也踩了一次**:第一版 run census 报「502 个 workflow 全部从来没跑过」——
真正的原因是 bash 环境没有 `jq`,脚本静默吐空值。
**502/502 这个数字太整齐,所以去查了一次才没有写进这份文件。**

### 4.4 ❌ 一栏装了好几种东西(class 4)

- `grns.linked_ac_docno` 被割接填成了 **PO 的单号**,不是收货单号 ——
  所以才要新开一栏 `20260907T2345_grn_linked_ac_gr_docno.sql`
- `purchase_orders.po_number` 两种编法(账本 §1 坑一),只有 `linked_ac_docno` 认得
- `purchase_orders.currency` **一律写 `MYR`**(`import-ac-outstanding-po.mjs:401`),
  不管单据本身是什么币 —— 今天 reconcile 报 **1 张非 MYR 的单**

### 4.5 ❌ 取样条件静默缩小人口(class 5)

见 §2C。`ac-gr-refs.json.gz` 是最严重的一张。

### 4.6 ❌ 解析器只读懂一半(class 6)

`autocount-erp-mapping-1561.csv` 是 RFC4180,有三行把 ERP 码用引号包起来
(床垫名字里有英寸符号 `5""`)。用 `line.split(",")` 读它,造出 **111 个差异里的 40 个是假的**,
而它的自我测试**只数行数所以照样通过**。(bug `0689`)

---

## 5. 从来没有跑过的线

全仓 **502 个 workflow**,**37 个从头到尾零次 run**(2026-09-08 13:0x 实测)。
跟这条链路有关的:

| workflow | 它本来要回答什么 |
|---|---|
| **`ac-gap-attribution.yml`** | AutoCount 跟 ERP 的差异各自归因给谁 —— **零次** |
| **`align-rebind-unlinked.yml`** | 把没挂上的 SKU 重新配对 —— **零次**(账本 §5 #9 一个月前就这样写,至今没变) |
| **`ledger-divergence-check.yml`** | 库存账本本身对不对得上 —— **零次**,而账本 §7 把它列为建议跑的检查 |
| `backfill-zero-line-costs.yml` | 行成本补零 —— 零次 |
| `cancel-parity-check.yml` / `delivered-but-open.yml` / `duplicate-ic-check.yml` | 取消 / 已交货 / 重复 —— 各零次 |
| `variant-key-drift-check.yml` / `truth-scope-check.yml` / `sequence-drift-{check,repair}.yml` | 规格漂移 / 范围 / 流水号 —— 各零次 |
| `bedframe-sofa-status-truth.yml` / `probe-po-so-link-provenance.yml` / `stamp-po-line-costs.yml` | —— 各零次 |

**账本 §5 里两条「从来没跑过」的,今天查是已经跑过了 —— 那两行是过时的:**

| 账本写的 | 实测 |
|---|---|
| §5 #4 `backfill-zero-cost-lots` 一次都没跑 | ❌ 过时。**08-29 05:32 有 APPLY**(run `33849184319`) |
| §5 #14 `import-ac-sofa-stock` 的 apply 一次都没有 | ❌ 过时。**09-07 有 APPLY**(run `34160820055`) |

> **这正是 `docs-assert-open-after-shipping` 那个失败模式。**
> 照着账本去「补跑」这两条,会把已经做过的事再做一次。

---

## 6. 今天量到的现状(全部只读,每个数字都有 run id)

### 6A. 单据对账 —— `ac-erp-reconcile` run `34189608519`(13:10 本地)

| 类型 | 两边都有 | 账本有、我们没有 | 行数差 | 品项码差 | 数量差 | 金额差 | **判不了** |
|---|---|---|---|---|---|---|---|
| SO | 2,882 | **0** | 11 | 1 | 1 | 5 | 23 |
| PO | 574 | **0**(+1 业主已裁定) | 0 | 0 | 0 | **0** | 0 |
| GR | 400 | **0** | 0 | 2(+34 是猜的) | 0 | 9(+100 业主裁定 RM 0) | 44 |
| DO | 173 | **0** | 2 | 0 | 1 | 1 | 25 |
| **IV** | 43 | ❌ **6** | 0 | 0(+2 猜的) | 0 | 0 | 13 |
| PI | 55 | **0** | 1 | 0 | 0 | 0 | 31 |

**总结论:`40 个差异不属于任何已声明的设计差别`。** 其余 399 个是「不是工作」的项目
(业主已裁定的、账本本来就没写价的、非 MYR 的、GR 记 RM 0 的)。

**唯一真的少了单据的地方:6 张发票。**
`I-000213`、`I-2410-0016`、`I-2410-0192`、`I-2411-0275`、`I-2411-0323`、`I-2507-0234`。

### 6B. 库存 —— `check-stock-vs-autocount` run `34189095967`(13:02 本地)

```
cells compared: 996 | AGREE: 962 | DISAGREE: 0 | AutoCount-only: 0 | ERP-only: 3
unit totals over comparable cells — AutoCount 9916 vs ERP 9916 (net +0)
migrated documents that DID write an inventory movement (must be 0): 0 / 0 / 0 units
scm.delivery_orders: 173 rows, 173 migrated_no_stock
scm.grns:            473 rows, 473 migrated_no_stock
```

✅ **三条硬约束今天全部成立**(3 个 ERP-only cell 是开账当天就有的差,`CUTOVER ADJUSTMENT ONLY`,RM 0.00)。

### 6C. ⚠️ 沙发:总数对,位置不对

**同一个 run 的 PART A2**,这一段值得单独讲:

```
whole sofas — AutoCount 107 vs ERP 107 (net +0)
SOFA cells compared: 41 | AGREE: 19 | DISAGREE: 22
```

**总数 107 = 107 是真的,但它是一个净数。**
41 个「型号 × 仓库」格子里 **22 个对不上**,正负互相抵销掉了:

| 型号 @ 仓库 | 账本 | ERP | 差 |
|---|---|---|---|
| 5530 @ KL 仓 | 8 | **0** | −8 |
| 9028 @ KL 仓 | 13 | 19 | +6 |
| 8030 @ PG 仓 | 1 | 5 | +4 |
| 5530 @ PG 仓 | 4 | **0** | −4 |
| 8030 @ KL 仓 | 8 | 11 | +3 |
| 2379 @ PG 仓 | 4 | 1 | −3 |
| …(其余 16 个格子,差 ±1~2) | | | |

**5530 这个型号在账本里 KL 8 套 + PG 4 套,ERP 里两边都是 0。**
「107 对 107」这句话如果只看总数,会把这 12 套完全盖掉。

> 这就是 memory 里那句 **「an outlier explained away is the finding you missed」**。
> **以后报沙发,必须报 `41 格中 22 格不符`,不能只报 `107 vs 107`。**

### 6D. 两个方向的心跳

| | 证据 | 状态 |
|---|---|---|
| 进来 | `autocount-pull-sentinel` run `34189631223`(13:10) | ✅ `HEALTHY: the checkpoint is current and rows are arriving` |
| 出去 | `autocount-outbox-health`(08:04) | ⚠️ 开关 ON;`edit` 最后一笔 **09-04 14:51**;其余 8 个动作**零行** |

> sentinel 自己声明了它**证明不了**的事:
> 「it does NOT prove that the HISTORY is complete」——
> 增量拉取只问 `getSince(checkpoint)`,比最早 checkpoint 更旧的修改**永远不会被提供**。

---

## 7. 一次性的计划 —— 按依赖顺序

**分两栏:我们自己能做的,和必须业主决定的。**
把它们混在一起,正是「修了很多次还是一样」的原因 —— 等决定的事被当成待办反覆重跑,
能做的事被当成决定一直搁着。

### 7A. 我们自己做(不需要业主开口)

| # | 做什么 | 解开什么 | 风险 |
|---|---|---|---|
| **A1** | **这份地图**(本文件) | 下一个 session 不必再从头推一次;账本记历史,地图记现状 | 无 |
| **A2** | 改掉账本 §5 #4 / #14 两行过时状态 | 防止照着账本「补跑」已经做过的事 | 无(只改文件) |
| **A3** | `backfill-po-ac-dtlkey` 退役,或把守卫改成只数它自己写的行 | 一条永远红着的线不再假装是待办;PO 的号本来就齐 | 低 |
| **A4** | 把从来没跑过的只读检查各跑一次 | CLAUDE.md 的规则:**没有被 dispatch 过一次并回报成功的 workflow,不算出厂**。现在有 37 个这样的 | 无(只读) |
| **A5** | 给其余 12 个手写档案补 grader,照 `check-sofa-corrections-vs-book.mjs` 的样子 | 关掉 class 2 —— 目前只有沙发那一个有人批改,而且是事后补的 | 无(只读) |
| **A6** | 重切 `ac-gr-refs.json.gz`,拿掉 `po.DocNo IN (...)` 那个范围条件 | 关掉 class 5 最严重的一张尺;已结束采购单的收货和发票不再隐形 | **需要一次新的账本导出 —— 必须排队,不能跟别人同时跑** |
| **A7** | 查沙发 41 格中 22 格不符 | 「107 vs 107」不再盖住 5530 那 12 套 | 只读调查 |
| **A8** | 查那 6 张缺的发票是不是真的该进来 | IV 是唯一还有单据缺口的类型 | 只读调查 |

### 7B. 业主决定(动到活单据上的钱 / 生意规则)

| # | 要他决定什么 | 现在的事实 |
|---|---|---|
| **B1** | **6 张发票要不要搬进来?** | `I-000213` `I-2410-0016` `I-2410-0192` `I-2411-0275` `I-2411-0323` `I-2507-0234` |
| **B2** | **沙发 5530:账本说 KL 8 套、PG 4 套,ERP 两边都是 0 —— 哪边对?** | 另外 20 个格子差 ±1~6;总数刚好抵销成 107 = 107 |
| **B3** | **HC-SO-000021 收了 RM 10,852,单只有 RM 9,876** | 今天修折扣时浮出来的(run `34188782181`),多出 RM 976 |
| **B4** | **上线后 ERP 是不是唯一开单的地方?** | 如果是,那 8 个**从来没排过队**的写回动作必须先各跑通一次才能上线 |
| **B5** | 整本账 PO 行折扣 **RM 1,760,189.99**(2,976 行 / 533 张单) | 搬进来的那 10 张 / 89 行 / RM 42,662.80 **已经修好**;其余在割接范围外 |
| **B6** | 那 **13** 份判不出来的单据(5 份真差异 + 8 份判不了) | 其余 124 份已用 multiset 证明两边一样 |

### 7C. 上线前的门槛(这份地图给的结论)

1. ✅ 库存三条硬约束成立(996 格 0 不符、9,916 = 9,916、迁移单据 0 库存流水)
2. ✅ 进来的方向活着(5 分钟一次,checkpoint 当前)
3. ⚠️ **沙发要按格子看,不能只看总数**(22 / 41 不符)
4. ❌ **出去的方向有 8 个动作从来没有跑过一次** —— 见 B4
5. ❌ **37 个 workflow 从来没被 dispatch 过** —— 见 A4

---

## 8. 为什么「修了很多次还是一样」—— 真正的根因

**不是修得不对。是「还有什么没修」这个问题,每次都问错了工具。**

今天一次 session 里,「文件说还开着、其实早就做完了」出现了 **至少 24 次**。
下面是我自己动手验过的四个,每个都附证据 ——
**照着文件去做,就会把已经做过的事再做一遍,然后以为问题又回来了。**

| 文件怎么写 | 实际 | 我怎么验的 |
|---|---|---|
| 账本 §5 #4:`backfill-zero-cost-lots` **一次都没跑** | ❌ 过时。**08-29 05:32 APPLY** | run `33849184319` 的 log:`mode=APPLY` |
| 账本 §5 #14:`import-ac-sofa-stock` 的 apply **一次都没有** | ❌ 过时。**09-07 APPLY** | run `34160820055`:`mode=APPLY` |
| bug `0668`:GRN 取消会写幽灵库存,**「Status: FOUND, NOT YET FIXED」** | ❌ 过时。**闸门已经在 code 里** | `grns.ts` 有 **11 处** `migrated_no_stock`;`:2641` 就在取消路径上,`:2637-2640` 的注解把理由写清楚了 |
| 「PO 的行号从来没补上」(`backfill-po-ac-dtlkey` 红了四星期) | ❌ 误读。**PO 的号是齐的** | `repair-migrated-po-lines` run `33189216543`:`missing linked_ac_dtlkey 0`;今天 reconcile:PO 是唯一「判不了 = 0」的类型 |

**还有 20 个同类的**,证据都在 `docs/bugs/` 里,例如:
账本 §1「坑二」说 `purchase_orders.linked_ac_docno` 没有 migration —— 其实
`0277_scm_autocount_outbox.sql:89-105` 就是在补它;
账本 §7 说 `check-line-supply-trace.yml` 还没合并 —— 档案就在 `.github/workflows/` 里。

### 结论:三条规矩

1. **账本 §5 的第一张表不能单独读。** 它下面那张「收盘状态」表才是真的,
   四行已经反了。**两张表应该合并** —— 这是全仓被抄错最多次的一段。
2. **报「还开着」之前,先看树,不要看文件。**
   `docs-assert-open-after-shipping` 这个失败模式,今天又发生了至少四次。
3. **「还没修」的数量不能用 grep 数。** 今天早上有人量出 217 条未修,
   其中 **113 条的关键字是 `unfixed tree`** —— 那是本仓 TDD 的写法,
   意思是「修之前先证明测试是红的」,**每一条都是修好了的证明**。
   PR #3198 已经把这个量法换掉了(`gen-bug-status.mjs` + `lib/bug-ledger.mjs`)。

---

## 9. 真正还开着的(已扣掉上面那些过时的)

**按「谁来决定」分。** 完整逐条在 `docs/bugs/` 和各 `docs/cutover-*.md`;这里只给分类和数目。

### 9A. 我们的(engineering)

| 类 | 还开着的 | 关键几条 |
|---|---|---|
| 行号 | **5 类单据缺号** | DO 173/173 全缺(`lib/migrated-do-writer.mjs` 从来没写过 `linked_ac_dtlkey` + `line_no`,**要新写 code**);`grn_items` 0/636 |
| 收货 | GR 落后账本 | 103/400 GR 行带着 AutoCount 原始码当 `item_code`;89/574 PO 账本收了货、ERP 没有收货单 |
| 金额 | 迁移单据的钱 | 100/400 GR 记 RM 0 而账本有值;70 张 PO 单头总额 0(脚本写好了,run id 没留下来) |
| 取样 | class 5 的尺 | `ac-gr-refs.json.gz` 要重切;付款那条线读的是「送货未结」名单,**客人一付钱单就离开名单** |
| 匯入 | `ON CONFLICT DO NOTHING` | 437 张账本改过的 SO 被静默跳过;`sync-ac-delta` 只写 3 个 lane |
| 状态 | `mfg_sales_orders.status` 是快取 | 12 份手抄的 `statusFor`;脚本写的 DO 不会推进它的 SO |
| 分配 | dispatchable recompute **08-16 起完全跑不动** | `pgrest-shim` 不支援 embedded select;43 张 CONTESTED 单只能靠它修 |

### 9B. 业主的(动活单据上的钱 / 生意规则)

| 要决定什么 | 数字 |
|---|---|
| 6 张缺的发票要不要搬 | `I-000213` `I-2410-0016` `I-2410-0192` `I-2411-0275` `I-2411-0323` `I-2507-0234` |
| 沙发在卖货仓短少 | **25 单位短 / 25 单位多**,下限 **RM 59,568.49**(22 格里只有 9 格有成本) |
| 沙发 5530 | 账本 KL 8 套 + PG 4 套,ERP 两边都 0 |
| 负数库存差异 | **156 个,只报不扣**,`neg=1` 从来没开过 |
| 9 张混合收货单 | 留下枕头的 RM 120,丢掉沙发的 RM 3,080 —— 看起来有价,其实错 96% |
| `HC-SO-000021` | 收 RM 10,852,单 RM 9,876,客人多付 **RM 976** |
| 255 行卡在退役的布号上 | 修复脚本写好了,没跑 |
| 上线后 ERP 是不是唯一开单的地方 | 决定了才知道那 8 个写回动作要不要先跑通 |
| write freeze | 24 个区里 **23 个还冻着** |

---

## 10. 这次 session 自己跑出来的两个第一次

CLAUDE.md 的规矩:**一个 `workflow_dispatch` 的 workflow,没有被 dispatch 过一次
并回报成功,就不算出厂。** 全仓有 **37 个** 这样的。今天先跑了跟这条链路最相关的两个 ——
**两个都是它们历史上的第一次执行,两个都成功,两个都带回了新事实。**

### 10.1 `ac-gap-attribution` —— 第一次执行,run `34191557797`(2026-09-08 13:5x 本地)

它回答的问题:**账本里那些 ERP 没有的单据,是「资料还没拿到」,还是「资料早就在 repo 里、只是没有人跑那条线」?**

```
SO: 2789 in scope; 2789 already carried by ac-outstanding-so.json.gz;   0 NOT in any committed migration source
PO:  484 in scope;  484 already carried by ac-outstanding-po + ac-so-linked-pos; 0 NOT in any source
GR:  214 in scope;  214 already carried by ac-gr-refs.json.gz;          0 NOT in any source
DO:   84 in scope;   84 already carried by ac-partial-dos.json.gz;      0 NOT in any source
IV:   47 in scope;   47 already carried by ac-invoice-refs.json.gz;     0 NOT in any source
PI:  192 in scope;  192 already carried by ac-invoice-refs.json.gz;     0 NOT in any source

3810 in-scope documents are already in a committed migration source; 0 are not in any of them.
```

**这把「缺单据」这个问题整个换掉了。** 3,810 张在范围内的单据,**没有一张的资料是缺的** ——
全部已经躺在 repo 的快照档案里。ERP 里没有的,**只差有人跑那条线**,不是差资料。

> 这个 workflow 的档头自己写着:「Run it BEFORE writing an importer: on 2026-09-07 it
> would have shown that all 32 'missing' goods receipts and all 12 'missing' delivery
> orders were already in the tree.」—— **它写好了,然后没有人跑它,然后那件事又发生了一次。**

### 10.2 `ledger-divergence-check` —— 第一次执行,run `34191596758`

账本 §7 把它列为「库存账本本身有没有对不上」该跑的检查。**它从来没有被跑过。**

```
60 bucket(s) where the two ledgers disagree.
39 bucket(s) have a NEGATIVE movement balance. A warehouse cannot hold minus one of
anything, so the movement ledger is the wrong side on those.
```

**⚠️ 这不是 §6B 那个「996 格 0 不符」变坏了 —— 是两把不同的尺:**

| 尺 | 比什么 | 今天的答案 |
|---|---|---|
| `check-stock-vs-autocount` | **ERP** vs **AutoCount** | ✅ 996 格,0 不符 |
| `ledger-divergence-check` | ERP 的**流水账** vs ERP 的**批次账**(内部) | ❌ **60 格不符**,其中 39 格流水是负的 |

**ERP 跟账本对得上,但 ERP 内部自己两本账对不上 60 格。**
这个检查自己也说了不要照着修:它只讲**哪一格**不合,不讲**哪一边**对
(repo 里两边都当过错的一方),要用 `reconcile-sku.mjs` 逐格走单据定案。

**新增待办(我们的)**:60 格逐格用 `reconcile-sku` 定案,39 格负数流水优先。

---

## 11. 跟正在跑的活线的重叠(不要撞车)

写这份地图的时候,有两条线正在动同一批东西:

| PR / 分支 | 在做什么 | 跟这份地图的哪一条重叠 |
|---|---|---|
| **#3198** `fix/cutover-ledger-backlog`(已合并) | 把 bug 账本的「还开着」量法换掉(`gen-bug-status.mjs`);修好一个 `[critical]` 但从来没跑过的 probe | §8 第 3 条规矩 |
| **#3199** `fix/ac-line-keys-downstream`(进行中) | **把 AutoCount 自己的行号盖到迁移的 GR 和 DO 上** | **§9A 第一条(DO 173/173 缺号)—— 交给它,不要另开一条** |

**这份地图没有碰这两条线的任何档案。**

