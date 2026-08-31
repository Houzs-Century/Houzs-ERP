## SO detail page blocked its first paint on live stock coverage [medium]

**Symptom.** Opening a Sales Order detail page waited on the whole response
before showing anything — and the slow part of `GET /mfg-sales-orders/:docNo`
was computing the live per-line stock coverage (stock/PO/shortage state, the
incoming-PO chip + ETA). The document header and line items could not appear
until that finished, so a heavy order felt like the page was hanging.

**Root cause (traced).** `SalesOrderDetailV2ReadOnly` derived its entire render
(header, lines, totals) from `useMfgSalesOrderDetail(docNo)` alone, and that one
endpoint returned the persisted line data AND the live coverage in the same
payload. There was one request on the critical path, so the coverage
computation sat directly in front of first paint. Confirmed by reading the
render path: `detail.data.items` was the only source for the line list
(`SalesOrderDetailV2.tsx`), and coverage fields (`stock_state`, `coverage_po`,
`coverage_eta`, `ready_source_pos`) came off those same items.

**Fix.** Companion backend PR makes `GET /:docNo` return fast with the stored
verdict and null live-coverage fields, and moves the live computation to a new
`GET /:docNo/coverage`. Frontend: new `useSoLineCoverage(docNo)` hook
(`vendor/scm/lib/sales-order-queries.ts`) fetches coverage asynchronously
(`enabled` on docNo, `staleTime: 30_000`, `retryUnlessClientError`, a 404 from
an un-deployed backend degrades to empty coverage rather than an error). The
detail page renders on the detail response alone and overlays each matching
line's `stock_state` / `coverage_po` / `coverage_eta` / `ready_source_pos` /
`stock_status` (from `stock_status_effective`) from the coverage map when it
arrives — no loading gate hides the lines. Verified `npm --prefix frontend run
typecheck -- --force` clean.

**Ref.** perf/so-detail-async-coverage, 2026-09-01.
