## Twelve audit scripts kept querying the column 0286 renamed away, and the guard that forbids it could not see them [high]

**Symptom** — every read-only cutover, go-live, reconciliation and completeness
audit under `backend/scripts` stopped working on 2026-08-13, and none of them
said so in those words. Twelve `.mjs` files named `internal_expected_dd` in live
SQL after mig `0286` renamed it to `processing_date` (applied on prod
2026-08-13T13:46:59Z). Postgres answers a missing column with **42703 and fails
the WHOLE statement**, so a run produced a stack trace and `exit 1` — not a
smaller number, no number at all. Two files were quieter than that:

- `probe-rename-preconditions.mjs` guarded its consignment row count on the
  presence of the NEW name and then SELECTed the OLD one. Post-rename the guard
  passes, the count 42703s, the READ ONLY transaction aborts, and the probe
  exits **2 — "the probe itself could not read"**, a false report about a
  database it can read perfectly well. Its `mfg_sales_orders` count guarded on
  the OLD name only, so after the rename it printed nothing at all — silence
  that reads as "no rows" rather than "I asked the wrong name".
- `backfill-so-dates.mjs`, which WRITES, refuses any document whose audit trail
  shows a person set, moved or REMOVED one of its dates. That refusal list held
  `internal_expected_dd` / `internalExpectedDd` and **not** `processing_date` /
  `processingDate`, so a Super-Admin *Remove Processing Date* performed after
  2026-08-13 leaves an audit row the scan does not match — and the backfill
  would write the removed date straight back.

**Root cause, traced not guessed** — the name was a string literal in each
script, and nothing enumerated them. PR #2153 fixed this class in the backend by
binding every route to `SO_PROCESSING_DATE_COLUMN` in
`src/scm/shared/so-processing-date.ts`, and `tests/soDatePairWiring.test.ts`
forbids the retired name — over a **hand-listed set of five `src/` files**. It
has to be hand-listed: the backend vitest suite runs in workerd, which has no
filesystem, so a test there can only check files somebody remembered to add. A
`.mjs` script cannot import the TypeScript constant either. The one place the
name was still typed by hand was therefore the one place no guard could reach —
the same gap `scripts/lib/so-terminal-states.mjs` and
`scripts/lib/do-shipped-states.mjs` were created to close for their own sets.

**Fix** — `backend/scripts/lib/so-processing-date.mjs`, the .mjs mirror of the
naming constants, pinned to the TS original by
`tests/soProcessingDateMirror.test.ts` exactly as the two existing mirrors are.
All twelve scripts read the column from it. postgres.js binds a bare
`${string}` as a PARAMETER — `h.${COLUMN}` sends `h.$1` — so the module also
exports `soProcessingDateFragment(sql)`, a `sql.unsafe` fragment that is inlined
as SQL text. `sql(name)` is deliberately NOT used: that path picks its builder
by regex-matching the SQL emitted so far, so the same call renders an identifier
after `SELECT` and garbage after `IN (...)`, which every one of these queries
has. `backfill-so-dates.mjs`'s refusal list is now built from the constants,
current spellings **and** legacy; the probe counts only columns the catalog
proved are there and names which one it counted.

**Why the new test walks the directory.** `tests/soProcessingDateOneName.test.mjs`
is `node:test`, run by `npm run test:scale-contract`, and it reads
`backend/scripts` off disk — so a script written tomorrow is covered by code
that already exists. Comments are stripped before matching: the rename is a
story worth telling, and `unify-processing-date.mjs` quotes the owner naming the
column verbatim. Measured on the tree this branched from: **12 offending files
before, 0 after.**

**Ref** — 2026-08-14, this PR. Same class as the entry below (a column name in a
string is invisible to `tsc`); this is the half of the tree that entry's test
could not see.
