## A line's photo printed (photo) with no picture because the PDF fetched only the .thumb, which AutoCount-cutover photos never have [high]

<!-- area: Purchase orders + GRN + PI -->

**Symptom.** The owner, printing `HC-PO-2609-072` (a From-SO transfer off
`HC-SO-010940`, HOOKKA supplier): 「系统显示 photo 是有的，怎么打印时候没有
带上？」 Both TRION lines show their reference thumbnail in the PHOTOS column on
the detail page, and the printed PDF's description even reads " (photo)" on each
line — but the ITEM PHOTOS block at the foot of the sheet is empty. On a
bedframe/sofa the photograph IS the build instruction, so the supplier receives
a sheet that promises a picture and carries none.

**Root cause (traced).** Not a data gap — the objects are in R2 and the detail
page proves it. The two lines' `photo_urls` (read from prod, `scm`
`purchase_order_items`, 2026-09-11) are the source SO's keys, carried on convert
(mig 0274): `so-items/HC-SO-010940/<soItem>/ac-758952-1.jpg`. The `ac-<DtlKey>-<n>`
shape is the AutoCount cutover import (`docs/bugs/0343-…`) — bulk-uploaded to R2
outside the client compress pipeline, so **no `.thumb` sibling was ever
generated for them.**

The print and the screen then disagree because they fetch differently:

- **Screen** — `so-line-photo.ts` `loadPhotoBlob` is *thumb-first, base-on-404*:
  the `.thumb` request 404s, it falls back to the original, the tile renders.
- **PDF** — `pdf-item-photos.ts` `collectPhotoImages` fetched `key + ".thumb"`
  and **only** that; its `catch` skips a failed key silently and there was no
  base fallback. The backend proxy is no safety net — `poItemPhotoProxyHandler`
  does `R2.get(photoKey)` and returns 404 when the `.thumb` object is absent, it
  does not fall back server-side. So every cutover photo was dropped from the
  print.
- **The " (photo)" marker** is appended from `photoKeysOf(it.photo_urls)` length
  alone (independent of any fetch), so it prints whether or not the image was
  fetched — hence "(photo)" with no picture.

Same code path on all three document PDFs (SO / PO / DO), so the SO and DO
sheets dropped these photos too.

**Ruled out.** (1) Not the "object never uploaded" gap of `docs/bugs/0720-…` /
`0717-…` — those originals are absent from R2; here the originals exist (the
screen shows them). (2) Not the `sofaPhotos` artwork-map arg of `docs/bugs/0556-…`
— that is the code-drawn compartment art, a different wire than the per-line
`photo_urls`. (3) Not a missing `ownerId` — `id` rides `ITEM_COLS`, and the
on-screen strip (which needs the same id for its signed/proxy read) works.

**Fix.** `fetchLinePhotoForPdf(fetchExact, baseKey)` in `pdf-item-photos.ts` —
thumb-first, base-on-404, mirroring the on-screen loader — is now the one way
the SO / PO / DO generators fetch a line photo (each passes its own authed
`fetch{So,Po,Do}ItemPhotoBlob`). Size-safe: `blobToSquarePdfImage` downscales
to `PDF_THUMB_PX` (1536) and never upscales, so the embedded bytes are identical
whether a thumb or an original was fetched; only the bytes pulled at print time
differ. Test in `pdf-item-photos.test.ts` pins all three arms (thumb hit; thumb
404 → base; both fail → reject); proved RED against the unfixed thumb-only
fetch. The existing delivery-order "failed fetch never breaks the sheet" test
still passes (its mock rejects every key, so both arms reject and the sheet
renders the marker as before).

**Ref.** fix/pdf-line-photo-thumb-fallback, 2026-09-11.
