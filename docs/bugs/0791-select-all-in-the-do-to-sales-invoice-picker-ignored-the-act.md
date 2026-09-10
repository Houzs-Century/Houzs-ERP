## Select all in the DO to Sales Invoice picker ignored the active search and ticked every loaded row of the locked customer [medium]

**Symptom.** On "Pick Delivery Order lines to invoice" (`SalesInvoiceFromDo`),
searching a customer (e.g. "wendy") narrowed the grid to a few rows, but clicking
**Select all** produced "Continue with 322 lines" - every loaded DO line of the
already-locked customer, not the rows on screen. Owner: "为什么显示只有3line - 当我
Select all 为什么是 322 line".

**Root cause (traced).** `selectAll` iterated the parent's raw `rows` prop (every
loaded line) and seeded the customer lock from `rows[0]` - the first row of the
UNFILTERED list - not the post-search rows the grid displays
(`SalesInvoiceFromDo.tsx`, pre-fix `const key = ... rows[0]` and
`for (const r of rows)`). The DataGrid already exposes its filtered set via
`onFilteredRowsChange`, but this page never wired it up, so select-all had no idea a
search was active; the comment above it even claimed it acted on "currently-VISIBLE
rows" while the code contradicted it. The sibling picker `DeliveryOrderFromSo` had
the IDENTICAL bug and fixed it 2026-08-03 (it had carried a wrong customer's SO into
a new DO); this DO->SI twin never got the same fix.

**Fix.** Ported the sibling's idiom: a `visibleRows` state fed by
`onFilteredRowsChange={setVisibleRows}`; `selectAll` now iterates `visibleRows` and
seeds the lock from the first VISIBLE row, still respecting the single-customer
lock. The behaviour swap is one source line, `for (const r of rows)` ->
`for (const r of visibleRows)` (plus seeding from `visibleRows[0]`). Frontend-only;
mobile (`MobileConvertWizard`) has no equivalent affordance - it selects a single
source DO first, so one customer is pinned by construction. No automated test (a
UI-selection state hard to unit-test without rendering the grid); proved by
inspection against the pre-fix tree, and frontend typecheck + the lint ratchet are
green.

**Ref.** fix/scm-si-select-all-visible-rows, 2026-09-10.
