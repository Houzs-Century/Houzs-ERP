## Two migrations both numbered 0276 [medium]

**Symptom** — `main` carried `0276_scm_migrated_documents.sql` and the open
#1855 carried `0276_scm_autocount_outbox.sql` [renumbered]. Merged as they stood, `pg-migrate`
would have two files claiming one number.

**Root cause** — Exactly the case `CLAUDE.md` warns about: #1855 picked its
number when it branched, not at merge time, and `0276` was taken while it sat
open. `pg-migrate` tracks by full filename, so gaps and out-of-order merges are
safe and duplicates are not.

**Fix** — Renamed the unapplied one to `0277_scm_autocount_outbox.sql` and
updated the four references to it in `docs/modules/autocount-writeback.md`. Safe
because it has never run anywhere: #1855 is not merged, so no deployment has an
`APPLIED 0276_scm_autocount_outbox.sql` [renumbered] line to be confused by the rename.

**Ref** — 2026-08-10, PR test/ac-writeback-trial.
