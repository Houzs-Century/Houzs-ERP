## /edit appended a duplicate of every line into the live account book, and a line could not be retired without deleting it [critical]

**Symptom** - none yet, and that is the point: the ERP -> AutoCount write-back
has never been switched on. Had it been, the first EDIT of any sales order or
purchase order would have written a SECOND COPY of every line the operator did
not touch into the live AED_HOUZS book. On a purchase order those duplicates
are permanent - see the root cause.

**Root cause (traced, not guessed)** - two halves of one missing concept, line
identity.

(1) `AcSyncService.Edit` addresses a line by AutoCount's `DtlKey`
(`doc.EditDetail(dtlKey)`, the only line handle the 2.2 SDK exposes) and fell
through to `doc.AddDetail()` when a line had none. The fallback reads as "this
must be a new line", but no line had a key: the create routes returned
`so.DocNo` alone and never the created DtlKeys, so every ERP-created document
had NULL line identity forever, and the migrated documents were never
backfilled. Measured on production 2026-08-11 from a read: **0 of 13,907** SO
lines and **0 of 864** PO lines on AutoCount-linked documents carried a
`linked_ac_dtlkey`. Every line was keyless, so every line would have been
appended.

(2) Retiring a line had no representation at all. The string `Cancelled`
appears ZERO times in `sdk-api-reference.txt` - no detail class has a
line-level cancel - and only `SalesOrder` exposes `DeleteDetail`.
`PurchaseOrder`, `PurchaseInvoice`, `GoodsReceivedNote`, `Invoice` and
`DeliveryOrder` have no line-removal method whatsoever. So for half the go-live
slice AutoCount offers neither delete nor cancel at line level, which is why
the duplicate a PO edit appended could never have been removed.

**Fix** - `/edit` now REFUSES a keyless line instead of appending one, in a
pre-flight pass over every line before any detail is touched, so a refusal
leaves the document exactly as AutoCount already had it. A genuinely new line
must say so with `IsNewLine: true`. Refusing is safe: the document does not
sync and the outbox row is visibly failed. Appending is not recoverable.
Alongside it, every create/convert route now answers with the created DtlKeys
(`lines: [{Seq, DtlKey, ItemCode, Desc2}]`) so line identity exists from the
moment a document is created, and a line can be retired in place with
`Retire: true` - `Qty = 0` plus `Transferable = false` plus an
`[ERP-CANCELLED]` Desc2 marker. `Qty = 0` is the load-bearing part and is
deliberately NOT wrapped in the exception-swallowing `Set()` helper: AutoCount's
own outstanding predicate is `Qty - ISNULL(TransferedQty,0) > 0`, so a silently
skipped zero would leave the line outstanding in AutoCount while the ERP
believed it cancelled.

The backfill that fills the migrated documents' keys was also changed to SKIP
any group whose ERP and AutoCount line counts disagree rather than zipping the
first N. A wrong DtlKey is strictly worse than no DtlKey - no key is refused
loudly by the new guard, a wrong key silently edits a different line in a live
book.

**Ref** - 2026-08-11, PR #1935 (feat/ac-line-identity). C# half needs a manual
build on the AutoCount host: `docs/autocount-service-deploy.md`.
