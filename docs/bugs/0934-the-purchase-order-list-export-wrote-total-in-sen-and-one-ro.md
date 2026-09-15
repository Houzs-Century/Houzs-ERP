## The Purchase Order list Export wrote Total in sen and one row per order [high]

**Symptom.** Owner, 2026-09-15, with `purchase-orders-2026-09-15 (1).csv` (313 rows)
from the Purchase Orders toolbar Export: still one row per PO; the Items cell
joined every line as `CODE×qty · CODE×qty`; the Supplier SKU cell joined SKUs with
` · ` so they no longer lined up with the items; quantity existed only as the
`×1` suffix; and Total was in SEN — HC-PO-009304 exported `1500000` for
RM15,000.00. He asked for AutoCount's shape: one row per line, the columns he
shows, following his filter and view.

**Root cause (traced).** The export wrote each column's `getValue`. On the PO list
`getValue` for Total is `totalOf(r)` — `total_sen`, the stored integer the grid
sorts on — and nothing converted it for a file. The Items / Supplier SKU columns'
`getValue` were the joined per-PO summaries (`itemsSummaryOf`, `supplierSkusOf` in
`PurchaseOrdersListV2.tsx`), because the export had no notion of a line: DataTable
could only write one row per grid row. The column funnels were not applied
because #3915's `onExport` handed the server set straight to `toCSV`.

**Fix.** The list uses DataTable `exportLines` (#3935): one row per PO line over
every order the tab / search / sort match, the grid's visible columns in order and
under their labels, after the grid's own funnels and sort. Line columns carry a
per-line `lineValue` (Item Code = the supplier's code, SO Doc No., Remaining Qty,
dates, …); Total carries `exportValue` in ringgit with `exportFormat: "money"`;
Unit Price and Line Total are ringgit numbers (rate / money). A fresh list shows
AutoCount's PO listing columns in AutoCount's order.

Pinned by `frontend/src/pages/scm-v2/PurchaseOrdersListV2.export.test.tsx`: "writes
NO money cell in sen" (every Total / Unit Price / Line Total cell equals the stored
sen / 100), "a fresh list exports AutoCount's columns, in AutoCount's order, one
row per line", "exports only the columns the grid shows", "follows the grid's
funnel over the whole fetched set". RED on the old page: the previous version of
this test file expected the joined one-row-per-PO shape and the separate "Export
lines" button, which the new cases replace.

**Ref.** feat/po-export-follows-grid, 2026-09-15.
