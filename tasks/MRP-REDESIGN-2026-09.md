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
| A1. Grouping logic rewrite (`po-grouping.ts` `groupKeyFor` + convert wiring `sofaSoDocNos`) + tests | **DONE, in this PR** | branch `feat/mrp-combine-perso-grouping`, worktree `mrp-sofa-cover` |
| A2. Sales-Order VIEW toggle + search + "整单转 PO" + sofa selecting auto-includes its accessories (visible) | TODO (frontend) | `frontend/src/pages/scm-v2/Mrp.tsx` + mobile pair; reuse `/from-sos` |
| A3. Bedframe "two POs" diagnosis | check built (PR #3601), awaiting merge+dispatch | see Track C |

Note: with A1 + the existing `gatherSofa` pull, Combine mode from the Sofa tab
ALREADY co-locates a sofa's same-supplier accessories onto its PO. A2 is the
nicer UX (whole-SO card) and the search the owner asked for.

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
| B1. New table for supplier×category lead days (migration, migrations-pg) | **DONE — Track B PR** | `20260911T0900_scm_mrp_supplier_category_lead_times.sql` |
| B2. Resolver: supplier×category OVERRIDES base (highest priority) | **DONE — Track B PR** | `scm/lib/lead-time.ts` (`loadSupplierCategoryOverrides` + override layer in `resolveLeadDays`); both call sites (`mrp.ts`, `mfg-purchase-orders.ts`) pass it; agent estimate passes `NO_OVERRIDES` |
| B3. Supplier page UI + endpoints | **DONE — Track B PR** | route `mrp-supplier-lead-times` (GET/PUT/DELETE); FE `SupplierLeadTimes.tsx` on a new supplier-page "Lead Times" tab |
| B4. Confirm base table has data (read-only) | DONE — see diagnostic §1 (sofa/bedframe=7, accessory/mattress=0, no per-warehouse overrides) | Track C |

Track B ships as a NO-OP until the owner enters a supplier override (empty table
= base wins). The override REPLACES the base layer; learned buffers still add on
top. Worktree `mrp-supplier-lead` = branch `feat/mrp-supplier-lead-time`.

### Track C — Read-only diagnostics (owner asked to "run the check")

`PR #3601` (`diag/mrp-grouping-facts`, worktree `mrp-grouping-diag`) — read-only.
Reports: (1) base lead-time table contents; (2) which category sofa covers/
pillows sit in (answers "皮套 in accessories?"); (3) bedframe SOs split across POs,
classified different-supplier (correct) vs same-supplier (the separate-batch
limitation). **Needs: my review of the SQL -> merge -> dispatch (workflow_dispatch
only works once on main).**

## Shipped already
- Others tab flicker fix — `PR #3596` (queued). Others is now a permanent 5th tab.

## Worktrees in play
- `mrp-sofa-cover` = `feat/mrp-combine-perso-grouping` (Track A1 — this PR)
- `mrp-grouping-diag` = `diag/mrp-grouping-facts` (Track C — PR #3601)
- `others-tab-stable` = `fix/others-tab-always` (PR #3596, merging)

## Open decisions / notes
- Mattress window KEPT (owner picker 2026-09-11).
- Under Per-SO the 皮套 splits off the sofa PO — co-location is a COMBINE feature. Owner is aware.
- Cover category (ACCESSORY vs Others) still to be confirmed by PR #3601; A1 handles both (Combine pulls any non-core line of a sofa SO onto the sofa PO).
