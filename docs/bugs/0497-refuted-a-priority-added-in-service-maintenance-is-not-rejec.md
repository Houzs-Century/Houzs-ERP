## REFUTED: a priority added in Service Maintenance is not rejected on case create [low]

**Symptom (as reported).** "`scm.assr_cases.priority` carries a CHECK constraint
that only admits the original values, so a priority the owner adds through the
maintenance screen fails on case create." A migration was asked for.

**Root cause (traced) — the premise is FALSE on production.** `public.assr_cases`
carries **no CHECK constraint of any kind**. Asked directly, via
`pg_get_constraintdef` over `pg_constraint` in a `workflow_dispatch` read-only
probe against `secrets.DATABASE_URL`
([run 32471721636](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/32471721636),
re-run with more coverage as
[32472147332](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/32472147332)):

```
── 1. CHECK constraints on public.assr_cases ──
   (none)
```

A priority added in Service Maintenance is therefore **accepted** on case create.
No migration is warranted, and nobody should write one for this.

**Where the belief came from, because it is a real trap and it will recur.** The
CHECK is genuine — in the **D1 tree**:
`backend/src/db/migrations/010_assr_redesign.sql:16` and
`074_assr_v31_stages.sql:93` both declare
`CHECK (priority IN ('low','normal','high','urgent'))`, and
`backend/src/db/d1-schema-dump.sql:86` carries it. The Postgres side never had
it: `migrations-pg/0000_baseline.sql` does not contain `assr_cases` at all, and
the word `priority` appears in it zero times — the public schema was copied over,
and a copy does not bring CHECK constraints.

**The trap is that the TEST database enforces it and production does not.**
`vitest.config.mts:33` seeds from `src/db/schema.sql` and replays the D1
migrations, so a test that creates a case with a custom priority FAILS while the
same call succeeds in production. A green test proves nothing about this column,
and a red one proves nothing either.

**Two adjacent findings, both real, neither the reported one.** Recorded here so
they are not lost, and neither is fixed in this PR — each is a judgement call for
the owner rather than a provable defect:

1. **`assr_priorities` has no UNIQUE index on `slug`** — `pg_indexes` shows only
   `assr_priorities_pkey` on `id` and `idx_assr_priorities_active`. `POST
   /api/assr/lookups/priorities` inserts with `ON CONFLICT DO NOTHING`, which has
   nothing to conflict on, and it derives the slug from the NAME — so adding a
   priority named "High" writes a SECOND row with slug `high`. There are no
   duplicates today. `slaHoursForPriority`'s `WHERE slug = ? LIMIT 1` would pick
   one arbitrarily if there were.
2. **A custom priority with a blank SLA silently gets the Normal window.**
   `slaHoursForPriority` falls back to `slaHoursFor(slug)`, whose map holds only
   the four original slugs, so an unknown slug lands on the `?? 168` default —
   168 hours, the Normal figure. Nothing refuses; the case just gets a 7-day
   deadline. `assr_priorities.sla_hours` is `bigint NULL` with no constraint of
   its own, so the answer to "does `sla_hours` have the same problem for a newly
   added row" is **no**.

**Fix.** No code or schema change. What ships is the probe that settled it —
`backend/scripts/check-assr-priority-constraint.mjs`, riding the already
dispatchable `assr-sla-priorities-check` workflow — so the next person asks the
database instead of reading the D1 dump.

**Ref.** `fix/assr-priority-check-constraint`, 2026-08-21.
