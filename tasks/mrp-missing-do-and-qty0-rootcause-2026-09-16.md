# 根因报告：交货单缺失 + 数量为 0 的交货单行 (2026-09-16)

READ-ONLY 调查。没有改任何生产数据、没有改代码、没有 merge。
数据来源：生产库 Supabase `anogrigyjbduyzclzjgn`（"HOUZS ERP SG"，CLAUDE.md R89 确认为生产）；
代码 worktree `houzs-work-worktrees/handoff-0915-update`；AutoCount 快照 `backend/scripts/data/`。
标签遵循 R02：**PROVEN**（跑过、附输出）/ **LIKELY** / **UNKNOWN**。

---

## 先把数据模型讲清楚（两套表，很容易搞混）—— PROVEN

一开始我查错了表。这套系统对同一个概念有**两套表**：

| 概念 | 运营用的真表（App 读写） | 只读镜像表（参考用） |
|---|---|---|
| 销售订单 SO | **`scm.mfg_sales_orders` / `_items`**（有 status、cancelled、linked_do_doc_no、金额） | `public.sales_orders`（AutoCount 扁平镜像，`services/pull.ts` 每日 cron 写入，只给 ASSR/健康检查/财务查参考） |
| 交货单 DO | **`scm.delivery_orders` / `scm.delivery_order_items`**（真正的 ERP 交货单，有行、有数量） | `public.autocount_delivery_orders`（**只有表头、没有行、`so_doc_nos` 永远是 NULL**，只给 ASSR 列表显示 DO 号） |

- App 用的是一个 **scm-schema 作用域的 Supabase client**，所以 `.from('mfg_sales_orders')` 实际打到 `scm.mfg_sales_orders`
  （证据：`backend/src/scm/routes/delivery-planning.ts:8-10`）。
- `public.mfg_sales_orders` / `public.delivery_orders` 是空壳（0 行）——不要在 `public` 里量它们，会得出错误结论。
- 公司 1（Houzs Century，HC- 前缀）和公司 2（2990）**共用同一套 `scm` 表**，靠 `company_id` + 文档号前缀区分，
  没有分表、没有视图切换（`scm/lib/companyScope.ts:514-565`，`DOC_PREFIX_BY_COMPANY = { HOUZS: "HC-" }`）。

生产计数（PROVEN，2026-09-16 现查）：

```
scm.mfg_sales_orders        3135  (公司1: 2960)
scm.mfg_sales_order_items  16236
scm.delivery_orders          351  (公司1: 286 = 173 migrated_no_stock + 113 现场开的)
scm.delivery_order_items    1559
public.sales_orders         3693  (镜像)
public.autocount_delivery_orders 11276 (只有表头, so_doc_nos 100% NULL)
```

---

# 问题 1：AutoCount 已经交货的 SO，为什么 ERP 里没有交货单？

## 白话文根因（R11）

**导入的时候是故意只搬"还没交货"的订单，而且那次导入根本没有生成任何交货单；已经交货的部分是靠一个"一次性补单"脚本补进来的。
这条 AutoCount→ERP 的交货单路线没有自动化——平时的定时同步只抄表头到镜像表，不会在 ERP 里生成交货单。
所以：一张订单在 go-live 那一刻是"未交"被搬进来，之后 AutoCount 把它交了货，只要没人再手动跑一次补单脚本，
ERP 这边就永远显示"未交、没有交货单"。**

例子里的 6 张单（HC-SO-003945 / 011850 / 012629 / 007144 / 013181 / 013276）就是这一类，本 session 已全部改成 CANCELLED。

## PROVEN 证据

**(a) go-live SO 导入只搬 outstanding，且不建任何 DO** — `backend/scripts/import-ac-outstanding-so.mjs`
- 文件头 `:1-3`：*"One-time GO-LIVE import: AutoCount OUTSTANDING Sales Orders -> ERP scm.mfg_sales_orders/_items/_payments for company 1"*。
- `:177-188` 明确丢掉已全交的订单（业主 2026-08-10 规则："outstanding 指的是还没有转成 DO"）：
  - `:184` `const fullyDelivered = (ls) => ls.length > 0 && !ls.some((l) => qn(l.Qty) > qn(l.TransferedQty));`
  - `:186-188` `if (process.env.ALLOW_DELIVERED !== "1") { ... orders.delete(doc); skipDelivered++; }`
  - `:321` 报表行 `"skipped fully-delivered (already a DO, owner's rule)"`。
- `:447-449` 只 INSERT `scm.mfg_sales_orders / _items / _payments`——**整段导入没有任何一行建交货单**。

**(b) 已交货的部分靠一次性脚本补** — `backend/scripts/create-migrated-documents.mjs` `doDos()` `:219-397`
- *"delivery orders for the part AutoCount already delivered — WITHOUT moving any stock"*；来源 `data/ac-partial-dos.json.gz`（369 行）。
- 每张表头盖 `migrated_no_stock = true`，不动库存。
- 只覆盖**导入时仍未结清**的订单的部分交货；全交订单没有 SO，也就没 DO。

**(c) 没有自动 DO 同步（这是结构性缺陷）** — PROVEN
- 平时的 Cloudflare Worker cron 只写镜像表：`services/pull.ts` → `public.sales_orders`（SO 表头镜像）；
  `services/doMirror.ts` → `public.autocount_delivery_orders`（DO 只有表头，`so_doc_nos` 保持 NULL，见 `migrations-pg/0215_autocount_do_mirror.sql`）。
- 往 `scm.delivery_orders` 建 DO 的只有两处：`create-migrated-documents.mjs`（一次性 cutover）和
  `sync-ac-delta.mjs` 的 `do` lane（**手动** go-live 追单，`:46-51`，工作流 `.github/workflows/sync-ac-delta.yml` 标注 *"Manual"*）。
  `sync-ac-delta.mjs:829-830` 里那两行诊断 `"AutoCount now shows FULLY delivered / PARTLY delivered"` 找的正是 Q1 这一类。

**(d) 生产现状量化（R13，2026-09-16 现查 + 2026-09-09 AutoCount 快照 `ac-convert-edges.json.gz`）**
- 公司 1 有 **2,693 / 2,960** 张 SO 在 ERP 里没有任何交货单。
- 把这 2,693 张跟 AutoCount 交货图对齐：
  - **2,610** 张 AutoCount 也没交货 —— ERP 显示未交是**对的**，不是 bug。
  - **78** 张是 ERP 原生单（HC-SO-2609-xxx，没有对应 AutoCount SO）—— 不适用。
  - **5** 张 AutoCount 已**全部交货**却在 ERP 里没有交货单 —— 就是例子里那 5 张，现在都是 CANCELLED。
- 第 6 张 HC-SO-013276：现查它其实**有 1 张 scm DO**（本 session 补的），所以不在"无 DO"名单里；它也是 CANCELLED。
- 6 张例子在 AutoCount 快照里全部 q/tq 相等（逐行 100% 已交），例如 `SO-003945` 7 行全 `1/1`、`SO-011850` 11 行全等。
- `linked_do_doc_no` 对**所有**公司 1 SO 都是 NULL —— SO→DO 的正向链接字段从来没被填过；ERP 靠反向的 `delivery_orders.so_doc_no` 认亲。

**结论：历史 + 结构性复发（PROVEN）。**
- *历史*：go-live 只搬 outstanding、不建 DO，是业主定的规则（by design）。
- *结构性复发*：没有自动 DO 同步，AutoCount 在追单之后新交的货不会进 ERP。目前"已交却无 DO"的急性个案（5 张）本 session 已清（改 CANCELLED），
  当下非 cancelled 的这类 = 0；但只要 AutoCount 继续交货而没人跑追单脚本，它会再长出来。这不是一次性数据坏了，是缺一条自动化管线。

## 一个正常 ERP 会怎么做（R17）+ 选项（R18/R19）

正常 ERP（AutoCount / SAP / Odoo）里，SO→DO 是同一个库内的实时事务，不存在"外部系统交了货本系统不知道"。
我们的特殊性在于 **AutoCount 才是记账真源，ERP 是它的下游镜像**，而这条镜像目前只做了表头、没做交货明细。

- **选项 A（止损，低成本）：把 `sync-ac-delta.mjs` 的 `do` lane 变成定时任务。**
  现成脚本，改成 cron（例如每天一次，`?since=` 窗口，R10 禁用 `?mode=all`）。
  代价：小（≈0.5 天）。风险：低（`migrated_no_stock=true` 不动库存）。缺点：仍是"批量补"，不是实时；补单会带进 §问题2 的 qty-0 行。
- **选项 B（正解，中成本）：给 `doMirror.ts` 补上 DO 明细拉取，并在镜像更新时把 `scm.delivery_orders` 建/补齐。**
  `0215` 迁移文件自己写了 *"so_doc_nos stays NULL until a detail-enrichment pass lands (future work)"* —— 就是这块没做完。
  代价：中（≈2-3 天，含明细拉取 + 幂等 upsert + 测试）。风险：中（要防重复建单，靠 `linked_ac_docno` 幂等）。缺点：要动 Worker 同步路径。
- **选项 C（业主判断，非技术）：接受"全交订单不进 ERP"，把 ERP 定位成只管 outstanding + 生产/采购。**
  代价：0。缺点：ERP 的交货/历史永远不完整，跟 AutoCount 对不齐时得人工判断。

**建议：A 先止血（把追单变定时，几天内消化积压），并排期 B 做成正解**（补完 `0215` 说的 detail-enrichment）。
是否要 ERP 持有全部历史交货，属业主定位判断（R21）。

---

# 问题 2：为什么会有数量为 0 的交货单行？

## 白话文根因（R11）

**这些"数量 0"的行是从 AutoCount 原封不动抄过来的——AutoCount 自己的交货单里就有这种行。
AutoCount 部分交货时，交货单文件会把订单上所有的行都列出来，还没交的那几行数量写 0。
迁移脚本忠实照抄了本子里的数量（0 就是 0）。ERP 现场手动开交货单的那条路根本不允许数量 0，所以这纯粹是迁移遗留，不是现在还在产生的。**

例子 HC-DO-000608（3 行 qty 0）/ 001526 / 002817 / 008624 / 008833，跟 AutoCount 本子逐行对得上。

## PROVEN 证据

**(a) 生产里 qty-0 行的全貌（2026-09-16 现查）**
- `scm.delivery_order_items` 共 1,559 行，其中 **17 行 qty = 0**，分布在 **12 张 DO** 上。
- 这 17 行**全部**带 `linked_ac_dtlkey`（都来自 AutoCount 迁移，没有一行是现场开的）。
- 这 17 行**全部**落在 `migrated_no_stock = true` 的 DO 上（`join` 分组结果：`{migrated_no_stock:true, qty0_lines:17}`）。

**(b) AutoCount 源头本来就有 qty-0 行** — 快照 `ac-fidelity-do-lines.json.gz`（47,329 行 DO 明细）
- **1,447 / 47,329（3.1%）** 的 AutoCount DO 明细行 Qty = 0；**708 张** DO 表头带有至少一条 qty-0 行；没有一张 DO 是整张全 0。
- 例子逐张对上（ERP `scm.delivery_orders` 现查 vs 快照）：

  | ERP DO | linked_ac_docno | so_doc_no | 行数 | qty0 行 | migrated_no_stock |
  |---|---|---|---|---|---|
  | HC-DO-000608 | DO-000608 | HC-SO-000524 | 10 | 3 | true |
  | HC-DO-001526 | DO-001526 | HC-SO-001030 | 2 | 1 | true |
  | HC-DO-002817 | DO-002817 | HC-SO-002792 | 4 | 2 | true |
  | HC-DO-008624 | DO-008624 | HC-SO-008652 | 8 | 1 | true |
  | HC-DO-008833 | DO-008833 | HC-SO-009600 | 2/3 | 1 | true |

  qty-0 的行是枕头、加大尺寸床垫、抱枕这类随单列出但当次没发的配件（例如 DO-000608 的 `NB-NH39(A)(K)`、`NK-1045 (Q)` 都是 Qty 0）。
  （注：任务描述里写的 "TRION/VALKYRIE/SIMPLE" 与实际行名对不上，实际是上述配件；文档号和 qty-0 计数完全对得上。）

**(c) 迁移脚本照抄本子数量** — `backend/scripts/lib/migrated-do-writer.mjs:260`
```
byDo.get(r.DoNo).items.push({ code: t.item_code, name: r.LineDesc, qty: Math.round(Number(r.Qty || 0)), ... });
```
`r.Qty` 是 AutoCount 本子的**已交数量**；本子写 0 就存 0。插入在 `:419` `VALUES (... ${it.qty} ...)`。
它是"按已交行匹配 SO 行"，**不是**"把所有未交 SO 行都铺一遍"——所以 qty-0 只来自本子本身就是 0 的行。

**(d) 现场开单路径禁止 qty ≤ 0** — `backend/src/scm/routes/delivery-orders-mfg.ts:3691`
```
if (!(q > 0)) continue;
```
外加 `:3808 / :3368` 的 `over_remaining`（1..剩余）。所以通过 ERP UI 无法产生 qty-0 行。

**结论：纯历史（PROVEN），不复发。**
qty-0 行只出现在迁移的 `migrated_no_stock` DO 上、全部带 `linked_ac_dtlkey`；现场路径按代码不可能产生。
只有"再跑一次迁移/追单脚本引入新的 migrated DO"时才会再带进 qty-0 行（AutoCount 源里还有 1,447 条候选）。

## 影响 + 选项（R18/R19）

影响面小但会误导：一条 qty-0 的 DO 行会让对应 SO 行"看起来上了交货单"其实没发货
（`derive-do-so-item-id.ts` 用 `so_item_id` 做剩余量/SO 状态/ MRP 净额判断，qty 0 会占位）。

- **选项 A（数据清理，低成本，推荐）：删掉这 17 条 qty-0 迁移行。**
  它们代表"没发的货"，对 SO 剩余量/ MRP 是纯噪音；删掉让 SO 行回到"未交"。
  做法：写一个符合 R85 的 `backend/scripts` 脚本（默认 plan / APPLY 门 / CONFIRM / 新连接复核形状 / RE-RUN 头），
  只删 `qty=0 AND linked_ac_dtlkey IS NOT NULL AND` 父单 `migrated_no_stock`，删前后各点一次数（现在 17）。
  代价：≈0.5 天。风险：低（不动库存、不动金额；这些行 line_total 也是 0）。**需业主拍板**：是删除还是保留作"本子长这样"的存档（R21，属判断）。
- **选项 B（源头收紧，配合问题1选项A/B）：在 `migrated-do-writer.mjs` 建行前跳过 `Qty <= 0` 的本子行。**
  防止未来追单再带进 qty-0。代价：小（≈2 行 + 测试）。风险：低。缺点：单独做不清历史，要配 A。
- **选项 C：什么都不做，忠实镜像 AutoCount。**
  代价：0。缺点：SO 剩余量/ MRP 继续被这 17 条占位噪音干扰。

**建议：B（收紧源头，避免复发）+ A（清掉现有 17 条），A 需业主同意删除。**

---

## 复现命令（R07/R15）

- 生产计数：Supabase MCP `execute_sql`，project `anogrigyjbduyzclzjgn`，例如
  `select count(*) filter (where qty=0) from scm.delivery_order_items;`（→ 17）。
- AutoCount 快照分析：`node`（zlib gunzip）读 `backend/scripts/data/ac-fidelity-do-lines.json.gz`（qty0 = 1447/47329）
  与 `ac-convert-edges.json.gz`（2026-09-09，SO 全交 10,587 / 13,384；逐行 `[docNo,dtlKey,seq,itemKey,qty,transferedQty,...]`）。
- 代码：`import-ac-outstanding-so.mjs:177-188,447-449`；`create-migrated-documents.mjs:219-397`；
  `lib/migrated-do-writer.mjs:260,419`；`delivery-orders-mfg.ts:3691`；`services/pull.ts`；`services/doMirror.ts`；
  `migrations-pg/0215_autocount_do_mirror.sql`；`sync-ac-delta.mjs:46-51,829-830` + `.github/workflows/sync-ac-delta.yml`。

*未实施任何修复（本报告为只读调查 + 提案）。*
