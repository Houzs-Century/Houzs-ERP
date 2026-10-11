# 13 张「已过期、MRP 仍在排、但从未发货」销售单 —— 根因调查

- 调查日期：2026-09-15（只读，未写库、未改代码、未跑任何流程）
- 生产库：Supabase `anogrigyjbduyzclzjgn`（HOUZS ERP SG），company_id = 1
- 范围：HC-SO-002369 / 004574 / 007005 / 006859 / 010073 / 008772 / 007676 / 010397 / 011064 / 004965 / 006002 / 010797 / 007851
- 所有结论都用生产库当场跑的 SELECT 证实，标 **已证实**；无处标 UNKNOWN。

---

## 一句话总结（白话文）

这 13 张单**本质上是同一个病**：它们全部是 **2026-08-28 那次 AutoCount 回导（re-import）** 一次性建进 ERP 的旧单。建进来时，AutoCount 里记的日期（下单日 so_date、处理日 processing_date、客户交期 customer_delivery_date）被原样抄进 ERP；`proceeded_at` 被塞了一个「下单日早上 8 点」的合成值。**从建单那天到今天，没有任何人在 ERP 里改过它们的处理日或交期，没有人手动 proceed 过，也从来没有开过一张出货单（DO）**。AutoCount 那边的账本也还是开着的（没有发票、没有出货）。

所以：
- **为什么 MRP 还在排？** 因为这些单「处理日有值 + 还没发货」，在 MRP 眼里就是活的需求。
- **为什么算过期？** 因为它们的客户交期全部落在今天（2026-09-15）之前，最老的是 2025-04-21。
- **它们不是被人改坏的，也不是「proceed 后交期滑掉」，而是「一批从 AutoCount 抄进来、抄进来就没人再动的历史欠单」。**

换句话说：这不是数据故障，是**一批 AutoCount 里本来就没结清的老单被搬进了 ERP，ERP 里没人接着走发货**。真正要做的是业务上一张张判：到底发了没有 / 要不要作废 / 要不要真发货，而不是去 ERP 里「修」什么字段。

---

## 三条聚合结论（都已证实）

| 结论 | 计数 | 证据 |
|---|---|---|
| 全部由 2026-08-28 AutoCount 回导建单（created_at 都是 2026-08-28 16:11 左右） | **13 / 13** | 表头查询，created_at 全落在 `2026-08-28 16:11:11`~`16:48:48` |
| 处理日 / 客户交期从建单后**从未**被任何人（web 或 backfill）改过 | **13 / 13** | 审计表按 `processing_date`/`customer_delivery_date`/`proceed` 过滤 field_changes → **0 行** |
| 全程**从未发货**：无 DO 明细行、无 DO 表头引用 | **13 / 13** | so_item_id 关联 delivery_order_items = 0；delivery_orders.so_doc_no 命中 = 0 |
| 全程**从未在 ERP 手动 proceed / 撤销**（proceeded_at 是导入合成值 08:00，审计里无 proceed 事件） | **13 / 13** | proceeded_at 全为 `so_date 08:00:00`；审计 action 只有 UPDATE_LINE / UPDATE_STATUS / UPDATE_DETAILS |
| 处理日 = 下单日（AutoCount 里当天就处理） | **9 / 13** | 002369,004574,004965,006859,007005,010073,010397,010797,011064 |
| 处理日 **晚于** 下单日（AutoCount 里隔了一段才处理，非 ERP backfill） | **4 / 13** | 006002,007676,007851,008772 |
| 有一张已收货（RECEIVED）PO 挂在单上 | **8 / 13** | 004574,006002,006859,007676,008772,010073,010397,010797（PO 全 RECEIVED，全 2026-08-28 导入） |
| 无 PO（属库存现货类，走仓库分配） | **5 / 13** | 002369,004965,007005,007851,011064 |
| 客户交期落在 2025 年（已过期一年以上） | **4 / 13** | 002369,004574,006859,007005 |

**关于「backfill」的明确否证（已证实）**：任务里假设的「处理日是后来某天被 backfill 的」——在这 13 张单上**不成立**。审计表里没有任何一行改动过 processing_date 或 customer_delivery_date。那 4 张「处理日晚于下单日」的单，晚出来的处理日是 **AutoCount 账本里本来就那样**，被原样导入，不是 ERP 里补写的。

---

## 状态为什么在跳（READY_TO_SHIP ⇄ CONFIRMED）

审计里唯一「热闹」的就是状态在 READY_TO_SHIP 和 CONFIRMED 之间来回跳，**全部来自 `automation`**，备注是：
- `Auto-advanced: every main product line is READY (stock)` —— 库存凑齐，自动进 READY_TO_SHIP
- `Auto-regressed: a main product line is no longer READY` —— 库存又被别处占走，自动退回 CONFIRMED

2026-09-11 14:31~15:38 有一整批单被扫了一遍来回翻（同一批 automation sweep）。**这只是库存分配在抖动，不是有人在操作单子，也和「过期 / 未发货」的根因无关。** 没有任何一次状态变化是人手点的（source 里除了 automation/auto-allocation，只有 09-10 三张单加了个协作人）。

---

## 逐单明细（表头已证实；DO/PO/审计均已证实）

字段说明：状态 / 下单日 / 处理日 / 客户交期（均已换算 Asia/Kuala_Lumpur）/ 行数 / PO / 是否发过货 / 根因判词

### HC-SO-002369 —— PT
- READY_TO_SHIP｜下单 2025-04-13｜处理 2025-04-13｜交期 **2025-04-21**｜4 行（DUNLOPILLO 床垫+枕+AERO-MP+DISPOSE）｜无 PO｜无 DO
- 审计：08-28 导入即 READY，09-11 sweep 抖动，无人手动碰
- **判词：2026-08-28 AutoCount 回导的旧单，带 2025-04 的老交期，之后从未被动过、从未发货 —— 纯历史欠单。**

### HC-SO-004574 —— sargonan a/l ravi
- READY_TO_SHIP｜下单 2025-02-10｜处理 2025-02-10｜交期 **2025-05-03**｜5 行｜PO **HC-PO-002654 已收货**（TRION 沙发，GR-001673）｜无 DO
- 审计：09-10 有人只加了协作人（collaboratorStaffIds），未碰日期；09-11 sweep 抖动
- **判词：回导旧单，料（TRION）都收齐了却一直没开出货单，交期停在 2025-05 —— 备料完成但发货断链。**

### HC-SO-004965 —— fauziah binti bakar
- READY_TO_SHIP｜下单 2025-03-02｜处理 2025-03-02｜交期 **2026-04-27**｜2 行（AKEMI 床垫+枕）｜无 PO｜无 DO
- 审计：09-10 仅加协作人，其余无人手动碰
- **判词：回导旧单，现货类，交期已过，从未发货 —— 历史欠单。**

### HC-SO-006002 —— HUSNIAH
- READY_TO_SHIP｜下单 2025-05-03｜处理 **2025-05-22**（AutoCount 里晚 19 天，非 ERP backfill）｜交期 **2026-04-27**｜1 行（CASUAL-(K)）｜PO **HC-PO-003588 已收货**（GR-001995）｜无 DO
- 审计仅 2 行（08-28 导入 + 自动进 READY），之后完全没动
- **判词：回导旧单，处理日晚于下单日是 AC 原值；沙发料已收，未发货 —— 备料完成但发货断链。**

### HC-SO-006859 —— Lim Chin Sheng
- READY_TO_SHIP｜下单 2025-06-28｜处理 2025-06-28｜交期 **2025-08-01**｜5 行｜PO **HC-PO-004196 已收货**（TRION，GR-002221）｜无 DO
- 审计：09-11 sweep 抖动，无人手动碰
- **判词：回导旧单，2025-08 老交期，TRION 已收却未发货 —— 备料完成但发货断链。**

### HC-SO-007005 —— Amanda Teoh
- READY_TO_SHIP｜下单 2025-07-06｜处理 2025-07-06｜交期 **2025-07-17**｜3 行（DUNLOPILLO 床垫+枕+DISPOSE）｜无 PO｜无 DO
- 审计：08-29 曾自动退回 CONFIRMED，09-08 又进 READY，09-11 sweep；全自动
- **判词：回导旧单，现货类，2025-07 老交期，从未发货 —— 历史欠单。**

### HC-SO-006859 之外的沙发单同型——HC-SO-007676 —— Teh Sam Weng
- READY_TO_SHIP｜下单 2025-08-11｜处理 **2025-10-07**（AC 里晚约 2 个月）｜交期 **2026-04-06**｜4 行｜PO **HC-PO-005535 已收货**（CELENE，GR-002798）｜无 DO
- **判词：回导旧单，处理日晚于下单日为 AC 原值；沙发料已收，未发货 —— 备料完成但发货断链。**

### HC-SO-007851 —— Mohammad Zaky
- **IN_PRODUCTION**（13 张里唯一）｜下单 2025-08-20｜处理 **2025-10-13**｜交期 **2026-04-30**｜8 行（AKEMI 床垫×2、枕、bolster、JM-CL 等）｜无 PO｜无 DO
- 审计：只有 auto-allocation 的 UPDATE_LINE，**从来没有 UPDATE_STATUS** —— 导入即 IN_PRODUCTION，库存从没凑齐过，所以连 READY 都没进过
- **判词：回导旧单，料一直没凑齐（无收货 PO），卡在 IN_PRODUCTION，从未发货 —— 备料未完成的历史欠单。**

### HC-SO-008772 —— amir
- READY_TO_SHIP｜下单 2025-10-27｜处理 **2026-01-05**（AC 里晚约 2 个月）｜交期 **2026-03-10**｜2 行（9028-2S 沙发 ×2）｜PO **HC-PO-007250 已收货**（GR-004065）｜无 DO
- 审计仅 3 行（导入+自动 READY+09-10 加协作人）
- **判词：回导旧单，处理日晚于下单日为 AC 原值；沙发料已收，未发货 —— 备料完成但发货断链。**

### HC-SO-010073 —— EQMAL HAIQAL
- READY_TO_SHIP｜下单 2026-01-05｜处理 2026-01-05｜交期 **2026-02-02**｜2 行（CROWN 沙发 + DUNLOPILLO 床垫）｜PO **HC-PO-007322 已收货**（GR-003769）｜无 DO
- 审计：09-08 起多次自动进退，09-11 sweep；全自动
- **判词：回导旧单，CROWN 已收却未发货，交期 2026-02 已过 —— 备料完成但发货断链。**

### HC-SO-010397 —— Tham
- READY_TO_SHIP｜下单 2026-01-28｜处理 2026-01-28｜交期 **2026-04-10**｜6 行｜PO **HC-PO-007706 已收货**（HILTON，GR-004126）｜无 DO
- 审计仅导入 + 自动 READY，之后没动
- **判词：回导旧单，HILTON 已收却未发货 —— 备料完成但发货断链。**

### HC-SO-010797 —— JENNIFER
- **CONFIRMED**｜下单 2026-03-15｜处理 2026-03-15｜交期 **2026-04-28**｜5 行｜PO **HC-PO-008094 已收货**（TRION HB STR，GR-004228）｜无 DO
- 审计：08-28 曾自动进 READY，**09-10 09:59 自动退回 CONFIRMED 后就停在这**（库存被占，不再 READY）
- **判词：回导旧单，料收了但库存又被占走、退回 CONFIRMED 卡住，从未发货 —— 备料后库存被抢占，发货断链。**

### HC-SO-011064 —— Jane Chang
- READY_TO_SHIP｜下单 2026-03-30｜处理 2026-03-30｜交期 **2026-04-22**｜3 行（AKEMI 床垫+枕+DISPOSE）｜无 PO｜无 DO
- 审计：09-11 sweep 抖动，无人手动碰
- **判词：回导旧单，现货类，交期 2026-04 已过，从未发货 —— 历史欠单。**

---

## 根因归类（给业务处理用）

三类，全部同源（2026-08-28 AC 回导的未结旧单），差别只在「料齐没齐」：

- **A. 备料完成但发货断链（料/PO 已收货，就是没开 DO）**：004574, 006002, 006859, 007676, 008772, 010073, 010397 —— 7 张。物料到了，等业务判断是否真出货或补 DO。
- **B. 现货类历史欠单（无 PO，靠仓库现货，已 READY 但没发货）**：002369, 004965, 007005, 011064 —— 4 张。
- **C. 备料未完成 / 库存被占**：007851（一直没凑齐，卡 IN_PRODUCTION）、010797（收了又被占走，退回 CONFIRMED）—— 2 张。

**共同处理方向（业务判定，不是改字段）**：这 13 张要一张张核 AutoCount 到底发了没有——
- 若 AutoCount 已实际交付而没回填 ERP：补 DO / 关单；
- 若客户早已取消或作废：作废，MRP 需求随之消失；
- 若确实还要发：走正常出货，DO 一开、交期一更新，就不再是「过期未发」。
在 ERP 里去动 processing_date / customer_delivery_date 治标不治本，且会掩盖 AutoCount 账本仍开着这个事实。

---

## 附：所用查询与关键返回（identifiers / SQL）

Schema 要点（已证实）：`scm.mfg_sales_orders` 无 `id` 列，主键是 `doc_no`+`company_id`；`scm.mfg_sales_order_items.id`(uuid) 被 `purchase_order_items.so_item_id` 与 `delivery_order_items.so_item_id` 引用；审计表 `scm.mfg_so_audit_log` 按 `so_doc_no` 记录，`action` ∈ {UPDATE_LINE, UPDATE_STATUS, UPDATE_DETAILS}，`source` ∈ {auto-allocation, automation, web}。

1. 表头（status/日期/proceeded_at/linked_do/linked_ac/created/updated，全部 `AT TIME ZONE 'Asia/Kuala_Lumpur'`）：
   `SELECT doc_no,status,so_date,processing_date,customer_delivery_date,debtor_name,on_hold,proceeded_at,linked_do_doc_no,linked_ac_docno,line_count,created_at,updated_at FROM scm.mfg_sales_orders WHERE company_id=1 AND doc_no IN (...)`
   → 13 行；created_at 全 = 2026-08-28 16:11~16:48；linked_do_doc_no 全 NULL；linked_ac_docno 全 = `SO-0xxxxx`；proceeded_at 全 = `so_date 08:00:00`。

2. 明细行 + DO/PO 关联计数：
   `... LEFT JOIN scm.delivery_order_items doi ON doi.so_item_id=i.id LEFT JOIN scm.purchase_order_items poi ON poi.so_item_id=i.id GROUP BY i.doc_no`
   → do_line_matches = 0（全部 13 张）；po_line_matches：004574/006002/006859/007676/010073/010397/010797 各 1，008772 = 2，其余 0；any_cancelled 全 false。

3. PO 状态：
   `SELECT ... FROM mfg_sales_order_items i JOIN purchase_order_items poi ON poi.so_item_id=i.id JOIN purchase_orders po ON po.id=poi.purchase_order_id`
   → 挂到的 8 个 PO 全 `RECEIVED`、全 2026-08-28 导入、from_mrp=false、received_qty=qty、各带一张 GR。

4. DO 表头反查：
   `SELECT so_doc_no,count(*) FROM scm.delivery_orders WHERE company_id=1 AND so_doc_no IN (...) GROUP BY so_doc_no` → **0 行**。

5. 审计聚合：
   `SELECT so_doc_no,count(*),min/max(created_at),string_agg(DISTINCT action),string_agg(DISTINCT source) ...`
   → 每单 2~27 行；action 只有 UPDATE_LINE/UPDATE_STATUS/UPDATE_DETAILS；source 只有 auto-allocation/automation/web。

6. 日期是否被改过：
   `... AND (field_changes::text ILIKE '%processing_date%' OR ILIKE '%customer_delivery_date%' OR ILIKE '%proceed%')` → **0 行**（证明处理日/交期/proceed 从未在 ERP 改动）。

7. web（人工）改动：
   `... WHERE source='web'` → 仅 004574/004965/008772 在 2026-09-10 15:16~15:17 由 `HOUZS CENTURY` 加了 `collaboratorStaffIds`，无日期/发货类改动。

8. 状态时间线：
   `... WHERE action='UPDATE_STATUS'` → 全部为 automation 的 `Auto-advanced ... (stock)` / `Auto-regressed ...` 来回跳；2026-09-11 14:31~15:38 一整批同步抖动；无任何人手状态变更。
