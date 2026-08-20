## Both companies were reading the same balance sheet — the GL views joined the chart of accounts on the code alone [high]

**Symptom.** Every figure served by `routes/accounting.ts` `GET /gl`, `/balances`,
`/control-check` and `/daily-bank` was one company PLUS the other. The general
ledger listed each posted line twice; the trial balance summed HOUZS's and
2990's lines into a bucket its `GROUP BY` labelled as one company's own.

**Root cause (traced, not guessed).** `scm.v_gl_entries` and
`scm.v_account_balances` both join the chart of accounts on `account_code`:

    v_gl_entries        JOIN scm.accounts a ON a.account_code = l.account_code
    v_account_balances  LEFT JOIN scm.journal_entry_lines l ON l.account_code = a.account_code

That was correct while the code was globally unique. Migration 0188 dropped
`UNIQUE(account_code)` and replaced it with
`accounts_company_account_code_unique UNIQUE (company_id, account_code)`,
re-pointing the line FK at the composite — precisely because a code is only
unique *within* a company now. Neither view was updated. It stayed harmless only
while the two charts held different codes; migration 0297
(`ONE AutoCount-style chart for every company`, owner decision 2026-08-16)
inserted the 31-account template into company 1 to match company 2, so from that
migration on **every code exists in both charts** and the join is many-to-many.

The duplicate rows carry the *same* `j.company_id`, which is why the route-level
`.eq('company_id', ...)` on every one of those endpoints could not see the
problem, and why it reads as "the numbers are just wrong" rather than as a leak.

**Scale, measured rather than assumed.** Migration 0297 recorded the ledger at
7 journal entries / 14 lines on 2026-08-16, so little history is affected. The
defect is in the view definition, not in stored rows: **nothing needs
backfilling** and every figure corrects itself the moment the migration lands.
Traced from the schema and the migration history — not observed against
production data, which this session had no credential for.

**Fix.** `0306_gl_views_join_on_company.sql` adds the second half of the
composite key to both joins (`a.company_id = j.company_id`, and
`l.company_id = a.company_id` — `journal_entry_lines.company_id` has been
NOT NULL since 0083, so no detour through `journal_entries` is needed).

Two things were deliberately *not* done. `v_account_balances` also lets lines of
unposted or reversed entries contribute, because its `posted/reversed` test sits
in a `LEFT JOIN ... ON` while the `SUM` runs over `l`; migration 0290 examined
that, judged it a separate question that would move reported balances, and
recorded it for the owner in `docs/audit-2026-08-13-ledger.md`. Fixing a
provable leak must not smuggle in a pending owner decision. And the repair is a
`CREATE OR REPLACE`, never `DROP` + `CREATE`: a recreated view is a new object
with an empty ACL, which is how 0189 took the Sales Order list down for every
user and needed both 0190 and 0191 to put the grants back.

**The trap this class carries, and how the test is shaped around it.**
`CREATE OR REPLACE VIEW` may only *append* columns — existing names, types and
order must match the live view exactly. Migration 0290 was written against a
stale definition, renamed column 1, and failed in production with
`cannot change name of view column "line_id" to "journal_entry_id"`; pg-migrate
runs before wrangler, so the whole backend deploy stopped and every later
migration queued behind it. The first draft of *this* migration repeated that
mistake exactly — it was written from 0290's body while the live
`v_account_balances` still comes from 0106 — and was caught by diffing both
SELECT lists against the live definitions before commit, not by review.
So `backend/tests-pg/glViewsScopeToCompany.pg.test.ts` builds the **pre-state**
as its fixture, asserts the leak actually reproduces there (two rows where one
is due, 1,500,000 sen where 1,000,000 is due), applies the migration on top, and
compares `information_schema` column name/type/order before and after. A test
that built the views from the migration's own SQL would pass while production
failed.

**Ref.** `fix/gl-views-company-scoped`, 2026-08-18. Found during the
cross-company isolation audit.
