## The go-live wipe's own audit trigger refilled a table it had just emptied, so every first apply failed verification [medium]

<!-- area: AutoCount sync + write-back -->

**白话.** 上线清空跑第一次一定「失败」，其实资料已经删干净了。原因是我们自己的稽核
触发器：删掉销售单的行会自动写一笔「谁删了什么」的纪录，而那张纪录表也在要清空的名
单里、而且排在前面 —— 所以先被清空，然后又被自己写回去。检查的时候看到有 4 笔，就
报失败。要跑第二次才过。现在改成删到没有为止，一次就干净。

**Symptom.** `MODE=apply` reported success on the deletion and then failed its
own post-commit verification:

```
=== DELETED 35328 HC rows across 69 CLEAR tables (in transaction) ===
  in-transaction guard: all 69 2990 CLEAR-table counts unchanged — safe to commit.
VERIFICATION FAILED:
    - scm.mfg_so_item_deletions still has 4 HC rows
```

Measured on run 32455489040 (2026-08-21) and 32357340470 (2026-08-20). The plan
had reported 0 rows for that table. Nothing was corrupt — the wipe had committed
and the 2990 guard was green — but the run exits 1, so **a first apply always
failed and always needed a second run.**

**Root cause (traced).** Migration `0302_scm_so_item_delete_audit.sql` installs
`trg_mfg_so_item_delete_audit`, an `AFTER DELETE ON scm.mfg_sales_order_items`
trigger that writes one row per deleted line into `scm.mfg_so_item_deletions`.
That table is itself on the wipe's CLEAR list, and it is a CHILD, so the
topological delete order empties it BEFORE the items. The single pass therefore
runs in exactly the wrong order for its own side effect: delete the audit rows,
delete the items, trigger writes the audit rows back. The counts line up exactly
— 4 SO items deleted, 4 audit rows found.

**This is the "check that answers a different question" trap** from CLAUDE.md,
one rung up: the verification asked "is the table empty?" when what it needed to
assert was "is the table empty AND has nothing put rows back?". A row count that
is honestly 4 reads as a failed wipe.

**A second, separate defect found in the same trace, and it is the expensive
one.** `.github/workflows/golive-wipe-hc.yml` uploaded the backup with
`if: mode == 'apply'` and no `always()`, so a step failure skips the upload.
The script dumps the backup BEFORE it deletes — which means **the run that most
needs its backup uploaded is the one that fails.** Run 32357340470 deleted
35,328 HC rows, committed them, failed this verification, and its dump — the
only copy, including the 30 `scm.autocount_outbox` rows that were the ERP's
entire memory of what it had sent to AutoCount — died with the runner. The only
surviving artifact (32358148080) is from the no-op apply afterwards and holds an
EMPTY outbox, which reads exactly like "there was nothing to back up". That lost
evidence is why migration 0316's seed has to hardcode the account book's numbers
from `ac-live-proof.json`: nothing else remembers them.

**Fix.** Both, in `fix/doc-no-counter-table`:

1. The apply path SWEEPS the CLEAR set until a pass deletes nothing (ceiling 3,
   then it refuses rather than looping). Generic on purpose — any future
   `AFTER DELETE` trigger writing into a CLEAR table converges the same way,
   instead of this one table being special-cased and the next one repeating it.
   The first pass still has to equal the planned total or the whole wipe rolls
   back; the sweep is counted and reported separately.
2. `if: ${{ always() && … }}` on the artifact upload, with the artifact named
   per run+attempt so a failed apply's dump can never be mistaken for a later
   successful one's.

**Ref.** `fix/doc-no-counter-table`, 2026-08-21. Runs 32455489040 and
32357340470. Related: entry 0491 and `docs/doc-number-reissue-coe.md`.
