## The migrated goods receipts and delivery orders carry no AutoCount line number, so the checker guesses which row is which [high]

**Symptom.** The owner, 2026-09-08, reading the reconcile's goods-receipt
findings: 「为什么会这样行号不一样呢？一定要一样的啊？」 The rows the checker paired
were not the rows the book meant. On the 13:05 (+08) run `34189267879` the goods
receipts reported *"item code: 2 (+34 where we hold no line key and both sides
name the SAME goods)"* and 44 documents it could not line-match at all;
delivery orders reported 25. The same guessing produced five separate false
alarms on 2026-09-07/08 — sofa colours on two delivery notes, ten bedframe
dedications, two sofa models, the 34 goods-receipt item codes — and one of the
five, the bedframes, was genuinely wrong and would have made a customer's REGAL
read READY when a TRION arrived.

**Root cause (traced).** The line numbers are not DIFFERENT — they were never
copied. Migration `0280_scm_ac_line_keys_downstream.sql` added
`linked_ac_dtlkey` to `scm.grn_items`, `scm.delivery_order_items`,
`scm.sales_invoice_items` and `scm.purchase_invoice_items`, and its own header
states the consequence: *"Nothing backfills it: the keys are stamped forward"*.
So every document the MIGRATION created kept NULL, measured on production as
0 of 636 goods-receipt lines. Sales orders and purchase orders do carry the key
(migration 0273 plus `backfill-ac-line-keys.mjs` and
`repair-migrated-po-lines.mjs`), which is why this morning's 42 item-code
corrections could be written by key at all — the mechanism works wherever the
key is present.

`check-ac-erp-reconcile.mjs` made the absence permanent rather than temporary:
its goods-receipt line query selected `NULL::bigint AS ac_dtlkey` — a CONSTANT,
not the column. That was true when written and invisible because the column was
empty anyway, but it meant the checker was structurally forced to pair by
quantity and position on every goods receipt for ever, even after the keys
arrived.

Second half of the cost: `AcSyncService`'s `/edit` addresses a book row by
`doc.EditDetail(dtlKey)`, the only handle the 2.2 SDK exposes. With no key the
ERP cannot name the line an operator changed, so an edit of a migrated goods
receipt is refused.

**Fix.** `backend/scripts/backfill-ac-downstream-line-keys.mjs` stamps the
book's own `DtlKey` onto the migrated goods-receipt and delivery-order lines,
and `check-ac-erp-reconcile.mjs` now READS `i.linked_ac_dtlkey` on goods
receipts instead of hard-coding `NULL`. The pairing rule is
`backend/scripts/lib/ac-forced-line-pairing.mjs`, pinned by 23 tests in
`backend/tests/acForcedLinePairing.test.mjs`: lines are bucketed on (item code
after the sofa alias fold and the mapping sheet, quantity), and a bucket is
stamped only when both sides hold the same number of them AND — where that
number is above one — the book's own lines in it are identical on every column
the book states, which makes them interchangeable. Everything else is counted
and named, never guessed: a wrong DtlKey makes AcSyncService APPEND a line to
the live account book, which is strictly worse than NULL.

The tests were proved RED by mutation, not asserted to be: with the
mutual-identity clause disabled, 3 of 23 fail (price, Desc2, location); with
`5535` added to `SOFA_MODEL_ALIAS`, 1 fails; with the uneven-fold flag forced to
false, 2 fail. Restored, 23 of 23 pass.

**Ref.** fix/ac-line-keys-downstream, 2026-09-08.
