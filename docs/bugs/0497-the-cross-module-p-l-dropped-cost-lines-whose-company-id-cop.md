## The cross-module P&L dropped cost lines whose company_id copy was never filled [high]

**Symptom.** The cross-module P&L (`GET /api/finance/pnl`, and the row list
behind `GET /api/finance/pnl/bucket`) reported LESS project cost — and therefore
MORE gross profit — than the Project Profitability and Finance-by-project
reports did over the same ledger. Measured against production 2026-08-21:
**85 live cost lines worth RM 1,453,336.94** were counted by one report and not
by the other. Worst single project: 2231
(`2025-03-MLE-KUALA-LUMPUR-MID-VALLEY-AKEMI`), 8 lines, **RM 384,226.00**
missing from the P&L. 36 income lines worth RM 3,986,694.00 sit in the same
state and will do the same the moment anything scopes income the same way.

**Root cause (traced).** `projectCostFrom` in `backend/src/routes/finance.ts`
scoped on `l.company_id` — a DENORMALISED copy of the value the project owns,
added by mig 0170. Two writers never fill it:
`services/projectCostRates.ts` stamps `company_id` on its INSERT branch only
(`upsertAutoLines`), so an auto row created before 0170 keeps NULL through every
later UPDATE; and the historical FAIR PNL ledger seeds were written without it.
`AND l.company_id = ?` therefore drops those rows — silently, because a row that
is not there cannot announce itself. `/projects/analytics/profitability` and
`/projects/finance/by-project` scope on `p.company_id` (the project's own
column), which is why the same money appears in one report and not the other.

Observed, not inferred: `backend/scripts/check-report-money.mjs` section 3b,
dispatched read-only against production
(run <https://github.com/Houzs-Century/Houzs-ERP/actions/runs/32465233085>).
It grouped live cost lines on unarchived projects by whether `l.company_id` is
NULL: 79 manual lines (RM 1,327,267.94) + 6 auto lines (RM 126,069.00) carry
NULL. The same run asked the question that decides whether reading the project
instead is a WIDENING — how many lines disagree with their project's company —
and the answer is **0 rows, RM 0.00**.

**Fix.** `projectCostFrom` scopes on `p.company_id`. The `projects` join was
already there for `archived_at`, so this is one identifier, and because no line
disagrees with its project the row set changes by exactly the NULLs it was
losing — nothing new is admitted. `bucketDrilldown` interpolates the same
fragment, so the total and its drill-down move together. The column stays: it is
provenance, and this change only stops it being a second home for the answer.

Pinned by "project cost scopes on the PROJECT's company, not the line's copy of
it" in `backend/tests/reviewHighFindings.test.ts`, which asserts both the total
and the drill-down name `p.company_id` and neither mentions `l.company_id`.
**Proved RED on the unfixed tree**:
`AssertionError: expected 'FROM project_finance_lines l JOIN pro…' to contain 'p.company_id = ?'`,
received `… AND l.company_id = ?`. Green after.

**Ref.** `audit/report-money-math`, 2026-08-21.
