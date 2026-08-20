## 39 purchase-side links were gone and nothing said so [medium]

**Symptom.** Found by hand, twice, while chasing "received sofa still reads
PENDING" (2990-SO-2607-006): `purchase_order_items.so_item_id` NULL on lines
whose PO note says which SO they were raised from. 39 lines across 21 live POs
on 2026-08-19 — 35% of every from_mrp line in use. The DO-side twin of this
(#2355) at least announced itself through MRP re-ordering; the PO side has no
such tell. An unbound line means bound-mode readiness cannot tie received stock
to its order: goods on the shelf, the SO stuck at PENDING, and the only way it
surfaces is an owner asking why.

**Root cause of the blindness.** Same `ON DELETE SET NULL` FK family as the DO
side; the mechanism that blanks them is still unidentified there and here. What
was missing was any measurement: the hourly sentinel watched DO orphans,
NULL-warehouse lines — and nothing on the purchase side.

**Repair (data, done by hand 2026-08-19).** 37 of 39 rebound 1:1 — source SO
taken from the PO's own "From SOs:" note, matched on item code + qty, only
where the free-SO-line count equals the unbound-PO-line count, verified no SO
line claimed twice. A later pass caught 3 more that had become unambiguous.
2 remain on 2990-PO-2606-016: its source SO's lines are already claimed by a
different PO — a human question, not a matching one.

**Fix (this PR).** The sentinel gains a fourth alarm: from_mrp PO lines with
so_item_id NULL, baseline 2 (the ones with an ANSWER), same do-not-raise rule
as its siblings.

**Ref.** PR (branch `chore/sentinel-po-side`, stacked on
`chore/null-warehouse-guard`), 2026-08-19.
