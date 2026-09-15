## The Delivery Orders list export wrote the loaded page, one row per order, with the Amount in sen [medium]

**Symptom.** The owner (2026-09-15) wants every transaction list to export the
way AutoCount lists it: one row per line, the columns the grid shows, every
document the tab and search match, money in ringgit. The Delivery Orders list's
Export gave a CSV of only the page on screen, one row per delivery order, and
its Amount column carried the stored sen (from the code path below; a RM 6,970.00
order would read 697000 — not observed on a production file).

**Root cause (traced).** `MfgDeliveryOrdersListV2` passed neither `onExport` nor
`exportLines` to DataTable, so `handleExport` fell through to its default:
`downloadCSV(toCSV(sortedRows, csvCols))` over `sortedRows`, the loaded page.
The Amount column's `getValue` was `r.local_total_sen` with no `exportValue`,
so the CSV cell was the stored sen. Observed by the page test below on the
unfixed page: no workbook is written (the CSV path ran instead) — 7 of 8 cases
fail.

**Fix.** The page passes `exportLines` reading
`GET /delivery-orders-mfg/export/rows` through `fetchDoExportRows`
(`vendor/scm/lib/so-list-export.ts`), which throws on a truncated read. DataTable
applies the grid's visible columns, funnels and sort and writes one sheet row
per line; money columns carry `exportValue` in ringgit (`moneyColumn`,
`financeColumns`). The default CSV path no longer runs on this list. The Columns
panel offers "AutoCount: LISTING ITEM DETAIL" (no prices) without changing the
default layout. Pinned by
`frontend/src/pages/scm-v2/MfgDeliveryOrdersListV2.export.test.tsx`, proved RED
on the unfixed page (7 failed, 1 passed) and green after (8 passed).

**Ref.** feat/do-list-grid-export, 2026-09-15.
