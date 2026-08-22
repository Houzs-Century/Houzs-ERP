## Confirming a delivery order did not take the stock out [high]

**Symptom.** The owner, describing how it should work: 「once confirmed就代表出货
了 就是直接扣库存」 and 「draft 没出货，Confirmed就代表出货了 然后delivered只是记录
而已，记录送到了」. Confirming a delivery order left the goods on the books. Stock
on hand read higher than the warehouse actually held, from the moment a delivery
was confirmed until somebody advanced it a second time — and MRP, which reads
stock on hand, planned against the inflated figure.

**Root cause (traced).** Two halves, and neither was visible from the other.

`backend/src/scm/shared/do-shipped-states.ts` is the one home for "which statuses
have moved stock". `LOADED` — the status every screen renders as **Confirmed**
(`frontend/src/vendor/scm/lib/status-pill.ts`) — sat in `DO_PRESHIP_STATES`, so
the inventory OUT waited for `DISPATCHED`.

And `frontend/src/vendor/scm/lib/do-next-step.ts` made that invisible: the office
Confirm button returned `{ status: 'DISPATCHED', label: 'Confirm' }`. It was
LABELLED Confirm and it WROTE the status that renders as "Shipped", skipping
Confirmed entirely. So a confirmed delivery order did deduct — by jumping two
rungs and calling itself something it was not. The Confirmed state was
unreachable from the office, which is why production held zero rows in it
(run 32573972467) and why nobody had noticed the deduction was on the wrong hop.

**Fix.** `LOADED` moved into `DO_SHIPPED_STATES` (so `DO_PRESHIP_STATES` is
`DRAFT` alone and `DO_NOT_DELIVERED_STATES` derives to `{DRAFT, CANCELLED}`), and
Confirm now writes `LOADED`. One trigger, unchanged in shape — the point of that
module is that the write has a single home, and nothing was added beside it.

Three consequences that had to move with it, each of which would have been a
silent regression: the customer "on its way" email fired on `toStatus ===
'DISPATCHED'` and would simply have stopped, so the confirm hop now includes
`LOADED`; the over-delivery guard runs on the pre-ship→shipped hop, which is now
`DRAFT → LOADED`; and `DoLoadScan.tsx` told the storekeeper in as many words that
his scan moved no stock, which stopped being true.

Pinned by `backend/tests/doStockLeavesOnConfirm.test.ts`, which walks a delivery
order up the ladder against a fake movement table using the imported set and the
real guard shape. **Proved RED on the unfixed tree: 7 of its 13 assertions
failed**, including "DRAFT → LOADED writes the OUT" (`expected null to be
'LOADED'`) and the double-deduct walk (`expected [ 'DISPATCHED', 'DISPATCHED' ]
to have a length of 4`). Green after.

**Why the 30 already-dispatched deliveries could not be deducted twice**, since
this moves an inventory write. Nothing occupies the promoted state — production
census run 32573972467, 2026-08-22: 44 delivery orders, 30 `DISPATCHED`, 12
`DELIVERED`, 2 `CANCELLED`, zero in `DRAFT`/`LOADED`/`IN_TRANSIT`/`SIGNED`/
`INVOICED` — and the OUT fires on a TRANSITION, which no existing row performs.
Beneath that, the deduction is idempotent at two levels: `deductInventoryForDo`
opens with an existence check over this DO's own `DO`/`OUT` rows, and
`uq_inv_mov_do_source_v2` is live in production (run 32574476216, read from
`pg_indexes`), UNIQUE over `(source_doc_type, source_doc_id, item_code,
variant_key, COALESCE(correction_seq,0))` where `source_doc_type='DO'` — with
`movement_type` deliberately absent from the key. The same run reports zero
multi-row DO buckets.

**Ref.** `fix/stock-leaves-when-the-do-is-confirmed`, 2026-08-22.
