## The Sales Order detail showed a paid-up balance of 0 on every migrated order [high]

**Symptom.** The owner opened a Sales Order on his phone the day after the
cutover. The card read **Total RM 3,200.00, Paid RM 1,600.00, Balance
RM 0.00** — three numbers on one card, two of them right. He confirmed it was a
Sales Order and not an invoice. The SO LIST beside it showed the same order's
balance as RM 1,600.00, because the list reads the view's `balance_sen_live`
(`local_total_sen - SUM(payments)`) and the detail did not. A document that says
a customer owes nothing is the one number staff act on, and after the 2026-09-08
cutover it was wrong on essentially every order they open: `total_revenue_sen`
is 0 on **2,687 of production's 2,824 live orders** (`probe-so-overpay.mjs`,
run 31938735652 section b).

**Root cause (traced).** Four layers, each individually defensible, and the
column that decides it is never filled on a migrated order.

1. The cutover importer does not write `total_revenue_sen`. Its header column
   list — `HCOLS` in `backend/scripts/import-ac-outstanding-so.mjs` — carries
   `local_total_sen, balance_sen, paid_sen, deposit_sen` and not
   `total_revenue_sen`. The column is `integer DEFAULT 0 NOT NULL`, so every
   imported order carries 0 there, and `recomputeTotals` (which would fill it)
   never runs on an order nobody edits — migrated orders are read-only.
2. `soBalanceSen` in `backend/src/scm/shared/so-outstanding.ts` opened with
   `if (!(a.totalRevenueSen > 0)) return 0;`. That guard was deliberate and was
   protecting a real hazard (a bare `total - paid` on an unrecomputed header
   would have painted the legacy book red), but it read only the ONE column the
   import does not write, so it answered 0 for all 2,687.
3. `GET /mfg-sales-orders/:docNo` (`routes/mfg-sales-orders.ts`) stamps that
   result over the response's `balance_sen`. The header row's own `balance_sen`
   held AutoCount's `UDF_BALANCE` — the correct RM 1,600.00, written by the
   import — and the handler replaced it with 0 on the way out.
4. `deriveBalance` in `frontend/src/vendor/scm/lib/so-detail-gates.ts` returned
   `header.balance_sen` whenever it was non-null. `balance_sen` is non-null on
   every response, and 0 is non-null, so its own correct fallback
   (`local_total_sen - paid_sen_total`) was unreachable. That 0 rendered on the
   mobile detail's Balance KPI (`frontend/src/mobile/MobileSODetail.tsx`) and,
   read straight off the column, in the desktop print-preview card
   (`frontend/src/pages/scm-v2/SalesOrderDetailV2.tsx`).

Observed, not inferred: the list and the detail of the SAME order disagree by
exactly the payment, from two code paths in one repository — that contradiction
reproduces with no database access, and the four steps above are the whole of
it. This was also a KNOWN deferred half: `docs/bugs/0496-*` fixed the identical
mistake in the Fair Report and its closing paragraph explicitly declined to
extend the repair to `soBalanceSen`. That judgement was made on 2026-08-21, six
weeks before the cutover put 2,687 imported orders in front of staff.

**Fix.** `soBalanceSen` subtracts from a new `soDisplayTotalSen` —
`total_revenue_sen` when the recompute has run, `local_total_sen` otherwise —
instead of from `total_revenue_sen` alone. The guard that mattered STAYS, one
level up: an order with no total in EITHER column is UNKNOWN and still answers
0. The fallback is not a guess: the importer wrote the ledger row as
`paid = total - UDF_BALANCE` against the same `local_total_sen` it stored, so
`local_total_sen - paid` reproduces AutoCount's own outstanding figure by
construction, and is negative only where AutoCount itself recorded an
over-collection. `localTotalSen` is a REQUIRED field on the new
`SoBalanceInputs`, so the compiler enumerated the call sites rather than letting
a caller keep the old answer silently.

The arithmetic is not written a third time: `signedBalanceSen` now lives beside
the rule in `so-outstanding.ts` and `fairBalanceSen` (`scm/lib/fair-report.ts`)
delegates to it. The two names remain because the two callers choose a different
TOTAL, not a different subtraction.

`deriveBalance` no longer prefers a server `balance_sen` of 0 over a computable
total minus paid; a NON-zero server balance still wins, because only the server
can apply the legacy header-deposit rule. The desktop print-preview card now
goes through that same shared gate instead of reading the column.

**The AutoCount write-back is deliberately unchanged, and is a follow-up.**
`readSoOutstandingSen` (`scm/lib/autocount-read.ts`) returns null only when
`total_revenue_sen IS NULL`; on an imported row the column is `0 NOT NULL`, so
it would compute `max(0, 0 - paid) = 0` and could tell AutoCount that a
part-paid order is settled. That path is unreachable today only because migrated
orders are read-only — luck, not a guard — and this PR does not widen to it:
`soOutstandingSen` keeps taking `SoPaidInputs` with no fallback, so nothing here
moved the licensed ledger's rule in either direction. The follow-up is to make
that reader refuse a document whose `total_revenue_sen` is 0 rather than assert
a balance from it, which is the same "0 is not a fact" decision its own docblock
already makes for NULL.

Pinned by **eleven assertions across three suites**, all **proved RED on the
unfixed tree** (`git stash push` of the four source files, then vitest):
`backend/src/scm/shared/so-outstanding.test.ts` and
`backend/tests/soOverCollection.test.ts` failed 7 —
`expected +0 to be 160000`, `expected +0 to be -80000`,
`expected undefined to be 320000` — and
`frontend/src/vendor/scm/lib/so-balance-signed.test.ts` failed 4, including the
owner's exact case (total 320000 sen, paid 160000, `total_revenue_sen` 0,
`expected +0 to be 160000`). All 65 backend and 14 frontend cases pass on the
fixed tree. The negative case is pinned on both sides: over-collection stays
signed and red per `1a87183f4`, it is not clamped.

**Ref.** `fix/so-detail-balance-zero`, 2026-09-08.
