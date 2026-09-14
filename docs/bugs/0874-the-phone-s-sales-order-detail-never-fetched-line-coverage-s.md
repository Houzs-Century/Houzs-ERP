## The phone's Sales Order detail never fetched line coverage, so it could not show a line's incoming purchase order [medium]

**Symptom.** Found while tracing staff issues #18 / #19 (2026-09-14: "this sales
order already has a purchase order, why does the line not show it?"). On the
phone, a sales-order line waiting on a purchase order shows no incoming PO chip
and no READY source, whatever the purchase order says.

**Root cause (traced in code).** Since 2026-09-01 (docs/bugs/0592) `GET
/mfg-sales-orders/:docNo` returns `coverage_po: null`, `stock_state: null` and
`ready_source_pos: []` for every stocked line; the live values come from a second
call, `GET /mfg-sales-orders/:docNo/coverage`. `SalesOrderDetailV2` makes that
call and overlays it, and the list drill-down was fixed for the same miss in
docs/bugs/0598. `frontend/src/mobile/MobileSODetail.tsx` read only
`useMfgSalesOrderDetail` — `git grep useSoLineCoverage frontend/src/mobile`
returned nothing — and `SourcePosRowMobile` renders the incoming chip only when
`stock_state === "po" && coverage_po`, so on the phone that condition could not
be true. What a phone user actually saw on production was NOT observed (no
authenticated browser session was available); the conclusion rests on the code
path above.

**Fix.** `MobileSODetail` calls `useSoLineCoverage(docNo)` and overlays it onto
its lines with the same `overlaySoLineCoverage` the desktop uses.
`src/mobile/mobileSoDetailCoverage.test.ts` pins both, proved RED on the unfixed
file (`2 failed`); the overlay itself is covered by
`src/vendor/scm/lib/so-coverage-overlay.test.ts`.

**Ref.** fix/mobile-so-detail-coverage, 2026-09-14.
