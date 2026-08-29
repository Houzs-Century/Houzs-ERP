## The same PO printed differently depending on which button raised it [medium]

**Symptom.** The owner printed three Purchase Orders and asked why they did not
match — 2026-08-28: 「为什么感觉不是全部都一样的？第一张照片是比较漂亮的」. One
sheet showed a properly drawn corner sofa; two showed the crude fallback
schematic.

**He also asked the right diagnostic question himself** — 「还是因为是旧的 order
只对新的 order 影响？」 — and the answer is no: the sofa plan is drawn at PRINT
time and nothing about it is stored on the document, so an old PO and a new one
print identically. That ruled out the data and left the code.

**And a second one, which is the useful one:** 「我的 PO 的 documentation 不是应该
只有一个 documentation 吗？怎么会有那么多个 documentation 呢？」 There IS one
document. `purchase-order-pdf.ts` is the only generator and the layout has never
been duplicated. What there were FIVE of is BUTTONS:

| surface | passed `sofaPhotos` |
|---|---|
| `PurchaseOrderDetailV2` | **yes — the only one** |
| `PurchaseOrderDetail` (the edit page) | no |
| `PurchaseOrdersListV2` (two exports) | no |
| `printDocumentPdf` (right-click chain print) | no |

**Root cause.** The artwork map was an OPTIONAL ARGUMENT the caller had to
remember. Four of the five did not, so they printed the schematic. The corner
sofa looked right in all of them only because that path is code-drawn and needs
no bitmap — which is exactly why one of the three sheets looked better and made
the difference visible.

**Fix — the generator fetches it itself.** Passing it at five call sites is the
arrangement that produced the defect; a sixth caller would have reproduced it.
`loadSofaCompartmentArtForPrint()` sits beside the supplier/fabric lookup the PO
print already does at print time, so it is not a new kind of thing.
`opts.sofaPhotos` still wins when supplied, so the V2 detail — which already
holds the map from its own query — spends no second request, and tests can
inject. A failed config read returns `{}` and every cell draws its schematic: a
print must never fail for want of a picture.

**The test pins it from both ends** and counts the callers that pass the map, so
it fails when a FIFTH one appears — the moment somebody should think about this
again, rather than the moment a supplier receives a different-looking sheet.
Checked RED: removing the fetch fails it.

**Ref.** fix/every-print-path-draws-the-sofa-art, 2026-08-28.
