## The migrated delivery orders carried no salesperson and no delivery date [medium]

<!-- area: Cutover + migrated data -->
<!-- status: fixed -->

**Symptom.** Owner, 2026-09-08, on `HC-DO-011559` (Na E Chuen, mirrors
AutoCount `DO-011559`, `DELIVERED`): 「为什么DO没有显示客户信息」. The quick-view
drawer showed the CUSTOMER & DELIVERY card blank (Phone / Email / Address "—")
AND the header block above it blank: Salesperson "—", Customer ref "—",
Delivery date "—", Expected at "—". The printed DO had the same holes. Lines,
SO link and amounts were right.

**Two causes on one screen, and one was already closed.** The customer card is
docs/bugs/0714: `insertMigratedDo`'s INSERT never named phone / email / address,
`repair-customer-block.mjs` carried them onto production the same evening
(173 -> 0), and probe run
[`34229434908`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34229434908)
(21:01 Malaysia, after that repair) reads **0 of 185** company-1 delivery orders
without a phone and address — so the screenshot predates the repair and that
half needs nothing more.

**Root cause of the other half (traced).** The header block is blank for the
same reason and is NOT in 0714's field map. `DO_CARRY` in
`lib/customer-block.mjs` is deliberately "the contact and address block a driver
needs, and nothing else"; the writer's `UPDATE … FROM scm.mfg_sales_orders`
named those fourteen columns and none of `salesperson_id`, `agent`, `branding`,
`ref`, `customer_delivery_date`, `expected_delivery_at`. The interactive path
copies all six: `POST /delivery-orders-mfg/from-sos`
(`delivery-orders-mfg.ts:3930-3955`) takes them from the SO header through
`so-to-do-fields.ts`, and sets `expected_delivery_at` to the customer's date or
the creation date. The drawer reads the DO's own columns
(`MfgDeliveryOrdersListV2.tsx`, `row.salesperson_id`, `row.customer_delivery_date`,
`row.expected_delivery_at`) with no fallback to the SO, so a NULL row is a blank
block. Every `migrated_no_stock = true` DO in company 1 is affected.

**Fix.** The same shape as 0714, extended by six columns, one list.

1. `DO_SALES_CARRY` in `backend/scripts/lib/customer-block.mjs` — `[doColumn,
   sqlExpression]` for the six; `expected_delivery_at` is
   `COALESCE(s.customer_delivery_date, d.do_date)`, the DO's own date standing
   in for the creation date a live conversion would use. **Not in it, on
   purpose:** `venue` / `venue_id` (a canonicalising trigger rewrites them on
   write — 0714's own reason) and `sales_location` / `warehouse_id` (the
   ship-from branch from the book, owner 2026-09-07 「记在单头就好」 — never the
   order's sales branch).
2. `insertMigratedDo` (`lib/migrated-do-writer.mjs`) names the six in the SAME
   UPDATE as the customer block, so a new migrated document carries the whole
   header at once. No caller changed.
3. `backend/scripts/backfill-migrated-do-sales-fields.mjs` +
   `.github/workflows/backfill-migrated-do-sales-fields.yml` (Actions → **Carry
   the sales / delivery fields onto migrated DO headers**) for the rows already
   written. PLAN by default; apply needs `CONFIRM="I HAVE REVIEWED THE
   DRY-RUN"`; `scope` migrated|all; `do_number` for one document. ONE
   statement, ONE transaction, every SET re-asserting `IS NULL` on an
   un-aliased target (the release-discipline audit recognises a write by
   `UPDATE <name> SET`). Where the order is itself blank the field stays NULL
   and the plan names the column. Independent read-back on a fresh SELECT.

Pinned by `backend/tests/migratedDoSalesFields.test.mjs`: the list is exactly
the six and disjoint from `DO_CARRY`; every one is something `/from-sos`
already writes; the writer's UPDATE names each with the list's own expression;
the backfill imports the list, re-asserts `IS NULL`, plans by default and
requires the CONFIRM phrase. The writer assertions fail on the unfixed tree —
its UPDATE named none of the six.

**What this PR started as, and why it shrank.** It was written as a whole-header
snapshot module plus a 23-column backfill before 0714 landed on `main` two
hours earlier from another session. On the merge conflict it was cut down to
the residual rather than carrying a second copy of the customer-block rule —
a second copy of an import rule is this repo's most expensive recurring bug
class (`lib/migrated-do-writer.mjs` header).

**Ref.** `fix/migrated-do-header-snapshot-0908`, 2026-09-08. Related:
docs/bugs/0714 (customer block, same writer, same day), docs/bugs/0043 (line
snapshot, same writer), #3121 (ship-from branch, the columns this must not
touch).
