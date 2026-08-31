## Purchase order line photographs never reached the account book [medium]

**Symptom.** Asked whether a purchase order's line photographs go to AutoCount the
way a sales order's do, the answer was no — and nobody had ever said so out loud.
The pictures were imported (`import-po-line-photos.mjs` wrote them) and they show
in the ERP, but the account book's Further Description stayed empty on every
purchase line the ERP has ever edited.

**Root cause (traced).** Not a fault — a deliberate hold that outlived its reason.
`composePoState` set `photos: undefined` with the note *"the sales order is the one
shape proven against the live book, and a purchase order's pictures are a second
rollout with its own evidence, not a free ride on this one"*, and `PO_ITEM_COLS`
did not select `photo_urls` at all, so the data was not even read.

The sales-order rollout has since been proven on the live book (the
`\wmetafile8` shape, `docs/autocount-further-description-photos.md`), which is the
evidence that hold was waiting for.

**Fix.** Two lines: `PO_ITEM_COLS` now selects `photo_urls`, and `composePoState`
composes `photos: photosOf(poRows)`. Nothing else needed changing, and that is
worth recording because it is what made the hold cheap to lift:

* `photosOf` reads `linked_ac_dtlkey` + `photo_urls` off the RAW row and is
  document-type agnostic already;
* the drain's photo step keys off `row.op === 'edit' && payload.photos?.length`,
  not off the document type;
* `AcSyncService`'s line loop is `dynamic`, so `Photos` becomes
  `FurtherDescription` on a purchase detail exactly as on a sales one
  (`AcSyncService.cs`, the `it.ContainsKey("Photos")` branch).

Owner, 2026-08-31, asked directly whether purchase orders should send them too:
**「要」**.

**Test.** `a purchase line photograph travels, keyed by the AutoCount line` in
`src/scm/lib/autocount-outbox.test.ts`.

**UNTESTED against the live account book.** No purchase-order photograph has been
pushed into AutoCount yet; the sales-order path is what carries live proof. The
failure mode if the book refuses is a `failed` outbox row, not a silent
divergence — same as every other edit.

**Ref.** feat/po-line-photos, 2026-08-31.
