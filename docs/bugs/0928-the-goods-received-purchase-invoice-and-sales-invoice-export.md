## The Goods Received, Purchase Invoice and Sales Invoice exports wrote amounts in sen and carried their own fixed columns instead of the grid's [medium]

**Symptom.** Owner, 2026-09-15, after #3930 shipped: a list must have ONE
Export, one row per line, with the columns the grid shows, following its tab,
search, funnels and sort — and the file must read like AutoCount's Detail
Listing (captions, order and values). The three lists had a separate
**Export lines** button with its own fixed column set, and the toolbar Export
wrote every money column in sen (RM 3,000.01 written as 300001).

**Root cause (traced).** The grid's money columns hold sen in `getValue` so they
sort as integers, and `DataTable`'s export wrote `getValue` as-is; the lists had
no way to say "export this in ringgit". The line file came from a column
contract (`{grn,pi,si}-line-export-columns.ts`, mirrored backend / frontend) that
knew nothing of the grid, so a hidden, reordered or funnelled column on screen
had no effect on it, and its columns were ours, not AutoCount's.

**Fix.** On the DataTable mechanism of #3935 / #3948: each list passes
`exportLines`, whose `fetchRows` asks the new `GET /<doc>/export/rows` (every
document the list's filter matches, each with `lines` from the SAME
`attachGrnLines` / `attachPiLines` / `attachSiLines` the paged list uses). Money
columns carry `exportValue` in ringgit with `exportFormat` money (unit price as a
4-decimal rate). A fresh grid's visible columns are AutoCount's listing columns in
its order (`GRN_DEFAULT_COLUMN_KEYS`, `PI_DEFAULT_COLUMN_KEYS`,
`SI_DEFAULT_COLUMN_KEYS`), with AutoCount's values (the AutoCount doc number,
`bookLineItem` item code / description / group / UOM, AutoCount location code,
the variant Description 2, `resolveAcAgent`). The Export lines buttons,
`/export/lines`, `/export/headers`, the column contracts and their helpers are
removed.

Pinned by `frontend/src/pages/scm-v2/{GoodsReceivedListV2,PurchaseInvoicesListV2,SalesInvoicesListV2}.export.test.tsx`
and `si-list-columns.test.tsx`, plus the backend
`routes/{grn,purchase-invoice,sales-invoice}-export-rows.test.ts`. RED, run on
this tree with the fix reverted (2026-09-15): money `exportValue` stripped → 4 of
14 failed, e.g. `SubTotal (Ex) looks like sen: expected 300001 to be less than
100000`; `exportLines` removed → 12 of 12 page cases failed (no `/export/rows`
request, no line rows). GREEN after: 14 / 14.

**Ref.** feat/gr-pi-si-export-rows, 2026-09-15 (replaces the buttons of #3930;
`docs/bugs/0925-the-goods-received-purchase-invoice-and-sales-invoice-list-e.md`).
