## The migrated sales-order lock had no setter either, so its runbook asked a person for SQL [medium]

**Symptom.** `scm.app_config['scm.migrated_so_lock']` decides whether ~2,900
carried-over sales orders can be edited at all — and the only documented way to
change it is a raw `UPDATE` pasted into a database console.
`docs/migrated-so-lock.md` carries three of them: §6 *"Putting it back"*, §6's
*"If something is wrong and you are not sure what: set `value = '1'`"*, and §10's
step 3, which is the one the go-live actually needs
(`SET value = 'verdict:1'`).

That is a direct breach of the MANDATORY owner rule this repo has carried since
2026-08: **never ask the owner to run a query — build the check instead.** It is
the same finding as
`docs/bugs/0710-the-write-freeze-runbook-told-everyone-to-run-a-workflow-tha.md`,
one row along in the same table, found while reading 0710 to copy its discipline.

**Root cause (traced.)** Nothing writes the key. Measured on `origin/main`
before this change, not reasoned:

```
$ grep -rl "scm.migrated_so_lock" .github/workflows/
.github/workflows/ac-erp-reconcile.yml
$ grep -rln "migrated_so_lock" backend/scripts/
backend/scripts/check-migrated-so-amendments.mjs
backend/scripts/check-so-open-for-new.mjs
backend/scripts/publish-so-reconcile-verdict.mjs
```

**Every one of those four is a READER, and two of them say so in their own
output.** `ac-erp-reconcile.yml:40` — *"It does not touch the
scm.migrated_so_lock switch"*; `check-migrated-so-amendments.mjs:134` —
*"read-only: this script never writes"*; `publish-so-reconcile-verdict.mjs:187`
— *"this run did NOT touch that switch"*; `check-so-open-for-new.mjs:83` selects
the row. A `grep` for an `UPDATE` / `INSERT` / `upsert` of the key across
`backend/src`, `backend/scripts` and `.github/workflows` returns nothing at all.
The only write that has ever existed is migration
`20260908T0014_scm_migrated_so_lock.sql`, which seeds the row `ON CONFLICT DO
NOTHING` and by design never changes it again.

That is the same shape 0710 found for the write freeze, where the two matches
were also both readers. The difference is that this runbook never claimed a
workflow existed, so there was not even a broken instruction to notice: the SQL
was presented as the way, and it was.

**Why it survived the fix to 0710.** #3235 built the freeze's setter from the
freeze's runbook. Nothing connects the two rows except that they sit in one
table with similar grammars — which `docs/migrated-so-lock.md` §7 lists as a
TRAP for operators, and which turns out to be a trap for authors too: fixing the
row you were sent to fix does not fix its neighbour, and no check knows the
neighbour exists.

**Fix.** `backend/scripts/set-migrated-so-lock.mjs` +
`.github/workflows/set-migrated-so-lock.yml`, with the runbook corrected to
point at the workflow instead of the SQL. It copies 0710's four disciplines and
adds the two things 0711 cost:

1. **It imports the REAL parser** — `parseMigratedSoLock` and
   `migratedSoIsLocked` out of `backend/src/scm/lib/migrated-so-lock.ts`, the
   module the middleware itself reads — so the grammar has one home. Run with
   `npx tsx`, not `node`, for that reason.
2. **The parser contract is asserted at STARTUP, before any DSN is read**, over
   the nine values the runbook documents, and it prints `PARSER CONTRACT OK` on
   the pass. 0711's finding was that every local gate exits before opening a
   database, so the shared library was never exercised until production. Proved
   both ways locally: with the expectation for `verdict:all` deliberately
   corrupted the script exits 1 naming the disagreement; restored, it prints
   `PARSER CONTRACT OK — 9 values through src/scm/lib/migrated-so-lock.ts`.
3. **The value is parsed and refused BEFORE the database is opened.** A
   malformed value — anything carrying a `-`, which can only have been pasted
   from the write-freeze row — exits 1 on a laptop rather than in a workflow.
4. **The gated direction is OPENING, not closing** — the opposite of the freeze
   setter, said out loud in both files. The owner ruled these documents shut and
   the risks behind that ruling (a delta sync overwriting a staff edit; AutoCount
   payments that never reached the ERP) are risks to DATA, which a re-close
   cannot undo. What it CLOSES is printed just as loudly and is not gated:
   losing an edit you had is visible within a minute and costs nobody their work.
5. **Before / after is stated PER COMPANY, in documents**, with the company list
   read from `public.companies` rather than assumed to be 1 and 2, and the
   verification re-reads on a FRESH connection and asserts the resolved STATE
   per company — not that one row came back.

**What this fix does NOT claim.** It does not change any value by itself.
`MODE` defaults to `plan`, `VALUE` has no default at all — every default this
row could carry is somebody's production state — and nothing was flipped by
shipping it. The owner times the flip.

**Ref.** feat/set-migrated-so-lock, 2026-09-08. Runbook:
`docs/migrated-so-lock.md` §6 and §10.
