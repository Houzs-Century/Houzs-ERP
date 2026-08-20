## The zero-cost ack migration took 0277, which main had already spent [med]

**Symptom** — `backend/tests/migrationNumbers.test.ts` fails on this branch:
`src/db/migrations-pg: 0277 is taken twice — rename your file to 0280_*.sql`.
CI red, and `main` requires that check to merge.

**Root cause (traced, not guessed)** — the branch numbered its migration `0277`
against the tree it BRANCHED from. While it was open, #1855 merged
`0277_scm_autocount_outbox.sql`, and 0278/0279 landed behind it. This is the
exact failure mode CLAUDE.md already names — *take migration numbers at MERGE
time by re-listing the tree, not when you branch* — and the same shape as the
0171 and 0230 collisions that each blocked a deploy for hours. It stayed
invisible here until the rebase, because the duplicate only exists in a tree
that contains BOTH branches.

**Fix** — renamed to `0280_scm_grn_zero_cost_ack.sql` [renumbered], the number the failing
test itself names. **Rename only, body untouched**, per the runner's own rule:
`pg-migrate` tracks by full filename, so an edited body would read to it as an
orphaned tracker row plus an unknown file to apply. The migration has never been
applied anywhere — it ships only on this unmerged branch — so there is no
tracker row to reconcile. The `Migration 0277` code comments that pointed at it
were repointed to 0280; the ones naming `scm.autocount_outbox` are genuinely
0277 and were left alone.

**Verified** — with the collision present, `migrationNumbers.test.ts` is
`1 failed | 7 passed`; renamed, that file is `8 passed`, and it plus
`zero-cost-receipt-guard.test.ts` are `33 passed` together.

**Ref** — PR #1907 `fix/zero-cost-po-exposure`, 2026-08-11.
