## The SO-holders probe died coercing an empty string into a status enum [low]

**Symptom.** The first ever dispatch of the **SO holders check (read-only)**
workflow (run 34334122124) printed the two companies and the picker buckets,
then stopped on company 1 before listing a single holder:

```
check-so-holders failed: invalid input value for enum scm.mfg_so_status: ""
```

**Root cause (traced).** Both queries excluded cancelled orders with
`COALESCE(so.status, '') <> 'CANCELLED'`. That idiom is correct for a TEXT
column and wrong here: `scm.mfg_sales_orders.status` is the ENUM
`scm.mfg_so_status`, so `COALESCE(status, '')` asks Postgres to cast `''` into
the enum, which has no such member. It fails at execution, not at parse, so
`node --check` and every local audit passed — the query had to actually reach
the database to be wrong, and nothing in CI touches production.

**Fix.** `so.status IS DISTINCT FROM 'CANCELLED'` in both places. Same
NULL-inclusive meaning as the COALESCE form (a NULL status is still counted) and
no cast. The reason is written at the top of `check-so-holders.mjs` beside the
RE-RUN note, because the COALESCE idiom is used correctly elsewhere in this repo
on text columns and the next author will reach for it again.

**No test pins this.** The failing statement needs a real Postgres with this
schema; the light suite has neither, and a fake would only assert the string I
typed. What actually pins it is the rule the workflow already had to obey — a
`workflow_dispatch` workflow is not shipped until it has been dispatched once
and reported success — which is precisely what caught it, on the first run, in a
read-only job that changed nothing.

**Lesson.** The probe was reviewed, syntax-checked, release-discipline-checked
and merged while carrying a query that could never execute. Every gate this repo
has reads code; **only running it against the real database could have found
this**, and the dispatch-once rule is that gate. It cost one red diagnostic run
and no data.

**Ref.** `fix/so-holders-enum`, 2026-09-09. Failing run 34334122124.
