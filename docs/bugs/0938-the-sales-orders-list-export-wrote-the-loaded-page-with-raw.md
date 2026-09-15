## The Sales Orders list Export wrote the loaded page with raw sen and ERP labels, not every filtered order line by line [medium]

**Symptom.** The owner, 2026-09-15: the list's Export must hold every order the
current filter, tab and search match, one row per line, "exactly like AutoCount".
It actually wrote something else:
- only the orders on the screen page;
- one row per order;
- amounts as sen integers (RM 15,000.00 came out as 1500000);
- headers the ERP's own ("Customer", "Salesperson") instead of AutoCount's captions.

**Root cause (traced).** `MfgSalesOrdersListV2.tsx` gave DataTable no line export, so
the toolbar Export ran DataTable's CSV path over `sortedRows`. That is the page the
server sent (`useMfgSalesOrdersPaged`, `page`/`pageSize`). Each money column's
`getValue` returns sen for sorting, and the CSV wrote `getValue`.

A first server reader (`/export/lines`, one request for the whole listing) was measured
read-only against production before it reached a screen
(`backend/scripts/check-so-do-line-export.mjs`, 2026-09-15). The Houzs "All" export
made **1,923 PostgREST requests in one call**, over a Worker invocation's
subrequest cap, so it would have failed in production.

**Fix.**
- **Grid.** The list passes `exportLines`: every matched order in the list's own row shape,
  with `lines` attached by the same `attachSoLines` the list page uses.
  - `GET /mfg-sales-orders/export/rows` serves windows of at most 500 orders
    (`readExportWindow`), and `fetchSoExportRows` reads them until `next` is null.
  - The columns carry AutoCount's captions and the book's spellings.
  - Money exports in ringgit (`exportValue` + `money` / `rate`).
- **Tests** (all 4 page tests failed against main's page):
  - `frontend/src/pages/scm-v2/MfgSalesOrdersListV2.export.test.tsx`: AutoCount layout header, one row per line, no sen, refusal of an oversized listing;
  - `so-do-list-columns.test.tsx`: no sen (fails when a money column exports sen);
  - `backend/src/scm/routes/sales-order-exports.test.ts`: every order in windows, none twice.
- **Production check** (read-only): every case matched a direct SQL read line id by line
  id, both companies, at most 332 requests per window.

**Ref.** feat/so-do-line-export, 2026-09-15.
