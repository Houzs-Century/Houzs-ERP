## HC-SO-013346 + HC-SO-009373 archived — AC parallel run, PO cancel deferred [low]

**Symptom.** Both sales orders sat on the AutoCount Sync "Not accepted" list,
each failing every retry with "The quantity of item X is less than the quantity
it was partially transferred to Purchase Order, save aborted."

**Root cause (traced, transfer-chain probe on both docs).** Not a quantity typo:
both SOs were edited in the ERP to DIFFERENT items than the book holds —
013346 book `HOK-5540 SOFA` + `HOK-SQUARE PILLOW` vs ERP `8030-2S` +
`AMN-SOFA PILLOW`; 009373 book `HOK-2041 (A)(Q)` vs ERP `TRION` bedframe, and
`AK-` vs `AKEMI` codes throughout. The book's OLD items carry `tPOQty > 0` (a
purchase order already bought them), so AutoCount refuses to clear them on
either an edit or a rebuild. The ERP has no matching PO to sync down (every ERP
line shows `parents=[none]`), so nothing on our side can reduce the book's PO.
The only mechanical fix would be to CANCEL that live PO in AutoCount, which is a
procurement decision, not a sync.

**Fix.** Owner ruling 2026-09-10 ("你决定 我autocount parallel run而已"): the
book is a parallel run, not worth cancelling a live PO for two documents. Archive
the outbox rows (`archived_at = now()`, 0277 forbids DELETE) via
`backend/scripts/repair-archive-so-013346-009373.mjs`. The ERP stays correct;
the book keeps its old copy of these two until a manual AC reconcile. Verified
by a fresh-connection shape check that both docs have zero live rows after.

**Ref.** `fix/ac-archive-so-013346-009373`, 2026-09-10.
