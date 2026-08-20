## Migration 0301 rejected its own rewrite and blocked every production deploy [critical]

**Symptom.** From 2026-08-16 11:16:41Z (#2297 merged) production stopped
shipping. Every `Deploy` run concluded `failure` with `wrangler publish`
skipped, on:

```
FAILED  0301_so_balance_live_signed.sql: 0301: rewrite reported success
        but balance_centi_live is still floored.
```

`pg-migrate` stops at the first failure, so #2282, #2302, #2305 and everything
else merged that afternoon sat on `main` and none of it was live. Last good
deploy: 11:12:53Z (`a1d1badd0`).

**Root cause, traced.** 0301 rewrites the view by string substitution on
`pg_get_viewdef(..., true)`, then demanded its replacement literal back from the
catalogue. `CREATE OR REPLACE VIEW` does not store the text it is handed —
Postgres parses it to a tree and `pg_get_viewdef` deparses that tree afresh. In
pretty mode it emits only the parentheses precedence requires, so the outer pair
in `(a - b) AS x` is dropped and the literal could never match. Measured on this
exact view, both spellings read from the live catalogue at the same instant
(`why-0301-refuses.mjs`, dispatched read-only against prod, #2319):

```
pretty=false  GREATEST((so.local_total_centi - COALESCE(p.paid_total, (0)::bigint)), (0)::bigint) AS balance_centi_live
pretty=true   GREATEST(so.local_total_centi - COALESCE(p.paid_total, 0::bigint), 0::bigint) AS balance_centi_live
```

The `DO` block raises, the block rolls back, the view stays floored, and the
next deploy repeats it. The same literal also backed the "already signed"
early-return, so a re-run would have fallen through to the migration's own
"refusing to guess" abort — a second instance of one mistake.

**Fix.** The post-condition asserts what the migration is FOR — the `GREATEST`
floor is no longer in the deployed definition — plus that `balance_centi_live`
survived, so a dropped column cannot pass as success. The idempotency check
accepts either spelling. Not a weaker guard: the original could not pass at all.

**What this rules out.** The rewrite was never broken. `CREATE OR REPLACE VIEW`
parsed and applied; only the read-back assertion was unsatisfiable. A "relax the
post-condition" patch written without the measurement above would have been
indistinguishable from forging the evidence the post-condition exists to check,
which is why the probe shipped first as its own PR.

**Lesson.** An assertion that compares deparsed SQL to a hand-written literal is
asserting a formatting convention, not a fact. Assert the property you changed.

**Ref.** probe #2319, fix this PR, 2026-08-16.
