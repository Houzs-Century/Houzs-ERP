# MRP redesign — living handoff (started 2026-09-11)

Owner-driven rework of the MRP · Stock Status Report and how it opens POs. Keep
this current: if you finish or start a piece, edit the status here in the SAME
PR. A stranger should be able to take over from this file alone.

Owner rulings captured in memory: `~/.claude/.../memory/mrp-combine-perso-rules-2026-09-11.md`.
Proposal + UI mockup artifact (owner-facing): the "MRP 整单转 PO" artifact.

## The two tracks the owner approved (2026-09-11), to run in parallel

### Track A — Combine/Per-SO re-spec + Sales-Order view

Owner's per-category rule (supersedes 2026-07-17). One global toggle:
- **Per-SO**: every `(SO, category)` its own PO — a sofa order's accessories split off.
- **Combine**: sofa + its accessories (皮套/pillow) on ONE PO; bedframe per-SO
  either way (same supplier + one SO -> one PO, even 2-3 bedframes); mattress
  merges within the delivery WEEK (window KEPT — owner picker 2026-09-11);
  standalone accessory merges same-supplier across SOs.

| Step | State | Where |
|---|---|---|
| A1. Grouping logic rewrite (`po-grouping.ts` `groupKeyFor` + convert wiring `sofaSoDocNos`) + tests | **MERGED — PR #3602 on main (47ffa2644)** | was worktree `mrp-sofa-cover` (removed) |
| A2. MRP search + sofa cover rides VISIBLY + the pull-in bug fix | **DONE — PR #3603, worktree `mrp-so-view`** | `frontend/src/pages/scm-v2/Mrp.tsx` |
| A3. Bedframe "two POs" diagnosis | check built (PR #3601), awaiting merge+dispatch | see Track C |

**A2 finding (the crux).** The A1 note below was HALF WRONG. `gatherSofa`'s
accessory pull reads `data.skus`, but the Sofa tab requested `?category=SOFA`,
which strips every non-sofa row — so the pull matched NOTHING and the cover
never rode from the MRP page. Dead since the 2026-06-15 per-category tab split.
A2 fixes it: the Sofa tab now requests the full plan (no category filter), which
also serves the stored snapshot instantly. Bug ledger
`docs/bugs/0801-mrp-sofa-cover-pull-in-was-dead-since-the-per-category-tab-s.md`.

A2 delivers: search box (all tabs); cover/pillow riders SHOWN under each sofa SO
with a Combined/Per-SO caption; selection scoped so ONE sofa order pulls only
THAT order's cover; the existing Proceed-PO on a selected sofa SO now converts
the whole order (sofa + cover) — the "整单转 PO" the owner wanted. NOT built: a
brand-new cross-category all-SO grouping VIEW, and the mobile MRP (a read-only
`MobileModuleList`); both deferred — see notes.

### Track B — Lead time: supplier × category manual override (highest priority)

Owner 2026-09-11: he will set, per supplier, that supplier's per-category lead
time; it takes PRIORITY over the category base table. `PO delivery date =
customer date − lead days`. Verified from source: the base + supplier(learned) +
season resolver is WIRED and already writes `purchase_order_items.delivery_date`
(agent trace, `scm/lib/lead-time.ts`). Change needed: a MANUAL per-(supplier,
category) value that OVERRIDES the base (today the supplier layer is a learned
additive buffer, approved on the agent console).

| Step | State | Where |
|---|---|---|
| B1. New table for supplier×category lead days (migration, migrations-pg) | TODO | `backend/src/db/migrations-pg/` |
| B2. Resolver: supplier×category OVERRIDES base (highest priority) | TODO | `scm/lib/lead-time.ts` (`resolveLeadDays`), both call sites (`mrp.ts`, `mfg-purchase-orders.ts`) |
| B3. Supplier page UI to set per-category lead days | TODO | supplier detail FE + a route |
| B4. Confirm base table has data (read-only) | folded into PR #3601 §1 | Track C |

### Track C — Read-only diagnostics (owner asked to "run the check")

`PR #3601` (`diag/mrp-grouping-facts`, worktree `mrp-grouping-diag`) — read-only.
Reports: (1) base lead-time table contents; (2) which category sofa covers/
pillows sit in (answers "皮套 in accessories?"); (3) bedframe SOs split across POs,
classified different-supplier (correct) vs same-supplier (the separate-batch
limitation). **Needs: my review of the SQL -> merge -> dispatch (workflow_dispatch
only works once on main).**

## Shipped / in flight
- A1 grouping — `PR #3602` **MERGED** to main.
- Others tab flicker fix — `PR #3596` (area-tag fix pushed, auto-merge armed).
- Track C read-only diagnostic — `PR #3601` (completeness-claim reworded, auto-merge armed).
- A2 (this) — `PR #3603` (search + sofa cover riders + pull-in fix).

## Worktrees in play
- `mrp-so-view` = `feat/mrp-so-view` (Track A2 — PR #3603)
- `mrp-grouping-diag` = `diag/mrp-grouping-facts` (Track C — PR #3601)
- `others-tab-stable` = `fix/others-tab-always` (PR #3596)
- (removed after merge: `mrp-sofa-cover` = `feat/mrp-combine-perso-grouping`)

## Open decisions / notes
- Mattress window KEPT (owner picker 2026-09-11).
- Under Per-SO the 皮套 splits off the sofa PO — co-location is a COMBINE feature. Owner is aware.
- Cover category (ACCESSORY vs Others) still to be confirmed by PR #3601; A2 handles both — it pulls ACCESSORY lines, and A1 grouping co-locates any non-core line of a sofa SO onto the sofa PO.
- DEFERRED: a cross-category "one card per SO across all categories" view (needs backend all-category aggregation) — A2 gave the sofa-cover payoff without it, since the Sofa tab is already grouped by SO and the cover now rides visibly. Raise as a separate proposal if the owner wants bedframe/mattress folded into the same SO card.
- DEFERRED: mobile MRP is a read-only `MobileModuleList` (variant "mrp"); it has no convert flow, so A2's sofa-cover UX is desktop-only for now.
- Track B (supplier×category lead time) still TODO — next after A2/C land.
