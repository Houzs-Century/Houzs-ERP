## The purchase and delivery return lists exported the loaded rows as a CSV, amounts in sen, one row per return [medium]

<!-- area: Delivery, DO, returns -->

**Symptom.** Owner, 2026-09-15: every transaction list's Excel export must be AutoCount's
listing format — one row per line, the grid's visible columns, every row the filters
match, money as AutoCount prints it. He reported amounts arriving as raw sen (150000).
On both return lists the toolbar Export wrote a CSV of the rows already loaded on
screen, one row per return, `Credit` / `Refund` in sen and the stored status code.

**Root cause (traced).** Neither list gave DataTable anything but its header columns:

- `frontend/src/pages/scm-v2/PurchaseReturnsListV2.tsx` (merge base `680a0bb64`):
  `columns` held Return No., Date, Transfer From, Supplier, Code, Reason, Status and
  Credit with `getValue: (r) => refundOf(r)` — sen — and no `exportLines`, so
  `DataTable.handleExport` wrote `toCSV(sortedRows, …)`: the loaded rows only.
- The rows were `GET /purchase-returns` capped at `.limit(300)`
  (`backend/src/scm/routes/purchase-returns.ts`), and `GET /delivery-returns` at
  `.limit(500)` (`delivery-returns.ts`). No read carried a return's lines.
- `DeliveryReturnsListV2.tsx` the same: `refund` and the ten finance columns
  exported `*_sen`.

Observed on the unfixed tree by mounting the real Purchase Returns page and pressing
Export: no server call, one file `purchase-returns-2026-09-15.csv` holding
`Return No.,Date,Transfer From (GRN),Supplier,Code,Reason,Status,Credit` and
`HC-PRT-2610-0001,2025-10-28,HC-GRN-000610,ANNEX DESIGN SDN BHD,400-A003,ITEM DAMAGED-CUSTOMER REJECTED,POSTED,207950`.

**Fix.** Both lists export through DataTable `exportLines` (one row per line, visible
columns, funnels and sort) over `GET /purchase-returns/export/rows` and
`GET /delivery-returns/export/rows`, which read through the lists' own filter, company
and sales scope with no cap and attach lines with the function the list uses. The
default columns are AutoCount's own Detail Listing columns (read from AutoCount 2.2's
form resources), money in ringgit, unit price a rate, dates real Excel dates.
Tests: `frontend/src/pages/scm-v2/PurchaseReturnsListV2.export.test.tsx` (4) and
`DeliveryReturnsListV2.export.test.tsx` (5), both RED on the unfixed lists (4/4 and
5/5 failed), including "no money cell is in sen";
`backend/src/scm/routes/purchase-return-exports.test.ts`,
`delivery-return-exports.test.ts`. Read-only production check
`backend/scripts/check-return-line-export.mjs`: MATCH line id by line id for every case.

**Ref.** feat/return-line-export, 2026-09-15.
