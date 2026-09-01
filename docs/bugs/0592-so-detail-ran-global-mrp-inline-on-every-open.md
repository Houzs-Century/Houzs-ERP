## SO detail ran global MRP inline on every open (~4.7s cold); deferred to a separate endpoint [med]

**Symptom.** Opening any Sales Order took ~4.7s on a cold DB connection before
the detail rendered. The whole delay was spent computing the per-line live
"Stock" badge, a purely informational column.

**Root cause (traced).** `GET /:docNo` (`backend/src/scm/routes/mfg-sales-orders.ts`)
ran the GLOBAL company-wide MRP allocation INLINE on the critical path: its
`Promise.all` awaited `soCoverage(c, sb)`, which calls `computeMrp` (~105 DB
round-trips — it walks every live SO line and every open PO across the company),
and the handler then awaited `soLineReadySourcePos(...)` on top. Neither can be
narrowed to one order (a line's coverage depends on what higher-priority lines
already claimed), so the entire company MRP ran just to paint one order's badge.
The list route had already been deferred this way (2026-08-18); the detail had
not, so it still paid the full run on every open.

**Fix.** Removed `soCoverage` from the detail's `Promise.all` and removed the
`soLineReadySourcePos` await. The detail now returns FAST using only the persisted
`stock_status` column: MRP-derived line fields fall back to their no-MRP defaults
(`stock_state` = `'stock'` for service lines else null; `coverage_po` /
`coverage_eta` = null; `ready_source_pos` = []; `stock_status_effective` computed
with the live state passed as `null`, so the STORED engine verdict stands). The
exact removed computation moved to a NEW deferred `GET /:docNo/coverage` endpoint
(same MRP run, same per-line rule) that the client calls after the doc renders.
Computation UNCHANGED, no caching, no staleness — just off the critical path.
Pinned by `backend/tests/soLineEffectiveStock.test.ts` ("every line-detail
handler publishes the verdict"), updated 2→3 handlers and proved RED on the
unfixed tree (`expected 3 to be 2`).

**Ref.** perf/so-detail-defer-mrp, 2026-09-01.
