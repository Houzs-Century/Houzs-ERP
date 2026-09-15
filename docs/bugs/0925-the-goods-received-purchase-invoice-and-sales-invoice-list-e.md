## The Goods Received, Purchase Invoice and Sales Invoice list Export held one screen page, not every document the filters match [medium]

**Symptom.** Owner, 2026-09-15, after the Purchase Order list's Export was found
to hold one page (`docs/bugs/0916-the-purchase-order-list-export-held-one-screen-page-not-ever.md`):
every document list must export **every row of its current filter/tab/search
across all pages**, one row per line item. The Goods Received, Purchase Invoices
and Sales Invoices lists had the same toolbar Export and no line export at all.

**Root cause (traced).** The same line as 0916, on three more pages.
`GoodsReceivedListV2.tsx`, `PurchaseInvoicesListV2.tsx` and
`SalesInvoicesListV2.tsx` rendered `DataTable` with `exportName` and no
`onExport`, so `DataTable.handleExport` (`frontend/src/components/DataTable.tsx`)
wrote `sortedRows` — the one page the server had sent (50 by default,
`useLocalStorage("scm:perpage:grns" | "scm:perpage:purchase-invoices" |
"scm:perpage:sales-invoices", 50)`). Each list's tab / search / sort filter lived
only inside its `GET /` handler (`routes/grns.ts`, `routes/purchase-invoices.ts`,
`routes/sales-invoices.ts`), so no read existed that an export could call and
match the same documents. The Status column also exported the stored enum
(`POSTED`, `SENT`) rather than the word on screen.

**Fix.** Server half in #3925: each list's filter + sort moved to
`backend/src/scm/lib/{grn,pi,si}-list-read.ts` (the list handler builds through
it; the SI one takes the caller's sales scope as a required argument), and
`GET /{grns,purchase-invoices,sales-invoices}/export/{headers,lines}` read every
matching document through it, paged past the PostgREST ceiling, on the shared
`lib/document-line-export.ts`. Page half here: an **Export lines** button on each
list (`.xlsx`, one row per line, columns from the mirrored
`{grn,pi,si}-line-export-columns.ts`), and `onExport` so the toolbar Export asks
`/export/headers` for the whole filtered set with the grid's visible columns
(GRN/PI heal Assigned SO / Delivered, PI heals "vs PO price", for every row). The
request parameters come from `grnListParams` / `piListParams` / `siListParams`,
which the paged list hooks now also build from. A read the server had to stop
(`truncated`) is refused, never written. Status exports the list's word.

Pinned by `frontend/src/pages/scm-v2/{GoodsReceivedListV2,PurchaseInvoicesListV2,SalesInvoicesListV2}.export.test.tsx`
— RED on the unfixed pages: 4 / 4 / 5 failed, the toolbar-Export case with
`AssertionError: expected undefined to be defined` (no `/export/headers` request;
the page CSV was written) and the Export-lines cases with `Unable to find an
accessible element with the role "button" and name "Export lines"`; GREEN after —
and by the backend route tests of #3925 (company scope removed → RED).

Production proof (read-only, run 34941927326, 2026-09-15): each export's own
builder against a direct SQL read, Line ID by Line ID, per company, for a tab,
All, a 45-day date window and (SI) one seller's scope — every case MATCH, e.g.
GRN company 1 All 542 receipts / 1,077 lines, PI company 2 posted tab 37 / 89 of
All 56 / 133, SI company 1 one seller 3 / 16.

**Not covered.** The grid's per-column funnels filter the loaded page in the
browser; the server never sees them, so the exports ignore them (as on the PO
list). The phone lists have no export (`mobile/MobileModuleList.tsx`); import is
desktop-only by the owner's decision (「手机不需要导入」, 2026-09-15).

**Ref.** feat/gr-pi-si-list-export-buttons (#3925 for the server half), 2026-09-15.
