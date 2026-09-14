## A multi-line SO-to-PO transfer sent each line's quantity and cost under another line's AutoCount key [critical]

<!-- area: AutoCount sync + write-back -->

**Symptom.** Found while tracing why the 0888 requeue refused HC-PO-2609-032
(plan run 34823021667). Its `so_to_po` outbox row (sent 2026-09-09 06:56) carried

    Details [{DtlKey 345768, Qty 2}, {DtlKey 345765, Qty 1}, {DtlKey 345764, Qty 1}]

while 345768 is the CROWN (SS+S) sales line (qty 1) and 345764 is STAR-(SS)
(qty 2). The account book's purchase order was told CROWN x2 and STAR (SS) x1,
each at the other's cost (probe run 34826755295).

**How wide (measured).** `check-ac-refused-amendment-docs.mjs` section 7d,
production run 34827560743, every `so_to_po` sent since 2026-09-07: 74 payloads,
27 with two or more lines, **15 documents / 33 lines paired with the wrong
line**; on HC-PO-2609-032 and HC-PO-2609-063 the quantity itself differs, on the
rest (e.g. HC-PO-2609-010, -022, -034, -068, -073, -080, -086) the unit cost,
delivery date and location of two lines are swapped. The census compares with
today's rows, so a line changed since it was sent can read as `?`. What the book
holds now was NOT read (the host is reachable only from the Worker) — the
host's own code applies `Qty` per `DtlKey` (`AcSyncService.cs` SoToPo phase two,
`qtyByKey`, `EditDetail(newKeyBySourceKey[srcKey])`), so the book is LIKELY to
carry exactly what was sent.

**Root cause (traced).** `composeSoToPo` (`services/autocount-writeback.ts`) zips
`shape.dtlKeys` with the composed details BY INDEX. The details come from
`enqueuePoCreate`'s `inAcLineOrder` read (created_at, id). The keys come from
`readPoTransferFacts` (`scm/lib/autocount-read.ts`), whose
`purchase_order_items` select had NO `ORDER BY`, so Postgres returned the rows
in another order. `ac-line-order.ts` exists because every payload read once had
this defect; this read was not converted. The drain's `backfillSoToPoKeys` for a
`wait` row zips the same unordered read the same way.

**Fix.** `readPoTransferFacts` reads in `inAcLineOrder`, so both zips pair a key
with its own line. Pinned in `src/scm/lib/autocount-so-to-po-pairing.test.ts`,
which inserts HC-PO-2609-032's three lines in the reverse of their
(created_at, id) order: RED on the unfixed tree —
`expected { key: 345768, qty: 2, price: 500 } to deeply equal { key: 345768, qty: 1, price: 700 }`
— green after.

**Not fixed here — the purchase orders already in the book.** Their values can
only be corrected by an edit addressed by each line's own key, and those
documents also hold no line keys (0890). See the PR for the repair plan; it
needs the owner's go-ahead because it writes to AutoCount.

**Ref.** fix/ac-refused-amendment-docs, 2026-09-14.
