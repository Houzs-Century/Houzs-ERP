## Cancelling a migrated goods receipt writes a phantom stock OUT [high]

<!-- area: Purchase orders + GRN + PI -->

**Status: FOUND, NOT YET FIXED.** Recorded here because it is a go-live hazard
that a staff click reaches today, and because it is the reason the GR reshape
cannot use the owner's usual "cancel, never delete" rule through the route.

**Symptom.** Not yet seen by staff — found while measuring what an option-A GR
reshape would cost. Any user with cancel rights who opens one of the migrated
goods receipts (the `HC-GR-…` documents carried over from AutoCount at the
2026-08 cutover) and presses Cancel removes stock from on-hand that this
document never put there. The document reads as a normal POSTED receipt in the
UI; nothing on the screen says it is different.

**Root cause (traced).** `backend/src/scm/routes/grns.ts`, `PATCH /:id/cancel`.
The handler reverses the receipt unconditionally: it builds one inventory OUT
per line for `qty_accepted` (`buildGrnCancelReversals`,
`backend/src/scm/lib/grn-cancel-reversal.ts`), decrements each linked PO item's
`received_qty` via `recomputePoReceived`, and reverses the rack placement.

`grns.ts` contains **zero occurrences of `migrated_no_stock`** — the flag
migration 0276 added for exactly this purpose. Its comment is explicit: *"Never
post movements for it and never treat the absence as corruption — doing either
double-counts the stock."* The cancel path is the mirror case the comment did
not name, and nothing enforces it.

The handler does have a guard, `grnReverseWouldGoNegative`, and it does **not**
catch this. The migrated units genuinely are on the shelf — they entered through
the AutoCount balance snapshot, not through this document — so the guard sees
sufficient on-hand and permits the reversal. There is no signal it could use;
the only distinguishing fact is the flag, which is never read.

The DRAFT short-circuit higher up the same handler is the precedent for the fix:
it already skips the reversal for a status that committed nothing, with the
comment *"a DRAFT GRN committed NOTHING … so cancelling one must NOT reverse
anything"*. `migrated_no_stock` is the same property arrived at a different way.

This is the landmine `backend/scripts/stamp-ac-grn-refs.mjs` predicted in
writing when it argued against creating GRNs at all: *"a GRN that deliberately
posts nothing is worse, because it is a live landmine"*. The design was later
changed to create them (`create-migrated-documents.mjs`, owner-approved
2026-08-10); the landmine was not disarmed.

**Exposure.** Measured on production by `backend/scripts/check-gr-shape.mjs`
(`GR shape check (read-only)`), which prints the POSTED migrated-receipt count
and the unit total a cancel would reverse. Read the numbers off the run rather
than copying them here — they change as the cutover writes more documents.

**Fix.** Not shipped. The shape is a short-circuit in `PATCH /:id/cancel`
alongside the DRAFT one: on `migrated_no_stock`, flip the status, write the
audit row with a note saying nothing was reversed, and skip (a) the inventory
OUT, (b) the `received_qty` recount, (c) the rack reversal. It needs a test that
is RED on the unfixed tree — cancel a `migrated_no_stock` GRN, assert zero rows
land in `inventory_movements` — before it is called done. The same audit is owed
to the migrated delivery orders, which carry the identical flag and whose cancel
path was not examined here.

**Ref.** `feat/gr-shape-a`, 2026-09-07.
