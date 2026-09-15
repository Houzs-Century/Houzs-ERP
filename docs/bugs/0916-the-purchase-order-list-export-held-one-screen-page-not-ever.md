## The Purchase Order list Export held one screen page, not every order the filters match [medium]

**Symptom.** Owner, 2026-09-15, comparing our Purchase Order "Export" with
AutoCount's "PO chasing list": our file was one row per PO with the items
squashed into one cell, and it held 49 rows
(`purchase-orders-2026-09-15.csv`) — while the tab it was pressed on matched
far more orders. Nothing on the screen or in the file said it was partial.

**Root cause (traced).** `PurchaseOrdersListV2.tsx` rendered `DataTable` with
`exportName="purchase-orders"` and no `onExport`. `DataTable.handleExport`
(`frontend/src/components/DataTable.tsx`) then writes `sortedRows` — the rows
the table holds, which on this server-paginated list is ONE page (the page size
is 50 by default, `useLocalStorage("scm:perpage:purchase-orders", 50)`). The
`onExport` escape hatch existed for exactly this ("export a fuller dataset (all
pages)") and the list never used it. The server could not have helped either:
the list's tab / search / sort filter lived only inside the `GET /` handler in
`routes/mfg-purchase-orders.ts`, so there was no read an export could call that
matched the same orders.

**Fix.** The list's filter + sort moved to `backend/src/scm/lib/po-list-read.ts`
and the list handler builds its query through it. Two new endpoints read EVERY
matching order through that same filter, paged past the PostgREST ceiling
(`routes/purchase-order-exports.ts`): `GET /mfg-purchase-orders/export/headers`
(the toolbar Export, list row shape, CSV) and `GET /export/lines` (the new
"Export lines", one row per PO line, .xlsx, columns in
`lib/po-line-export-columns.ts`). `DataTable.onExport` now receives the visible
export columns, so the page exports all rows with the columns on screen; the
request parameters come from `poListParams`, which `usePurchaseOrdersPaged`
also builds from. A read the server had to stop (`truncated`) is refused, not
written.

Pinned by `frontend/src/pages/scm-v2/PurchaseOrdersListV2.export.test.tsx`
(RED on the unfixed tree: the toolbar-Export case failed with
`expected undefined to be defined` — no `/export/headers` request, the page CSV
was written instead — and the Export-lines cases found no button) and
`backend/src/scm/routes/purchase-order-exports.test.ts` (1,205 orders past a
1,000-row fake ceiling; tab, search, hold marker, sort; company scope on the
header AND the line read, proved by removing the line-read predicate and
watching the scope case fail).

**Not covered.** The per-column funnels in the grid header filter only the
loaded page in the browser; the server cannot see them, so the exports ignore
them. The SO / DO / GR / PI / SI list exports still write one page — they can
plug into `lib/document-line-export.ts`.

**Ref.** feat/po-line-export, 2026-09-15.
