## Two photo repairs could be planned but never applied anywhere [high]

**Symptom.** 53 order lines still show a broken photo tile beside a working one,
and 34 AutoCount lines on 30 documents still show no photograph at all — three
weeks after both repairs were written, reviewed and merged. Running them proves
they work and changes nothing: on 2026-09-04 the prune's plan against production
printed `PLAN ONLY — 55 address(es) would be removed from 53 row(s). Nothing was
written.` and the re-point's printed `PLAN ONLY — 34 line(s) would gain 39
address(es).` There was no place in the world where the apply half could be run.

**Root cause (traced).** Both scripts need TWO credentials inside ONE process,
and no machine holds both:

- `R2_API_TOKEN`, because deadness ("this address names no object") and
  existence ("this photograph really is in the bucket") are facts about the
  bucket and about nothing else — `prune-dead-line-photo-keys.mjs` and
  `repoint-line-photos-to-owning-line.mjs` both `process.exit(2)` without it;
- a WRITING `DATABASE_URL`.

The operator machine has the R2 token, and its DSN connects as `claude_ro` —
`has_table_privilege(..., 'UPDATE')` is false, so it cannot write. GitHub
Actions has a writing `DATABASE_URL` and can never have the R2 token: this
repository is PUBLIC, non-admin collaborators can read repository secrets, and
that token reads every photograph the company owns. CLAUDE.md already forbids
the same move for `SUPABASE_SERVICE_ROLE_KEY`, for the same reason.

So the defect is not in either script's logic — both are correct and both pass
the four release-discipline rules. It is that neither has a runnable
DEPLOYMENT, and nothing in the repo said so.

**Fix.** The decision is computed where the bucket can be asked and applied
where the database can be written, and a PLAN FILE crosses between them:
`PLAN_OUT=<path>` on the existing plan mode writes the operations (row id,
document, AutoCount line key, the addresses to remove or add) under a header
carrying `generatedAt`, account, bucket, company, count and a sha256 digest;
`PLAN_IN=<path>` on apply reads that file INSTEAD of asking R2, so the apply
needs only `DATABASE_URL`. `.github/workflows/apply-line-photo-repair.yml` runs
it, holds `secrets.DATABASE_URL` and nothing else, and has no R2 input of any
kind.

**A plan file IS a key log, and this repo has already been hurt by replaying
one** —
`docs/bugs/0625-a-backfill-replayed-the-round-1-photo-key-log-without-asking.md`:
`backfill-photo-urls-from-keys.mjs` replayed the round-1 (2026-08-10) attach log
on 2026-08-28 and attached 64 addresses whose object was never uploaded. The log
was not wrong when it was written; it was wrong eighteen days later. A
minutes-old plan is a different object from a month-old log only if something
ENFORCES the difference, so the apply refuses, counting and printing every
refusal and never skipping one in silence:

| refusal | what it stops |
|---|---|
| `stale` | a plan older than 120 minutes. The ceiling may be LOWERED (`PLAN_MAX_AGE_MINUTES`) and never raised — asking for more is itself refused |
| `future` | a plan dated more than 5 minutes ahead: a forward clock is not freshness |
| `digest-mismatch` | a plan edited after it was written. The digest covers the HEADER too, so re-dating a stale plan to beat the age rule breaks the digest |
| `wrong-kind` / `wrong-account` / `wrong-bucket` / `wrong-company` | a plan applied to something it was not computed against |
| `unknown-arm` | an operation naming a table this script does not have. An op names its ARM; the table is only ever read from the script's own constant, so a plan can never nominate what gets written to |
| `drifted-missing` | PER ROW — the row no longer carries what the plan expected to find. For the prune that is both the dead address AND the live sibling that LICENSED the drop, so a row that lost its working copy is never blanked |
| `drifted-present` | PER ROW — the row already carries what the plan was going to add |
| `not-an-array` | the row is gone, or `photo_urls` is not a `text[]` (the jsonb double-encoding shape) |

Everything the two scripts already had is unchanged: plan is still the default,
apply still needs its CONFIRM phrase, the fresh-connection SHAPE verification
still runs (re-expressed for the no-R2 path as "the dropped addresses are gone
and every licensing address survives" / "the added address is present and
carries this row's own AutoCount line"), the `RE-RUN:` lines are updated, and the
prune still LEAVES ALONE the 7 addresses that are a row's only one — that is the
owner's decision, not a repair, and they are deliberately not written into the
plan file either.

**Pinned by `backend/tests/photoRepairPlanHandoff.test.ts`, 18 tests, PROVED RED
FIRST** against a stub whose guards all returned "fine": 17 of 18 failed on
assertions before the real
`backend/scripts/lib/photo-repair-plan.mjs` existed. The three the design turns
on are "a stale plan is refused — older than the ceiling, however valid it is",
"a tampered digest is refused — one address changed after signing", and "a row
whose column drifted is refused while its siblings still apply".

**Proved against production too, read-only, 2026-09-04.** Both plan files were
generated from prod (55 and 34 operations) and five refusals were then observed
end to end with the read-only DSN: `[stale]` on a correctly-signed 3-hour-old
plan, `[digest-mismatch]` on one address changed after signing, `[wrong-company]`
under `COMPANY=2`, the ceiling refusing `PLAN_MAX_AGE_MINUTES=1440`, and the
per-row guard reporting `APPLIED 0 row(s), REFUSED 53 row(s)` for the prune and
`APPLIED 0 line(s), REFUSED 34 line(s)` for the re-point, each exiting 1.
**Nothing was applied to production.** The MIXED case — some rows applied while
others are refused — is proved by the unit test only; there is no writable
database on the operator machine, so it is **UNTESTED** end to end.

**Ref.** `fix/photo-repair-plan-handoff`, 2026-09-04.
