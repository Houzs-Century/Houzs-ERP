## Money on some screens read as whole ringgit, as RM 15.0K, or without thousands separators instead of AutoCount's 15,000.00 [medium]

<!-- area: Money display -->

**Symptom.** Owner, 2026-09-15: 「我看到amount是那种150000，全部amount需要跟Autocount 的一样」.
The first report was an export: the Purchase Order list CSV held `1500000` for
HC-PO-009304, whose total is RM 15,000.00. The owner then widened the rule to the
whole system: every amount reads in ringgit with two decimals and thousands
separators, the way AutoCount prints it. A census of the screens found these
pages printing money in other shapes:

- **Whole ringgit.** Trip revenue on Trips and Delivery Propose showed `RM 1,235`
  (`delivery-propose-ui.tsx` `fmtRm`). The same on Auto Schedule (`rm`), Fair Report
  Fill and Setup Invoice Fill (`RM ${Math.round(n)}`), and the Projects rental
  annotation (`RM 12/sqm/day`).
- **Abbreviated.** `formatCurrency(n, { compact: true })` printed `RM 15.0K` /
  `RM 1.25M`. That hit 37 Projects sites (list columns, KPI tiles, P&L rows) and 13
  on the PnL calendar. Member Org Performance had its own `k` copy (5 sites).
- **No thousands separator.** `RM 15000.00`, from page-local
  `(sen / 100).toFixed(2)` or `ringgit.toFixed(2)`. Seen on the mobile SO add-on
  labels, the mobile and desktop zero-cost-receipt refusal, the Supplier Detail
  price cell, the SO line delivery-fee tooltip, Product Model Detail, the supplier
  portal quote line, the old Sales page, the SO/PO amendment PDF (`RM 1500.00`)
  and the product change-log (`RM1500.00`).
- **No decimals.** The order add-on price in Special Add-ons was
  `row.price.toLocaleString()`, and Share Calendar total sales went through the
  whole-MYR `fmtRM`.

**Root cause (traced).** Every one of these pages had its own formatter and did
not call the shared one. The shared formatters were already right:
`vendor/shared/format.ts` `fmtSen` / `fmtMoneySen` for sen and
`lib/utils.ts` `formatCurrency` for a ringgit number, all printing `RM 15,000.00`.
There were two exceptions. `formatCurrency` itself carried the `compact` branch
that abbreviated. `fmtRM` / `fmtMoney` in `vendor/shared/format.ts` are the 2990
POS whole-MYR helpers (§10 Decision 9) and were never meant for ERP amounts, but
Share Calendar used one. Nothing checked the SHAPE of money text, so each copy
drifted on its own. The census (AST walk over every JSX child and template
literal that renders a `*_sen` value) found no page rendering a raw sen integer on
screen. The raw-sen problem is confined to exports (see the export entry).

**Fix.** Every site above now calls the shared formatter. `formatCurrency` lost its
`compact` option, and its callers now pass the plain amount. On Member Org
Performance, the month-bar labels are narrow, so each keeps the full amount in a
`title` and truncates if it does not fit. Nothing else truncates.

Pinned by `frontend/src/lib/money-display-guard.test.ts`, which scans every
non-test `.ts`/`.tsx` under `frontend/src` for six money shapes: 0-decimal, K/M
abbreviation, `/100).toFixed(2)`, `ringgit.toFixed(2)` behind RM, `toLocaleString`
with no decimals behind RM, and a raw `*_sen` JSX child. It also asserts
`formatCurrency(15000) === 'RM 15,000.00'`. On the unfixed tree it was RED: 6 of 8
failed, listing 5 whole-ringgit sites, 2 `formatCurrency` K/M lines, 6
`/100).toFixed(2)` sites, 4 `toFixed(2)` sites, 1 `toLocaleString` site, and
`expected 'RM 15.0K' to be 'RM 15,000.00'`. It is GREEN after the fix. Three
existing tests that pinned the old text (`RM1200.50`, `RM 125,000`) now expect
`RM 1,200.50` and `RM 125,000.00`.

**Ref.** fix/export-money-ringgit, 2026-09-15.
