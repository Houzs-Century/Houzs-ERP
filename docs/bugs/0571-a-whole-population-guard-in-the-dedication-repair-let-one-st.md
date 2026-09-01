## A whole-population guard in the dedication repair let one standing mismatch veto every clean batch [medium]

**Symptom.** 2026-08-30 resync: `repair-dedication-from-autocount` APPLY (run
33271420009) failed with "REFUSED: 1 dedications would point at a different
item code. Rolled back." — while its own dry-run showed a clean batch (3
sibling re-points + 1 create, every pair same-code).

**Root cause (traced).** The post-write guard counted mismatches across the
ENTIRE company-1 dedication population, not the batch. A read-only census
(branch-ref dispatch, run 33271484122) proved the one violation pre-dates the
batch: `PO-001696 "2379-2S" -> HC-SO-003295 "2379-1S"` — a sofa set whose PO
side is piece-split while the SO side is still the `-1S` placeholder awaiting
human completion (the 95-line fill list). Any future batch, however clean,
was permanently vetoed by that standing row.

**Fix.** The guard snapshots the standing violation ids before writing and
fails only on NEW violations the batch itself creates; the standing set is
printed, never silently accepted. Dry-run mode additionally reports the
current standing violations so an operator sees them before any apply.
Observed so far: the dry census (run 33271484122) printed exactly the one
standing row. The scoped APPLY runs after this merges — its result belongs to
the round ledger, not to this entry written before the run.

**Ref.** diag/dedication-code-check, 2026-08-30.
