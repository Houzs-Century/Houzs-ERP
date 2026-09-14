## Print all on the Purchase Order and Sales Invoice lists skipped the Print preview [low]

<!-- area: Purchase orders + GRN + PI -->

**Symptom.** Owner, 2026-09-14, holding up the Delivery Order list's merged-PDF
preview (8 documents, "Merged into: one PDF file, each document on its own page",
View full PDF / Print now / Download PDF): 「PO打印没有这个」. Ticking purchase
orders and pressing **Print all** went straight to a "One combined PDF / Separate
files" prompt and a file in Downloads, with no preview and no way to send the
stack to the printer.

**Root cause (traced).** The Print preview was made the one dialog for every
print on 2026-08-06 (#1665, owner: 「全部打印的时候都需要有这个」), and each list's
batch print was moved onto it by hand: `usePrintPreview(deliver)` +
`<PrintPreviewBatchModal>`, with the combined-or-separate prompt kept only on the
Download exit. Six of the eight lists that merge documents with a
`generateCombined...Pdf` call got it. `PurchaseOrdersListV2.tsx` (`printSelectedPos`)
and `SalesInvoicesListV2.tsx` (`printSelectedSis`) were still wired
`onClick={() => void print...()}` straight to `askChoice`, and never passed an
`action` to the generator, so Print now did not exist for them. Found by listing
every file outside the generators that calls `generateCombined...Pdf` and checking
each for `usePrintPreview(`: 8 callers, 2 without.

**Fix.** Both lists now follow the Goods Received list: `deliverSelectedPos` /
`deliverSelectedSis` take the `PdfAction`, Print now and View render one merged
file without asking, Download still asks combined-or-separate, and the preview
names the stack (PO numbers as the list shows them, with `_R` revisions).
`frontend/src/pages/scm-v2/PurchaseOrdersListV2.printPreview.test.tsx` mounts the
real PO list; `frontend/src/pages/scm-v2/batchPrintGoesThroughPreview.test.ts`
finds the population by scanning for `generateCombined...Pdf` calls, so a ninth
batch-printing list without the preview fails. Proved RED: on the unfixed lists the
PO test fails all 4 cases and the scan fails exactly the PO and SI lists.

**Ref.** feat/po-list-print-preview, 2026-09-14.
