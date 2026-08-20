## The integration merge landed on red, and the migration it renumbered still called itself 0284 [medium]

**Symptom** — `main` was red immediately after PR #2121 (*Integrate the
2026-08-13 batch*, merged 13:06). Three failures, all from the same batch: two
migration files numbered `0284`, and two assertions still expecting the old
`findServiceLineCodes` return shape.

**Root cause (traced, not guessed)** — neither failure is a defect in isolation;
both are the shape of assembling thirteen branches against a moving `main` and
then not re-verifying. (1) `0284_scm_processing_date_one_name.sql` [renumbered] was written
on a branch while `main` took `0284` for
`0284_retire_consignment_proceeded_at.sql`; `backend/tests/migrationNumbers.test.ts`
is a ratchet — historical duplicates are frozen as accepted, a NEW one fails —
so it caught the collision and printed its own remedy. (2) the optional-param-noop
sweep changed `findServiceLineCodes` (`scm/lib/service-line-guard.ts`) to return
`{ ok, codes }`, where `ok: false` is **not** all-clear but "the catalog lookup
itself failed and the caller must refuse"; a sibling branch's new test, merged in
the same integration, still asserted the bare array. The PR states the process
cause plainly: *"I armed auto-merge and stopped watching. It merged on a state I
had verified BEFORE the last merge of main, not after."*

**Fix** — the file is renamed to `0286_scm_processing_date_one_name.sql` and its
`RAISE NOTICE` / `RAISE EXCEPTION` strings renumbered with it (9 lines);
`backend/src/scm/lib/optional-param-noop.test.ts` expects
`{ ok: true, codes: [...] }` on both cases. Two files, 11 lines. Verified on
origin/main: `0284` is the consignment retirement, `0285` is the AutoCount UDF
rename, `0286` is the Processing-Date rename.

**Read the rename rule before you repeat this, because the repo states it two
ways.** The PR quotes the test's own instruction — *"Rename ONLY (do not edit the
body): pg-migrate spots a rename by checksum"* — and then edits the body anyway,
arguing the migration had never run outside ephemeral CI databases so there is no
tracker row to orphan. `backend/scripts/pg-migrate.mjs` supports the premise: it
records filename **and** checksum, and detects a pure rename by identical
checksum (`RENAMED <from> -> <to>: identical checksum`); an edited body defeats
that detection and lands as `DRIFT … suspectedRenumberOf`, whose printed remedy
is a manual `UPDATE _pg_migrations SET filename = …, checksum = NULL`. So the
argument holds exactly as long as the file is genuinely unapplied, and nothing in
the PR proves that against a live catalog. Meanwhile
`scripts/lib/working-agreement.mjs:540`, added later, tells the next reader the
opposite: *"pg-migrate tracks by FULL FILENAME — renaming an applied file runs
its SQL a second time."* Two places in this repo now describe the same mechanism
differently; `pg-migrate.mjs` is the one that runs.

**The class, for next time** — verifying and then merging something else are two
different acts, and CI on a squashed integration branch is not CI on the tree
that lands. Running `node scripts/check-working-agreement.mjs --pr 2124` today
reports **two** violations on this PR: the missing ledger entry, and a missing
`Reversal:` / `Verified against:` pair for the migration it renumbered — rule 3
of the working agreement, which costs two lines in the body.

**Ref** — 2026-08-13, PR #2124 (`fix/main-red-after-integration`). Entry written
2026-08-14 from the merged diff, not from the PR description. Module guide:
`docs/modules/sales-order.md` owed two corrections this PR did not make — its
"since mig 0284 one NAME" line, which the renumber falsified, and a duplicated
self-contradicting paragraph beside it still naming the retired
`internal_expected_dd`, left there by #2121. **Both were fixed on 2026-08-14 by
the documentation audit, PR #2129**, before this ledger entry was written; the
guide now reads `0286` at `:484` and `docs/modules/purchase-order-amendment.md`
records the same renumber drift. Nothing further is owed there.

---
