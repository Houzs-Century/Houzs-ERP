## A read-only probe shipped with its SQL never executed, and died on the one company that mattered less [med]

<!-- area: Repo tooling: tests, ratchets, generators -->

**Symptom.** First production dispatch of `probe-undated-demand` (run
31962771658, 2026-08-16) printed sections A–C for company 1, then:

```
FAIL subquery uses ungrouped column "h.created_at" from outer query
##[error]Process completed with exit code 1
```

**Root cause, traced.** Two independent faults, and the second is the expensive
one.

1. **The SQL was never executed before it shipped.** A correlated subquery sat
   beside a `GROUP BY` and referenced the raw `h.created_at` that the grouping
   had already collapsed into `date_trunc('month', ...)`. Postgres refuses that.
   `node --check` cannot see inside a SQL string, typecheck cannot, and the
   Worker-pool vitest suite has no Postgres — so "it parses" was the only
   evidence the probe had. Per CLAUDE.md a `workflow_dispatch` workflow cannot
   be dispatched until it is on the default branch, which made production the
   FIRST execution of every statement in it.

2. **One company's failure cost the other company's answer.** `main()` looped
   `for (const [id] of COMPANIES) await perCompany(id)` with no per-company
   guard, so the throw in company 1 aborted the process before company 2 (2990)
   ran at all. The output showed HOUZS numbers and nothing else — and a company
   that was never read looks exactly like a company with no data. The 81.9%
   figure was reported onward as covering "both companies"; it covers HOUZS.

**Fix.** The SQL moved to `backend/scripts/lib/undated-demand-queries.mjs` —
ONE home, no shebang because a test imports it — and
`backend/tests-pg/probeUndatedDemandSql.pg.test.ts` EXECUTES every exported
query against CI's real postgres:16 (`backend-postgres`), enumerating them from
the module so a query added later cannot slip past untested. The month query is
now a CTE. Each company runs in its own `try/catch`; failures are collected,
printed, and carried to a non-zero exit, and the summary says **NOT MEASURED**
rather than letting an unread company read as zero.

**Proof the test bites:** restoring the original query fails the suite with the
identical production error — `PostgresError: subquery uses ungrouped column
"h.created_at" from outer query`, 5 failed / 4 passed, exit 1 — and restoring
the CTE returns 9 passed, exit 0.

**Ref.** 2026-08-17. Lesson: **an unrunnable check is an unwritten check.** The
probe followed every rule in CLAUDE.md's read-only-probe section — one
statement, no writes, own concurrency group, manual trigger — and still burned a
production dispatch, because none of those rules say *execute the SQL somewhere
first*. Where a thing can only run in production, find the nearest real engine
and run it there: this repo already had one in CI and nobody had used it for a
script. Second lesson: **a loop over N subjects needs N error boundaries**, or
the first failure silently redefines the scope of the answer.
