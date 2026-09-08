## The Delivery Order printed unreadably on the dot-matrix printer it goes through [high]

<!-- area: Delivery, DO, returns -->
<!-- status: fixed -->

**Symptom.** Owner, 2026-09-08: 「delivery order 需要修改为黑白色而已 / 需要在这个打印机
打印 / 目前打印了会看不清楚，字体需要放大一些 / 字体统一」. The printer is an Epson
LQ-310 (24-pin impact, black ribbon) and the paper is 9.5 x 11 inch 2-ply
continuous form. The sheet came out faint and hard to read, worse on the
second ply.

**Root cause (traced).** The DO renderer (`frontend/src/vendor/scm/lib/delivery-order-pdf.ts`)
was the 2026-08-07 Theme C "Ink & Petrol" design, a CSS handoff reproduced in
jsPDF for a screen and a laser printer. Four of its properties are each a
mechanism on an impact printer, and all four are in the source, not inferred:

1. **Grey ink everywhere.** `delivery-order-theme.ts` declared six inks
   (`inkSecondary` #414539, `inkMuted` #767b6e, `inkFaint` #9aa093,
   `tableHeadInk`, `statusInk`, `brass`) and the renderer set them on labels,
   addresses, the em-dash placeholders, the column headers, the footer and the
   signature fields. There is no grey ribbon: the Windows driver dithers a grey
   glyph into a sparse dot pattern, and the carbonless second ply receives a
   fainter copy of that pattern.
2. **Tinted fills under text.** The paper panel (`roundedRect(..., 'FD')` over
   `T.paper` #f4f6f3), the brass doc-number pill, the teal status pill and the
   rounded table-header band were all fills. A fill dithers into a field of dots
   UNDER the words, which is the one thing an impact printer cannot make legible.
3. **Two faces, most of it small courier.** `MONO = 'courier'` was set on the
   whole table (`styles.font: MONO`), the eyebrows, the doc number, dates,
   phone, debtor code and page label, at 7.5–9pt; the description column was
   switched back to helvetica per cell. Courier's thin strokes at 7.5pt are
   below what 24 pins at 180dpi can form, and the mix is the 「字体不统一」 he
   named.
4. **A4 page on an 11-inch form.** `new jsPDF({ format: 'a4' })` and
   `PAGE_H = 297`. 9.5 x 11 continuous paper is 8.5 in wide between the
   perforations and 11 in tall, i.e. Letter (215.9 x 279.4mm). A4 is 18mm
   taller, so a print dialog set to fit shrinks every sheet by ~6%, and every
   font size on it with it. LIKELY rather than PROVEN for his exact dialog
   setting — the three mechanisms above are proven from the source regardless,
   and Letter is the correct sheet either way.

**Fix.** The theme is one ink (black) and no fills; the face is helvetica only,
at a named scale (`DO_SIZE`) with a 9pt floor; the page is Letter. Pills became
bold text, the paper panel a stroked rectangle, the header band a heavy rule,
the dotted signature fields solid rules (a row of 0.11mm dots is exactly the
mark an impact printer cannot form). The Consignment Note reuses this renderer
and gets the same treatment. Pinned in `delivery-order-template.test.ts`:
*"no fill of any colour, every ink pure black"*, *"one face, and nothing under
the 9pt floor"* and *"the page is Letter"* — each measured off the DRAWN output,
with autoTable's own style setters in the population. All three are RED on the
unfixed tree by construction (the old sheet had fills, six inks, courier and A4).

**Not changed.** The shared ITEM PHOTOS block (`pdf-item-photos.ts`) still prints
its item code at 6.5pt grey 110 beside the row chip — that block is shared with
the SO and PO PDFs and a photo does not survive an impact printer anyway. It is
absent unless a line carries a photo.

**Ref.** claude/delivery-order-print-optimization-xbwnes, 2026-09-08.
