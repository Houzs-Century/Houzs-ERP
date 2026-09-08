## The allocator promised display, showroom and service stock to customers [medium]

**Symptom.** Nobody saw it, and that is the whole reason it was worth fixing on
2026-09-08 rather than later. `docs/bugs/0682` measured the exposure the day the
cutover landed: **9 non-selling warehouses in company 1 holding 1,897 units**,
**1,642** of them in the pooled class that allocates on on-hand alone, **all 9
active and all 9 in the order-entry dropdown** — and **0 sales-order lines
pointing at any of them**, so **0** lines were reading READY off display stock.
An open door with nothing through it yet. Every document raised after that date
could have attached to it.

Two of the nine are not showrooms at all and are worse: `KL SERVICE` and
`PG SERVICE` are `RETURNED TO SUPPLIER FOR SERVICE` — **56 pooled units that are
physically away at the supplier being repaired**, which the system would have
promised to a customer.

**Root cause (traced, by opening the files).** `so-stock-allocation.ts` step 6
read `inventory_balances` with **no warehouse predicate of any kind** and
bucketed strictly on the SO LINE's own `warehouse_id`, so a line pointing at
`KL DISPLAY` drew display stock and read READY. Neither that file nor
`sofa-set-coverage.ts` nor `so-line-effective-stock.ts` contained the strings
`showroom`, `display` or `warehouses.type`.

The axis was never missing from the ERP — only from the allocator.
`scm.warehouses.type` (mig 0177, enum `warehouse | showroom | display | service
| others`) already drove the dead-stock report, on the owner's own 2026-08-05
ruling 「我的 dead stock 里面怎么会有 dead stock 呢？因为它明明是 showroom 的
display 啊」. **The concept existed, one screen read it, the allocator did not.**

Re-measured before relying on it, read-only run **34177208009**, 2026-09-08
**09:36 (+08)**, company 1 — a doc is not evidence and a prior run is not this
run: **16 warehouses, 9 non-selling by `type`, the same 9 by name**, every one
carrying a correct type, so the rule bites on all nine and nothing needed
backfilling first. `SUNWAY SHOWROOM` is the ninth and holds 0 units, which is
why the per-warehouse table only lists eight.

**Fix.** The rule, in the rule layer. **No migrated row was touched** — the
owner's standing rule 「你换不一样就代表我们的数据从 autocount 搬过来的就不一样了
啊」 — and no quantity moved: what changed is what may be PROMISED, not what is
held.

- `lib/non-selling-warehouse.ts` is the ONE home for the three type names.
  `routes/inventory.ts` had the second copy; it now imports. That was not
  noticed by reading — `check-duplicated-decisions.mjs` failed the build with
  `D1 ... DISPLAY,SERVICE,SHOWROOM | 2 homes` and the fix was to delete a home,
  not to record an allowlist line.
- `so-stock-allocation.ts` gates **all three doors**, because gating one is how
  this class ships half-applied here: the pooled on-hand read, BOUND MODE (a
  line's own received PO, which never reads `inventory_balances` at all) and the
  SOFA dye-lot matcher (which does not either). `loadNonSellingWarehouses`
  THROWS on a read failure rather than answering with an empty set — an empty
  set is indistinguishable from "no warehouse is a showroom", and the wrapper
  turns the throw into a queued retry.
- `so-line-effective-stock.ts` gains a THIRD gate, `lineNonSellingWarehouse`,
  and it is the only one that **vetoes a stored READY**. The other two arbitrate
  between two ENGINES about where the goods are and must never veto; this is not
  an engine, it is the owner's rule about whether goods both engines can plainly
  see may be promised. Without the veto a stale stored READY would keep lighting
  the pill after the engine had stopped promising it — two surfaces disagreeing,
  which is the defect `so-line-effective-stock.ts` exists to remove.
- The gate is a REQUIRED field on `PromotionGates`, so the compiler enumerated
  the call sites instead of letting them keep the permissive answer: five, all
  five wired.
- **The refusal reaches a person, on both surfaces.** The line payload carries
  `non_selling_warehouse` with the server-composed sentence; the desktop pill
  prints `KL DISPLAY — transfer to sell` under PENDING with the full sentence on
  hover, and the phone prints the whole sentence (it has the room the 96px
  desktop column does not, and no way to hover). A correct refusal that tells
  nobody is `vendor/scm/lib/mutation-error.ts`'s 35 silent write paths wearing a
  different hat.

**Proved RED on the unfixed tree** —
`src/scm/lib/so-stock-allocation.display-warehouse.test.ts`, 8 cases, **5 failed
before the fix** (pooled mattress at a display warehouse READY, service
warehouse READY, bound bedframe READY, sofa dye-lot READY, company 2 READY) and
**3 passed**, those three being the guards that the same lines at a SELLING
warehouse still light. All 8 green after.

**Selling a display piece is still possible** — through a stock transfer into a
selling warehouse, which is how SAP, Odoo and NetSuite all model it: what a
warehouse HOLDS and what may be PROMISED are two different numbers. The path
exists on both surfaces already (`/scm/stock-transfers/new` and
`mobile/MobileStockTransferNew.tsx`), so this adds a step, not a wall.

**Ref.** fix/display-warehouse-allocator, 2026-09-08. Supersedes the
"Fix: none here, by intent" in `docs/bugs/0682`.
