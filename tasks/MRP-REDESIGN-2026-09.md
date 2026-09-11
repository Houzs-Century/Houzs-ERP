# MRP redesign — living handoff (started 2026-09-11)

Owner-driven rework of the MRP · Stock Status Report and how it opens POs. Keep
this current: if you finish or start a piece, edit the status here in the SAME
PR. A stranger should be able to take over from this file alone.

Owner rulings captured in memory: `~/.claude/.../memory/mrp-combine-perso-rules-2026-09-11.md`.
Proposal + UI mockup artifact (owner-facing): the "MRP 整单转 PO" artifact.

## STATUS AT A GLANCE (2026-09-11)

**Everything the owner approved is MERGED and on production.** Confirmed by
`gh pr view` (not memory) and a successful deploy whose head contains the
lead-time work. What is NOT built is the fuller sales-order *view* the mockup
(§06) drew — see "What is left for the next person". The readiness verification
the owner asked for ("确定没问题吗") is Track D below.

| PR | What it shipped | Merged |
|---|---|---|
| #3596 | Others becomes a permanent 5th tab (stops the blink-in on load) | 2026-09-10 |
| #3602 | Per-category Combine/Per-SO PO grouping (owner re-spec) | 2026-09-10 |
| #3606 | Revive dead sofa-cover pull-in, show riders, add MRP search | 2026-09-10 |
| #3601 | Read-only MRP grouping-facts diagnostic | 2026-09-10 |
| #3608 | Manual per-supplier x category lead time (highest priority) | 2026-09-10 |
| #3612 | Read-only SO-readiness check (mattress + accessory) | 2026-09-11 |
| #3616 | Fix: SO-readiness check crashed on an enum coercion | 2026-09-11 |

## The two tracks the owner approved (2026-09-11)

### Track A — Combine/Per-SO re-spec + Sales-Order view

Owner's per-category rule (supersedes 2026-07-17). One global toggle:
- **Per-SO**: every `(SO, category)` its own PO — a sofa order's accessories split off.
- **Combine**: sofa + its accessories (皮套/pillow) on ONE PO; bedframe per-SO
  either way (same supplier + one SO -> one PO, even 2-3 bedframes); mattress
  merges within the delivery WEEK (window KEPT — owner picker 2026-09-11);
  standalone accessory merges same-supplier across SOs.

| Step | State | Where |
|---|---|---|
| A1. Grouping logic rewrite (`po-grouping.ts` `groupKeyFor` + convert wiring `sofaSoDocNos`) + tests | **MERGED + DEPLOYED — PR #3602** | `backend/src/scm/lib/po-grouping.ts` |
| A2. MRP search + sofa cover rides VISIBLY + the pull-in bug fix | **MERGED + DEPLOYED — PR #3606** | `frontend/src/pages/scm-v2/Mrp.tsx` |

**A2 finding (the crux).** `gatherSofa`'s accessory pull read `data.skus`, but the
Sofa tab requested `?category=SOFA`, which strips every non-sofa row — so the
pull matched NOTHING and the cover never rode from the MRP page. Dead since the
2026-06-15 per-category tab split. A2 fixes it: the Sofa tab now requests the
full plan (no category filter), which also serves the stored snapshot instantly.
Bug ledger `docs/bugs/0801-mrp-sofa-cover-pull-in-was-dead-since-the-per-category-tab-s.md`.

A2 delivers: search box (all tabs); cover/pillow riders SHOWN under each sofa SO
with a Combined/Per-SO caption; selection scoped so ONE sofa order pulls only
THAT order's cover; the existing Proceed-PO on a selected sofa SO now converts
the whole order (sofa + cover) — the "整单转 PO" the owner wanted, delivered
surgically. NOT built: the standalone cross-category all-SO grouping VIEW the
mockup drew — see "What is left".

### Track B — Lead time: supplier × category manual override (highest priority)

Owner 2026-09-11: he sets, per supplier, that supplier's per-category lead time;
it takes PRIORITY over the category base table. `PO delivery date = customer date
- lead days`.

| Step | State | Where |
|---|---|---|
| B1. New table for supplier×category lead days | **MERGED + DEPLOYED — PR #3608** | `migrations-pg/20260911T0900_scm_mrp_supplier_category_lead_times.sql` |
| B2. Resolver: supplier×category OVERRIDES base (highest priority) | **MERGED + DEPLOYED — PR #3608** | `scm/lib/lead-time.ts` (`loadSupplierCategoryOverrides` + override layer in `resolveLeadDays`); call sites `mrp.ts`, `mfg-purchase-orders.ts` |
| B3. Supplier page UI + endpoints | **MERGED + DEPLOYED — PR #3608** | route `mrp-supplier-lead-times` (GET/PUT/DELETE); FE `SupplierLeadTimes.tsx`, a "Lead Times" tab on the supplier page |
| B4. Confirm base table has data (read-only) | DONE — diagnostic §1 (sofa/bedframe=7, accessory/mattress=0, no per-warehouse overrides) | Track C |

Track B ships as a NO-OP until the owner enters a supplier override (empty table
= base wins). The override REPLACES the base layer; learned buffers still add on
top. The mockup's "要新建" chip for this is now STALE — it is built.

### Track C — Read-only diagnostics (owner asked to "run the check")

PR #3601 (`diag/mrp-grouping-facts`) — read-only. Reports: (1) base lead-time
table contents; (2) which category sofa covers/pillows sit in (answers "皮套 in
accessories?" — yes, ACCESSORY); (3) bedframe SOs split across POs, classified
different-supplier (correct) vs same-supplier (the separate-batch limitation).
**MERGED + dispatched.** Findings recorded in memory `mrp-grouping-facts-2026-09-11.md`.

### Track D — Readiness verification: "确定没问题吗" (owner, 2026-09-11)

Owner's two-part question: (1) if a MATTRESS/ACCESSORY line already has stock
allocated, does the SO line turn READY? (2) if the item line has been received,
by right it should turn READY — are you sure?

Verified against LIVE production, not assumption, with a read-only check.

| Step | State | Where |
|---|---|---|
| D1. Read-only check + workflow | **MERGED — PR #3612** | `backend/scripts/check-so-readiness-facts.mjs`, `.github/workflows/so-readiness-facts.yml` |
| D2. Enum-coercion crash fix (first prod run was RED) | **MERGED — PR #3616** | one-line SQL: `r.status IS DISTINCT FROM 'CANCELLED'` |
| D2b. Fix a 2nd enum coercion (warehouse_type) | **MERGED — PR #3618** | same class as #3616 |
| D2c. Model the processing-date gate + FIFO contention (raw check over-counted 8,328) | **MERGED — PR #3620** | `check-so-readiness-facts.mjs` |
| D3. Dispatch + read the answer | **DONE — run 34559704923, green, 2026-09-11** | see Result below |

**What the check answers.** SECTION 2 is THE answer: pooled (mattress+accessory,
non-SP) lines that are PENDING/PARTIAL while enough matching stock already sits
in their own SELLING warehouse under a blank variant key — i.e. lines that
*should* have flipped READY but did not. 0 = the engine keeps up (yes, a stocked
mattress/accessory line does turn ready). >0 = the list of stuck lines. SECTION
3 classifies the rest by the legitimate reasons a stocked line stays PENDING
(genuinely short / non-selling warehouse / no warehouse / has specials).

**Why the first run (34556592005) was RED and produced no answer.** The check's
`returned` CTE guarded cancelled returns with `COALESCE(r.status, '') <>
'CANCELLED'`. `delivery_returns.status` is enum `delivery_return_status` (NOT
NULL), so COALESCE cast the `''` literal to the enum at plan time — `''` is not a
label — and the whole statement errored before touching a row. Because a red job
means "the check broke" (not "0 stuck"), it was NOT an answer. PR #3616 replaced
it with `IS DISTINCT FROM`. Bug ledger `docs/bugs/0804-*`.

**How to re-run it (owner-safe, no console):** GitHub -> Actions -> "SO readiness
facts (read-only)" -> Run workflow (company defaults to 1). Read-only, own
concurrency group, never displaces a deploy. It reads `main`, so any fix to the
script must merge before the run reflects it (that is why the enum fix needed
its own merge before D3).

**Result (PROVEN — run 34559704923, company 1, 2026-09-11).** The engine is
working. Of 10,298 live pooled mattress/accessory lines: READY 1,356, PARTIAL
10, PENDING 8,932 → 8,942 not-ready. Those 8,942 break down as:

- **8,481** — SO has NO processing date yet → allocator skips it by the owner's
  own 2026-08-10 rule. Correctly PENDING, not a fault.
- **447** — bucket demand exceeds on-hand (FIFO / waiting for restock). Not an
  engine fault; not enough stock.
- **0** non-selling warehouse, **0** no-warehouse, **0** special-order.
- **14** — SECTION 2, the ONLY genuine anomaly: processing-dated, non-special,
  selling warehouse, bucket NOT contended (own-warehouse on-hand covers all its
  non-gated demand), yet still PENDING. 0.14% of live pooled lines. These are
  the lines the allocator should have flipped. The 14 (doc — item — need/have —
  wh): HC-SO-009735 ERGOTEX ERGOLITE (Q) 2/4 PG; HC-SO-004928 DUNLOPILLO
  GENERASI 5" (SS) 2/6 PG + OTHOREST GENERASI 3.0 (SS) 1/4 PG; HC-SO-013498
  GENERASI 5" (SS) 1/6 PG; HC-SO-013504 GENERASI 5" (S) 1/3 PG; HC-SO-011423 /
  HC-SO-013181 ERGOLITE (Q) 1/4 PG; HC-SO-010073 GENERASI 5" (S) 1/3 PG;
  HC-SO-010690 ERGOLITE (Q) 1/2 + FLEXICARE-S (K) 1/2 KL; HC-SO-012733 ERGOLITE
  (Q) 1/2 KL; HC-SO-013332 FLEXICARE-S (K) 1/2 KL; HC-SO-011114 STOOL 1/1 PG;
  HC-SO-013341 STOOL 1 1/4 KL.

**NEXT STEP for the 14 (handoff — UNTESTED).** LIKELY these are stale: stock
arrived / a processing date was set AFTER the allocator last walked those buckets,
and no re-walk fired. The standard, idempotent engine re-walk
(`recompute-so-allocation.yml` / `recomputeSoStockAllocation`) would flip any that
are merely stale; whichever DON'T flip after a clean recompute are a real bug to
trace (start at `grns.ts` re-walk trigger + `so-stock-allocation.ts`). It is a
production WRITE, so it needs the owner's go-ahead — not run here. Do NOT read
"run the recompute" as done: it has not been run.

### Track E — "already have PO, why still SHORT?" (owner, 2026-09-11)

Owner sent two screenshots: `HC-SO-011114` ("already have PO:010045, please
update why only item 3 no show PO?") and `HC-SO-013389` ("this already have
PO-010087, please update it"). BOTH are real, and they are two DIFFERENT
defects — neither is an engine fault.

Traced on LIVE prod, read-only, against the rule as it is written:

- Since 2026-09-09 a company-1 hard-bound line (sofa / bedframe / `(SP)`
  mattress) is covered ONLY by a PO line that (a) carries its `so_item_id` and
  (b) is itself on a hard-bound `item_group` — `isDedicated` in `routes/mrp.ts`,
  `boundSofa` in section 8, `isHardBoundLine` + `HARD_BOUND_COMPANY_ID` in
  `lib/so-stock-allocation.ts`. The rule is the owner's and is right; what it
  exposed is dirty PO-line data.
- **`HC-SO-011114` / `9058-STOOL`** — `HC-PO-010045` DOES carry the stool, right
  warehouse, right variant, nothing received, but that PO line's `so_item_id` is
  NULL. Its two siblings (2A/1A) are linked, which is exactly why only item 3
  reads SHORT.
- **`HC-SO-013389` / `8030-1A(LHF)`** — `HC-PO-010087`'s line IS linked to the
  right SO line, but its own `item_group` is `others`, not `sofa`. Not
  hard-bound → not dedicated → invisible to the set.
- **`HC-SO-013389` / `8030-1A(RHF)`** — NOT a defect. No PO anywhere carries it.
  That half genuinely has to be ordered.

**Census (prod, company 1, live POs).** Class A (hard-bound PO line, no
`so_item_id`): **6 lines**, every one created 2026-08-28, all `from_mrp=false`
with a NULL `line_no` — one batch of hand-opened POs. Class B (linked, but PO
group not hard-bound): **exactly 1 line**, `HC-PO-010087`. The known gap in
`docs/mrp-stock-vs-bound-rules-2026-09-09.md` §3 (`HC-PO-009024` /
`HC-SO-012025`) is now fully linked — that item is CLOSED.

| Step | State | Where |
|---|---|---|
| E1. `repair-mrp-po-line-links.mjs` — plan/apply, two classes, per-row refusal reasons | THIS PR | `backend/scripts/repair-mrp-po-line-links.mjs` |
| E2. Workflow (default plan; apply needs the confirm phrase) | THIS PR | `.github/workflows/mrp-po-link-repair.yml` |
| E3. Run PLAN | **DONE — ran against the read-only prod DSN 2026-09-11**: 2 link repairs, 1 category repair, 4 refused | output in the PR body |
| E4. Run APPLY | **NOT RUN** — production write, owner's call | Actions → "MRP PO-line link repair" |
| E5. Recompute after apply | **NOT RUN** | Actions → "Recompute SO stock allocation" |

**What the plan will change (2 + 1).** `HC-PO-009718 / 9028-1A(RHF)` →
`HC-SO-012913` line 2; `HC-PO-010045 / 9058-STOOL` → `HC-SO-011114` line 5;
`HC-PO-010087 / 8030-1A(LHF)` `others` → `sofa`.

**What it REFUSES, and why that is the point (4).** `HC-PO-009630 /
5535-L(RHF)` (→ `HC-SO-012046`), `HC-PO-009940 / 5535-1NA` (→ `HC-SO-013224`),
and both `HC-PO-010041` lines (→ `HC-SO-013312`): on each of those sales orders
there is no live, still-uncovered line with that item code in that warehouse —
the order was amended after the PO was raised, or another PO already covers it.
A looser match is NOT safe here: §3 of the 2026-09-09 doc measured it — "an open
PO somewhere carries this item code" returned 10 lines and paired four unrelated
customers, because sofa compartment codes repeat across orders. These four need
a human to say which piece the PO actually buys.

**UNTESTED, stated as such:** nobody has run APPLY, so "the two screenshots will
go green" is a prediction from the rule as read, not an observation. E4 then E5,
then re-read the MRP page, is what turns it into one.

## What is left for the next person (the mockup's fuller UI — owner to decide)

The sofa+cover-on-one-PO PAIN is solved (A2). What the §06 mockup drew and is NOT
built — none is a defect; each is a bigger UI the owner has not committed to:

1. **A standalone "分类 ⇄ 销售单" global view toggle.** Today MRP is five
   category tabs; the mockup adds a whole-SO view where one card shows every
   category of a sales order together. Needs backend all-category aggregation per
   SO (today the plan is fetched per category). File: `frontend/src/pages/scm-v2/Mrp.tsx`
   + a new `/mrp/plan` shape. Effort: medium-large.
2. **Per-SO "整单转 PO" cards in that SO view.** The convert-the-whole-order
   action exists surgically on the Sofa tab; the mockup makes it a first-class
   card action in the SO view above. Depends on #1.
3. **Bedframe multi-select "合并转" button.** Bedframe merging is done
   automatically by the backend (same supplier + one SO -> one PO); the mockup
   adds an explicit multi-select "merge convert" control. Effort: small-medium,
   FE only, once #1 exists.
4. ~~**Mobile MRP convert flow.**~~ **CLOSED — owner ruled 2026-09-11:
   「手机版不需要MRP」.** Not built and not to be built. `frontend/src/mobile`
   MRP stays the read-only `MobileModuleList` (variant "mrp") it is.

   **This is a deliberate, NAMED exception to the repo's "desktop and mobile are
   one product" rule**, recorded here so the next sweep does not read the gap as
   a defect and re-open it. MRP is a buyer's desk tool: the purchasing decision
   is taken sitting down against a supplier list and lead times, not on a phone.
   Do not re-propose it; if the answer ever changes it will change because the
   owner says so, not because a parity check noticed the asymmetry.

## The mockup's fuller UI — what is BUILT vs what is not (re-checked in code 2026-09-11)

Owner asked directly: 「我记得它有一个是可以看 By Sales Order 的？」 Read off the
tree, not off this file's earlier prose:

| the mockup drew | state | evidence |
| --- | --- | --- |
| `COMBINED / PER SO` toggle (how POs GROUP on convert) | **BUILT** | `poMode: 'combined' \| 'per-so'` in `frontend/src/pages/scm-v2/Mrp.tsx`; rules in `scm/lib/po-grouping.ts` `groupKeyFor`, PR #3602 merged + deployed |
| Sofa tab rows grouped by sales order | **BUILT** | `groupBySo` in `Mrp.tsx` — sofa tab ONLY |
| A global "分类 ⇄ 销售单" VIEW toggle | **NOT BUILT** | no view state in `Mrp.tsx`; and no backend shape for it — `grep` for `/mrp/plan` / `bySalesOrder` in `scm/routes/mrp.ts` returns nothing |
| Per-SO "整单转 PO" cards in that view | NOT BUILT | depends on the row above |
| Bedframe multi-select "合并转" | NOT BUILT | the backend already merges automatically; what is missing is the explicit control |
| Mobile MRP convert | **CLOSED, will not be built** | owner 2026-09-11 — see item 4 above |

**The two things whose names collide, because a reader will conflate them and
one of them is done:** `COMBINED / PER SO` decides **how purchase orders are
grouped when converting**. The "By Sales Order" view decides **how the page is
laid out** — one card carrying a sales order's sofa AND mattress AND accessories
together. The first is shipped; the second is not.

**Why the second is not a front-end afternoon.** MRP fetches ONE CATEGORY PER
REQUEST (five tabs). A whole-order view needs the backend to answer "every
category of this sales order" in one shape, which does not exist. Assembling it
in the browser from five responses is possible and was offered, but it makes the
page wait for all five — and this page has already had one round of work spent
on being slow.

**Standing recommendation (owner has not picked): do nothing yet.** The painful
case — a sofa set spread over many module lines — is already served by the sofa
tab's per-SO grouping, and mattress / accessories are pooled from stock where
per-order reading earns little. The question that would settle it is for the
buyer, not for us: does she work by category or by customer?

## Worktrees

All feature/diag worktrees for the above were removed after their PRs merged.
This handoff PR uses `mrp-redesign-handoff` = `docs/mrp-redesign-handoff`; remove
it after merge (`git worktree remove ../houzs-work-worktrees/mrp-redesign-handoff`).

## Open decisions / notes
- Mattress window KEPT (owner picker 2026-09-11).
- Under Per-SO the 皮套 splits off the sofa PO — co-location is a COMBINE feature. Owner is aware.
- 皮套 is ACCESSORY (confirmed by PR #3601). A1 grouping co-locates any non-core line of a sofa SO onto the sofa PO.
- The mockup (§03 supplier×category chip "要新建"; §02 "床垫同一周 window 待定")
  is now STALE on both points: the lead-time is built (#3608) and the window is
  KEPT in code. Do not re-open either from the artifact.
