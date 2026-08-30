## The book's NONE placeholder outranked the derived branding, and the fair report dropped an order the day it was delivered [high]

Four defects the owner found in one Sales Report review (2026-08-30/31). All
four are measured on production, not inferred.

**1. Branding renders "NONE" on a bedframe.** Owner: 「我这个 BedFrame，它的
branding 不是 BedFrame 呢?」 (HC-SO-013402, a TRION frame). Root cause: the SO
header carries the LITERAL text `NONE`, copied faithfully from AutoCount's
free-text branding field — **170 imported company-1 orders carry it**
(measured). Every reader prefers a non-blank header over the derived label, so
`brandingLabel`'s BEDFRAME arm never ran. Fix: `isPlaceholderBrandText` in
`scm/shared/so-branding-label.ts` (a small CLOSED list — NONE / N/A / NIL / TBC
/ KIV / dashes — never a heuristic, so a real brand like "Nonesuch" survives),
consumed by the desktop list, the mobile list and the fair report. The stored
value is NOT rewritten: the import stays a faithful copy and the READERS learn
that a placeholder is not a brand.

**2. The fair report dropped orders as the business progressed.** Owner: 「很多
单都没进得来…可能因为我还没 delivered」. Root cause: `fetchFairSos` anchored on
`status = 'CONFIRMED'`, so an order left the report the moment it was
delivered — measured on 2990: **34 of 49 delivery orders were invisible**, and
the DO tab showed 14. Fix: scope is now "everything except DRAFT and
CANCELLED". A fair's completed business is still its business.

**3. LEGACY was pinned on 11 of 14 rows by the delivery-fee line.** The chip
means "a stock line fell back to the order-time estimate", but it was set by
ANY line with no frozen ship cost — and a SERVICE line never has one. Fix:
service lines are excluded from the verdict (their cost still sums unchanged).

**4. A DO frozen at zero rendered as a naked 100% margin.** 2990-DO-2607-021:
three BOOQIT pieces shipped before any lot existed, so FIFO froze them at 0.00
(the ship-anyway fingerprint) while the order-time estimate was RM 887.90 each.
The zero is the truth and is NOT patched over; `doCostTotal` now also returns
`has_zero_frozen` and the row carries `do_cost_ship_anyway` so the margin is
readable as "cost not captured at ship time", not as a free sale.

**Fix.** All four proved RED first in `src/scm/lib/fair-report.test.ts` (service
line does not flag legacy; zero-frozen with a real estimate flags ship-anyway;
a genuinely free line does not), `so-branding-label.test.ts` (placeholder
spellings blank-equivalent; real brands never swallowed) and
`tests/fairReport.route.test.ts` (a DELIVERED order is in scope, DRAFT and
CANCELLED are not). Both route suites' fake PostgREST builders learned
`.not(col,'in',list)`.

**Ref.** fix/report-branding-po-link, 2026-08-31.
