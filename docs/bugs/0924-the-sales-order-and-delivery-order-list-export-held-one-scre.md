## The Sales Order and Delivery Order list Export held one screen page, not every filtered order [medium]

**Symptom.** The same defect docs/bugs/0916 recorded for the Purchase Order
list, on the two sales lists: pressing Export on the Sales Orders or Delivery
Orders list wrote the rows the grid had loaded — one page, 50 by default — and
nothing in the file or on the screen said it was partial. There was no
line-level export at all (owner 2026-09-15: one row per line item, every row
the list's filter matches).

**Root cause (traced).** `MfgSalesOrdersListV2.tsx` and
`MfgDeliveryOrdersListV2.tsx` rendered `DataTable` with `exportName` and no
`onExport`, so `DataTable.handleExport` wrote `sortedRows`, which on these
server-paginated lists is ONE page. The Status cell exported the stored enum
(`CONFIRMED`, `LOADED`) rather than the word the pill shows (`Submitted`,
`Confirmed`). Server-side there was no read an export could call that matched
the same documents: the SO list's predicates (sales scope, company, the
second-level `f` rows, tab, search, date window) and the DO list's filter lived
inline in their `GET /` handlers.

**Fix.** The SO predicates moved to `backend/src/scm/lib/so-list-read.ts`
(`prepareSoListRead`, `fromSoList`, `orderSoList`) and the DO filter to
`lib/do-list-read.ts` (`filterDoList`, `fromDoList`, `orderDoList`); both list
handlers read through them. `GET /mfg-sales-orders/export/lines` and
`GET /delivery-orders-mfg/export/lines` read every matching document and every
line through the same functions on the shared reader
(`lib/document-line-export.ts`); the DO file has no price or amount column. On
the pages, `use-sales-list-exports.ts` adds **Export lines** to the header and
gives `DataTable.onExport` a reader that pages the list endpoint itself with the
list's own parameters (`vendor/scm/lib/sales-list-export.ts`), refusing a
listing that moved while it was read; the Status column exports the pill's word.

Pinned by `backend/src/scm/routes/sales-order-exports.test.ts` and
`delivery-order-exports.test.ts` (1,205 / 1,105 documents past a 1,000-row fake
ceiling; tab, search, the `f` row, company scope on header and line reads). RED
observed by mutation: dropping the `f` rows in the SO handler failed 2 of 8
cases; dropping the tab and search in the DO handler failed 3 of 9; deleting
the `onExport` wiring from the SO page failed
`frontend/src/pages/scm-v2/use-sales-list-exports.test.tsx`.

**Not covered.** The grid's per-column funnels filter only the loaded page in
the browser, so the exports ignore them (as on the Purchase Order list). The
phone SO and DO lists have no export, and import is desktop-only by the owner's
decision (「手机不需要导入」).

**Ref.** feat/so-do-line-export, 2026-09-15.
