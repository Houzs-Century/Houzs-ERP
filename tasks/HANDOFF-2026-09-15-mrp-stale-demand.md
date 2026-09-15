# Handoff 2026-09-15 (evening) — MRP 占着已送货的单 + 当天其它未完事项

Written 2026-09-15 ~13:40Z. Every number below comes from a run named next to it.
Re-run before quoting it again (working agreement R07).

## 1. 老板最后的问题（原话）

> 为什么很多明显都出货了，还在占用着 MRP 的库存？…一百多个显示过期，可是明明都已经送货出去了，怎么会过期呢？
> 你查看一下 MRP 的规则和计算方式，看看是不是有 bug，还是规则设置有问题？
> 我记得之前是没有这些 order 的…怎么突然又冒出来了？
> 你可能要去查看一下 AutoCount 那边原本是怎么样的，看它会不会有可能是 partial delivery，然后是不是真的有 processing date。
> 开了 DO 的东西就代表已经不需要这个货了…SO outstanding 需要根据 delivery date 来排…既然它是没有需求的，就不应该进 MRP 啊！
> 一百多张单怎么可能呢？之前是怎么做的？我前几天都没看到啊！

**Not answered to him yet.** The numbers are measured (section 2); the options in section 3 still need his pick.

## 2. 查到的事实

Tool: `backend/scripts/check-mrp-stale-demand.mjs` with `.github/workflows/check-mrp-stale-demand.yml`.
- It is read-only and runs the canonical `computeMrp`.
- It joins each line to the AutoCount book snapshot `backend/scripts/data/ac-convert-edges.json.gz` (exported 2026-09-09).
- Production run: **34974433208** (branch dispatch). The artifact `mrp-stale-demand` holds every line.

### 2.1 MRP 现在还在为多少行备货（company 1, today 2026-09-15 MYT）

| 交货日期 | 行 | 单 | 数量 | 分到的现货 |
|---|---|---|---|---|
| 没有日期 (UNDATED) | 11,269 | 2,208 | 18,468 | 2,843 |
| 未来 (FUTURE) | 2,068 | 406 | 3,189 | 2,171 |
| 已过期 (EXPIRED) | 429 | 122 | 657 | 634 |

- **The 122 expired orders are the same 122 as the report sent earlier today.** The engine and `report-expired-so.mjs` agree.
- **PROVEN: MRP already counts a DO that is linked only by its header SO number.** See `backend/src/scm/lib/do-unlinked-coverage.ts`. So "DO lines not linked" is NOT the cause.

### 2.2 过期那 122 张，AutoCount 账本怎么说（PROVEN, run 34974433208）

| 账本 (AutoCount) | ERP 交货单 | 有 processing date | 行 | 单 |
|---|---|---|---|---|
| 账本也没送 (BOOK_OPEN) | 整张单没有 DO | 有 | 343 | 77 |
| 账本也没送 | 同张单有别的 DO，这行没上 | 有 | 28 | 24 |
| 账本也没送 | 这行在 DO 上但 **DO 行数量是 0** | 有 | 11 | 8 |
| **账本已送完 (BOOK_DELIVERED)** | ERP 没有这张 DO | 有 | 32+7+1 | 12 |
| 账本部分送 (BOOK_PARTIAL) | 行在 DO 上 | 有 | 4 | 3 |
| 账本里找不到这行 | 没 DO | 有 | 3 | 2 |

Reading the table:
- **All 122 have a processing date and a delivery date**, and both came from AutoCount. `mfg_sales_orders.processing_date` is set on every expired order.
- **109 of 122 are still OPEN in AutoCount too**: the SO line `TransferedQty` is 0 or short. AutoCount never closed them, and the ERP copied the book faithfully.
  - HC-SO-006089 is the example. In the book, SO-006089 lines NB-KHJ35 (Q) x2, AK-ARMOUR MATT (Q) x2, NB-KHJ35 (K) x1 and AK-ARMOUR MATT (K) (dtlkey 423324) all have TransferedQty 0.
  - DO-004868 carried only the other four lines. The book itself holds this order as a partial delivery.
- **DO lines with qty 0.** AutoCount staff put an item on the DO at quantity 0: inspect-so-lines run on HC-SO-000524 / 001030 / 009600.
  - HC-DO-000608 lists TRION / VALKYRIE / SIMPLE bedframes at qty 0.
  - HC-DO-001526 lists AK-SK CT MEM FOAM PIL at qty 0.
  - HC-DO-008833 lists AMN-SOFA PILLOW at qty 0.
  - By the owner's rule 「开了 DO 的东西就代表已经不需要这个货了」, these lines are done. The engine counts qty 0 as nothing delivered.
- **12 orders are delivered in AutoCount but have no DO in the ERP**: HC-SO-011850 013276 001319 002069 003945 013181 009774 007144 000517 012025 012629 011571. This is an import gap.

### 2.3 「之前没有，怎么突然冒出来」

- **PROVEN — they did not newly appear.**
  - 405 of the 429 expired lines have `created_at` 2026-08-28, the AutoCount re-import round. The rest are 09-03..09-12.
  - Every order cleared by the 09-11 run 34608366948 and by the 09-15 clear-stale-dates run is still cleared (no delivery date, no processing date) in run 34974433208:
    - HC-SO-000015 001112 001180 001472 001473 001526 001640 001920 002281 002366 003189 004197 004391 004716 006438 007435 007958 008460 008586 010504 012435 013319 013339 013361 013394 013505
  - Nothing put their dates back.
- **The 09-11 cleanup covered only the 14 orders on his list.** No step ever swept all expired orders. The 122 have sat in MRP since 08-28 with their AutoCount dates.
- **UNKNOWN: why he did not see them on screen before.** Two readings, not settled:
  - Header `updated_at` of the 122: 37 on 09-12, 14 on 09-10, 14 on 09-08, 20 still 08-28. That does NOT show a date changed.
  - To settle it, compare `processing_date` / `customer_delivery_date` / line dates against `backend/scripts/data/ac-delivery-dates.json.gz` (exported 09-11) and the SO audit/change log for 09-08..09-15.
  - If no date changed, the rows were visible all along (the page sorts by delivery date), and nobody looked at the overdue end.

### 2.4 比过期更大的：没有日期的 2,208 张

- 11,269 lines / 2,208 orders are CONFIRMED with no delivery date and no processing date (29 exceptions). 99% came in on 08-28.
  - By year: 1,173 lines from 2024 and 32 from 2023.
  - AutoCount state: all BOOK_OPEN except 320 lines not found in the book.
- The MRP page hides them by default (`includeUndated`). **But the engine still allocates on-hand stock to them after the dated lines:** 2,843 units read as "assigned" in the stock-assigned / dead-stock view.
- This is the same class as the 122: the book never closes its sales orders, and the go-live import took "outstanding in the book" literally.

## 3. 给老板的选项（已选，见 3b）

Rule the owner already stated: **a line that went onto a DO needs no more goods; only real outstanding SO lines, ordered by delivery date, are MRP demand.**

- **A — 规则（程序）: a DO line counts as done even at qty 0.**
  - Change `soDeliverableRemaining` / `netDeliveredBySoItem` so a line on a live DO at qty 0 counts as fully served.
  - Cost: small code change plus a bug entry.
  - Effect: 11 expired lines and 7 undated lines leave MRP.
- **B — 资料（结单）: close the lines nobody will deliver, with a plan/apply tool.**
  - It sets a line "closed/short-closed" (or cancelled) with an audit row and never deletes. Buckets:
    1. The 12 orders AutoCount shows delivered.
    2. Lines on a DO at qty 0.
    3. Remaining lines of orders that already had a DO (28 lines / 24 orders).
    4. Expired orders with no DO at all (343 lines / 77 orders): a list for him to tick, or close everything whose delivery date is older than N days.
  - Also the 2,208 undated orders: close by order age (for example, SO dated before 2026-06 with no DO and no processing date), after he agrees on the cut-off.
- **C — MRP 只算有 processing date 的单.**
  - Undated / unprocessed lines stop taking stock in the allocation. They stay visible in a separate list.
  - This touches the owner ruling "gate on DELIVERY date" (memory `mrp-rulings-2026-09-09`), so it needs his explicit OK.

**Recommendation: A + B now (B buckets 1-3 without asking further — they match his stated rule; bucket 4 and the undated cut-off as a list for his pick), then decide C.** "MRP 几时正常" = after B's apply. The tool build is about half a day including plan run.

## 3b. 老板的决定（2026-09-15 ~13:45Z，覆盖第 3 节的建议）

Written down in memory `owner-rulings-2026-09-15-mrp-processing-gate`.

- **C accepted.** Owner: 「MRP 可以添加只算有 Processing date 单的功能吗？不过需求的顺序排给谁，是根据 Delivery Date 来排的。也就是说，没有 Processing date 的单子就不进来。」
  - An SO with no processing date is not MRP demand at all: no allocation, no stock claim, no shortage.
  - Priority among processed orders stays by delivery date.
  - For what ENTERS MRP, this supersedes "gate on DELIVERY date".
  - In flight: agent on branch `feat/mrp-processing-date-gate`. It will put one shared rule behind every consumer, with tests RED→GREEN and before/after production counts.
- **A rejected.** Owner: 「这个 0 其实就是代表没送货的意思，是对的，之前也都是对的」.
  - A DO line at qty 0 = NOT delivered. The engine stays as it is.
  - Bucket 2 of B is therefore only counted, never closed.
- **B: 「可以跑看」 — PLAN only.** Agent on branch `chore/close-stale-sales-orders`.
  - Tool: `close-stale-sales-orders.mjs` / `.yml`.
  - Buckets 1 / 3 / 4 are planned. Bucket 2 is counted only. Bucket 5 is counted by SO month.
  - First the agent researches what setting an order to CLOSED touches: AutoCount write-back, commission, payments, the per-line freeze, the header version and `mfg_so_audit_log`.
  - The Excel file 结单模拟清单20260915.xlsx goes in the owner's Downloads folder.
  - **No apply without the owner's yes.**
- **Still open, and the owner insists on an answer.** Owner: 「那为什么之前我没有看到这些订单呢？…现在突然跑出来 100 多张单，是什么问题呢？」
  - "They were imported on 08-28" was NOT accepted as the answer.
  - An investigator agent is tracing WHEN the 122 orders became dated MRP demand. Candidates:
    1. dates filled later by backfill runs, or by the AutoCount line-delivery-date pull (#3633 / #3636, 09-11);
    2. status changes;
    3. MRP UI or engine changes;
    4. the header `updated_at` spikes on 09-08, 09-10 and 09-12.
  - The answer must be a timeline with evidence for each step.

## 4. 当天其它事项的状态

| 事项 | 状态 | 证据 / 下一步 |
|---|---|---|
| HC-SO-011045 STOOL 1 x2 拆成 1 MEKA-04 + 1 MEKA-06 | **DONE** | split-colour-lines apply run 34970795351, VERIFY OK (5 rows split) |
| HC-PO-010086 第 2 行改回 AMN-SOFA PILLOW | **DONE** | PR #3974 merged; realign apply run 34973159743 wrote 1 line + 1 audit row. Supplier code was CLEARED (no supplier code for that item): set it before sending the PO. The LIST run 34973345241 says 3 live PO lines differ in code from their SO line — not reviewed. |
| Import SKUs 改分类连型号一起换 | **MERGED** PR #3976 (`b0019929`, bug 0938); Deploy 34975887931 backend success | live import UNTESTED. OPEN owner question: a full export with one SKU's category edited is REFUSED for that model (conflict rule). Recommended: the changed row wins and rows repeating the old category count as unchanged. Awaiting his pick. |
| Edit 时行顺序乱 + MRP 颜色 | PR **#3978** open | merge origin/main locally (never "Update branch"), CI, merge, confirm Deploy. The agent stopped while waiting on CI. |
| 改 SKU 代码没跟着改的地方 | **MERGED** PR #3980 (bug 0939) | confirm its Deploy run; the colour-printed-twice / Description 2 over 100 characters finding is not yet reported to the owner |
| MRP stale-demand check tool | **MERGED** PR #3981 (`9ccc59f2`) | dispatch `check-mrp-stale-demand.yml` from main once (R50) |
| HC-PO-010041 key repair | waiting | needs an AutoCount snapshot <= 2 days old |
| HC-SO-012046 / 013224 supplier code; PO lines without SO (HC-PO-009630, 009940) | open | owner decision 3 (stock adjustment) |
| Shared-bucket refusals (per-lot moves), HC-PO-010170 follow-up | open | — |
| AutoCount edit on split orders 012927 / 012046 | **UNTESTED** | — |
| Leftover worktrees / temp branches | open | `.claude/worktrees/agent-*`, `houzs-work-worktrees/*` of merged PRs |

Other session's open PRs (not this session): #3977 (SO consecutive save), #3979 (AutoCount night handoff), #3972 (DO export).
