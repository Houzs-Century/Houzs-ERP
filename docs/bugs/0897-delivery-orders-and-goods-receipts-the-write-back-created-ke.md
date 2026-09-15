## Delivery orders and goods receipts the write-back created kept no AutoCount line keys, so their next edit was refused [high]

**Symptom.** The AutoCount outbox health check of 2026-09-14 (run 34834055311)
listed 38 documents "IN AUTOCOUNT, BUT WITH NO LINE IDENTITY" — 22 delivery
orders and 15 goods receipts among them — each with a reason such as *"line 1 is
'AK-BASTION MATT (Q)' in AutoCount but 'AKEMI BASTION MATT (Q)' here, so the two
line lists do not correspond"* or *"AutoCount reported 2 line(s) and the ERP
sent 3"*. An edit of such a document is refused whole (`KeylessLineError`), and
several already were (HC-DO-2609-044, HC-DO-2609-058, HC-GRN-2609-008 …).
Measured on production the same day, read-only: 82 ERP-created delivery orders
(417 lines) and 64 goods receipts (244 lines) sat in the book with at least one
keyless line.

**Root cause (traced).** After a conversion the host answers with the new
document's lines as `DtlKey`, `ItemCode` and `Desc2` (`AcSyncService.cs`
`CreatedLines`) and nothing naming each line's source. `persistLineKeys`
(`backend/src/scm/lib/autocount-line-keys.ts`) therefore checked the pairing by
line count and item code. Both checks are wrong for a conversion:

- the target it compares against is built at enqueue by `readConvertTargetLines`
  with the ERP's OWN item codes and one entry per ERP row, while AutoCount copies
  the SOURCE line's code (the book's supplier spelling) and holds a sofa as one
  line;
- so a supplier-coded product never matches, and a sofa never has the same line
  count. Refusing was the correct response to a pairing it could not prove, and
  it left the document keyless.

The proof the drain lacked exists in the book. `DODTL.FromDocDtlKey` /
`GRDTL.FromDocDtlKey` are NULL (0 of 111 and 0 of 51 lines on the documents in
question), but `DocTransfer` names the source line of every transferred line —
measured over the ERP-numbered documents: 105 delivery orders, 459 lines, each
with exactly one transfer row; 73 goods receipts, 206 lines, one without a
transfer row and one source line feeding two lines. The same table was found for
the migrated chain in docs/bugs/0746.

**Fix (the backlog).** `backend/scripts/export-ac-conversion-line-keys.py`
exports, read-only, each line of an `HC-DO-` / `HC-GRN-` document with its
DocTransfer source key. `backend/scripts/stamp-conversion-line-keys.mjs`
(workflow *Stamp AutoCount line keys on our DOs and GRs*) pairs, inside one
document, our row's source key (`so_item_id` / `purchase_order_item_id` → that
line's `linked_ac_dtlkey`) with the book line fed by it
(`lib/conversion-line-key-plan.mjs`, self-tested), and writes
`linked_ac_dtlkey` only where it is NULL. Plan run locally against production
2026-09-14: delivery orders stamp 417 and **66 existing keys agree** with the
book, 0 disagree; goods receipts stamp 216 and **7 agree**, 0 disagree, 26 have
no source line (lines added on the receipt), 2 name a source the receipt does
not hold, 1 is ambiguous; 9 August documents in the book no longer exist in the
ERP (the 2026-08-31 test clean-up). Tests: `backend/tests/conversionLineKeyPlan.test.mjs`.

**Not fixed here.** A conversion drained after this still stores no key the
same way; the lasting fix is the host returning each created line's
`FromDocDtlKey` from `DocTransfer` so the drain pairs at creation, which needs
the office host rebuilt. Until then the exporter and the stamp can be re-run.
Documents refused while keyless need their edit re-queued once stamped.

**Ref.** fix/ac-conversion-keys-from-book, 2026-09-14.
