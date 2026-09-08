## The "is the migrated lock holding" check counted the allocation cron as a staff edit, so its alarm was always on [low]

**Symptom.** `check-so-open-for-new.mjs` shipped in #3169 to answer "after the
freeze lift, did a new order save, and did anyone touch a migrated one". Its
first real run against production — 2026-09-08 11:29 MYT, run `34183368917` —
reported:

```
MIGRATED orders touched by a staff action in the last 24h: 50 (capped at 50).
  HC-SO-007005  UPDATE_STATUS  by System (auto-allocate)  via automation
  HC-SO-007499  UPDATE_LINE    by system (auto-allocate)  via auto-allocation
  ... 48 more, every one of them the same
```

Fifty of fifty were the cron. A check whose alarm is on every time it runs is a
check nobody reads by Wednesday — and this one was about to be the evidence that
the migrated-order lock was holding during go-live.

**Root cause (traced, and refuted by the run, not by reading).** The query's own
comment asserted *"system recomputes do not go through the audit log, so this is
close to a pure staff signal"*. That sentence was written from reasoning about
what an audit log is for, and it is false: `recomputeSoStockAllocation` writes
`UPDATE_LINE` rows at `scm/lib/so-stock-allocation.ts:998` and `UPDATE_STATUS`
rows at `:1082`, with the same shape a person's edit produces. The rows are
distinguishable only by their attribution — `actor_id IS NULL` plus an
`actor_name_snapshot` beginning "system".

Nothing in CI could have caught it. The SQL was valid, the script exited 0, and
the number it printed was correct — it was the QUESTION that was wrong. This is
the repo's own "check that answers a different question" trap, and the only
thing that found it was dispatching the check.

**Fix.** The query splits into two: rows attributed to the system are COUNTED
and reported as expected background, rows credited to a person are LISTED and
are the alarm. An unattributed row that is not named "system" counts as a
person, deliberately — hiding it would be the permissive direction, and this
check exists to be un-permissive.

With the split, the same 24-hour window reads **0 people, 50 system** — which is
the sentence that is actually worth having on the day the freeze lifts.

**The transferable part.** A workflow_dispatch check is not shipped until it has
been dispatched once and its OUTPUT has been read. #3169 said as much and
labelled both new checks UNTESTED; running the first one is what produced this
entry, twelve minutes after the merge.

**Ref** — fix/so-open-check-staff-signal, 2026-09-08. Follows #3169.
