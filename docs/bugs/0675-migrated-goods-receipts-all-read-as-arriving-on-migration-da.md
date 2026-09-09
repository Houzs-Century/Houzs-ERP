## Migrated goods receipts all read as arriving on migration day, and hid every split delivery [high]

**Symptom.** Owner, 2026-09-07, on the goods receipts carried over from
AutoCount: 「是 A 的，不过只是把那些需要的搬进来，不需要的不需要搬」 — the ERP must
show the receipts the account book actually made. It did not. Every one of the
320 migrated goods receipts read as having arrived on one of three days
(2026-08-28, 2026-08-29, 2026-09-07 — the days the migration ran), and a purchase
order AutoCount received in three deliveries showed as a single receipt. A buyer
asking "when did this arrive, and did it come in one lorry or three?" got the
wrong answer to both questions.

**Root cause (traced).** Two lines of `backend/scripts/create-migrated-documents.mjs`,
both deliberate at the time and both wrong for the question above:

1. It groups by PURCHASE ORDER (`const byPo = new Map()`), one ERP receipt per
   purchase order, because `scm.grns.purchase_order_id` is a single purchase
   order and an AutoCount receipt can span several. So the book's split was
   collapsed on the way in.
2. It writes `received_at = CURRENT_DATE` in the header INSERT, because the
   quantity it carries comes from `purchase_order_items.received_qty` — an
   aggregate with no date attached — not from a receipt document.

Measured, not inferred: `backend/scripts/check-gr-shape.mjs` against production
(run 34135520445, 2026-09-07) printed `320 migrated goods receipts` with
`distinct received_at ... 3`, against a book holding **400 (receipt x purchase
order) pairs over 318 purchase orders across 214 receipts** — split 248 once, 58
twice, 12 three times, dated 2024 (11), 2025 (25), 2026 (178). Two independently
cut extracts, `ac-gr-refs.json.gz` and `ac-convert-edges.json.gz`, agree on 400 of
400 pairs.

The second-order damage was in the checker: `check-ac-erp-reconcile.mjs` printed
`GR DATA — line and money comparison NOT APPLICABLE`, correctly (the quantity was
derived from the purchase-order line, and the grains did not match), and that
sentence was then read as "checked". The contents of the migrated receipts had
never been compared to the book at all.

**Fix.** `backend/scripts/reshape-migrated-grns.mjs` + Actions -> **Reshape
migrated goods receipts (plan by default)** writes one document per (AutoCount
receipt x purchase order) — 400 — carrying the book's own receipt date and
quantity, stamped `migrated_no_stock`, with no inventory movement. The receipt
number goes on a NEW column `scm.grns.linked_ac_gr_docno` (mig
`20260907T2345_grn_linked_ac_gr_docno.sql`) rather than re-pointing
`linked_ac_docno`, which ten scripts read as the purchase order's number.

Three properties worth naming because each was a decision:

- **Never delete, only retire.** A receipt whose pair is in the plan is updated
  in place; one whose pair is not is CANCELLED by a DIRECT status flip. Not
  through `PATCH /grns/:id/cancel` — that route has zero occurrences of
  `migrated_no_stock` and would write a reversing inventory OUT for 879 units
  that never had an IN. A restorable JSON dump of all 320 is written before
  anything moves, in plan mode as well as apply.
- **The purchase-order LINE is left UNSET where the book cannot decide it.**
  `GRDTL.FromDocDtlKey` is 0 of 21,746 rows, so where a purchase order carries an
  item code twice nothing in the book says which line was received.
  `purchase_order_item_id` stays NULL there and the line says so in its own
  `grn_items.notes`. Owner: 「跟 autocount 一样」. Filling the first matching line
  is the class of invention this ledger exists to stop.
- **The reconcile now compares GR contents** at pair grain — line count, item
  code and quantity — instead of printing NOT APPLICABLE. The unit price is still
  taken from the purchase-order line and is reported as DECLARED.

Proved red before the fix: the same `check-gr-shape` run above is the RED
measurement (3 distinct dates over 320 documents against 214 dated receipts), and
`check-ac-erp-reconcile.mjs`'s GR section printing NOT APPLICABLE is the red state
of the checker. Both are re-run after the apply.

**APPLIED 2026-09-08 09:00 local (run 34175100153)** — created 153, updated 247,
cancelled 0, after the money question that had held it since 2026-09-07 was
settled against the book (`docs/bugs/0682`). Both promised re-runs came back
green, and both are quoted with their denominators because a count is not a
shape:

- **Shape, on a fresh connection inside the apply run.** 473 live migrated
  receipts; `received_at` now takes **110 distinct values** where it took 3;
  87 lines read back carrying no purchase-order line, exactly the 87 the plan
  flagged; 0 inventory movements.
- **Stock, re-measured by the independent detector** (run 34175761482, *Stock vs
  AutoCount reconcile*): `scm.grns` **473 rows, 473 `migrated_no_stock`**, and
  *migrated documents that DID write an inventory movement: **0** goods-receipt
  rows, **0** delivery rows, **0** units*. `AutoCount cells that moved since the
  seeding baseline: 0`, so the 23:53 balance re-seed was not disturbed.
- **The reconcile's GR section** (run 34175952533) went from
  `GR DATA (0 documents on both sides, 0 lines paired)` to
  **`GR DATA (400 documents on both sides, 506 lines paired)`**: absent **0**,
  phantom **0**, line-count differs **0 of 400**, quantity differs **0 of 400**,
  unit price differs **0 of 400**. What remains is item code **103 of 400** and
  document total **109 of 400** — and the run names the systematic cause itself:
  100 of those 400 carry zero money in the ERP while the book carries a value,
  which is `stamp-migrated-source-prices.mjs`'s to close, not the reshape's. A
  further **44 of 400** could not be line-matched and are **UNVERIFIED, not
  verified-clean**.

**Ref.** `feat/gr-reshape-pair-grain`, 2026-09-07; applied `chore/gr-reshape-applied-evidence`, 2026-09-08.
