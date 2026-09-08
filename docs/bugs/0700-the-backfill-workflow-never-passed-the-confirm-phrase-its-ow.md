## The backfill workflow never passed the CONFIRM phrase its own script requires, so apply=1 could not write [medium]

**Symptom.** `Backfill AutoCount line keys (goods receipts + delivery orders)`
dispatched against production with `apply=1` (run `34192167270`, 2026-09-08
13:50 +08) failed in 8 seconds:

```
APPLY=1 requires CONFIRM="STAMP DOWNSTREAM LINE KEYS" — refusing to write.
##[error]Process completed with exit code 2.
```

Nothing was written. The guard did exactly what it exists to do; the workflow
around it could not satisfy it.

**Root cause (traced).** `backfill-ac-downstream-line-keys.mjs` carries the
CONFIRM phrase that `audit:release-discipline` requires of every writing script
(property 2 of four). The workflow was copied from
`backfill-ac-line-keys.yml`, whose script has **no** CONFIRM gate — it is one of
the 155 scripts grandfathered in `release-discipline-grandfathered.json` — so
the precedent had no `confirm` input to copy and none was added. Its `env:`
block passed `APPLY` and `DATABASE_URL` only. The two halves were written in the
same PR (#3199) and never run together, so nothing disagreed until the dispatch.

This is the trap CLAUDE.md already names: *"a `workflow_dispatch` workflow is not
shipped until it has been dispatched once and reported success"*, and the reason
given there is exactly this one — #2120 copied
`recompute-2990-so-allocation.yml`, a workflow that had never run, instead of
one that works. **Precedent taken by name similarity rather than by evidence the
precedent runs.** The DRY-RUN path was dispatched and passed (run
`34192040888`), which is why the gap survived: the default path exercises
everything except the one branch that needs the phrase.

**Fix.** A `confirm` input on the workflow, wired to `CONFIRM` in both the
staging and the prod job — the shape
`repair-migrated-grn-item-codes.yml` already uses, which is a workflow that has
actually run. The description names the exact phrase to type, so the operator
gets it from the dispatch form rather than from the source.

Pinned by the dispatch itself, not by a unit test: a workflow's `env:` block is
not reachable from vitest, and the honest check is a green apply run. Recorded in
the PR with its run id.

**Ref.** fix/ac-line-keys-confirm-input, 2026-09-08.
