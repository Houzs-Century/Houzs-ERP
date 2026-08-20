## The AutoCount sales-order pull reported healthy runs while moving nothing [high]

**Symptom.** 2026-08-19: a salesperson could not find `SO-005263` in the Service
Case picker. The order plainly exists in AutoCount; the owner confirmed it.

**Root cause (traced, and the code already records it).** At the Postgres
cutover, the INSERT in `services/pull.ts` was carried over verbatim from the old
D1 schema and named SEVEN columns the Postgres table does not have —
`transfer_to`, `note`, `inv_addr1..4`, `sync_error`. Postgres answers an unknown
column with 42703 and refuses the WHOLE statement, so every sales-order row
failed.

**What turned a bug into months of silence** is the advance guard:

```js
if (mode === "filtered" && failed === 0) { ...advance pull_checkpoint... }
```

**One failing row freezes the checkpoint.** Every row failing froze it at the
cutover date, so the same window was refetched forever and the mirror took
nothing. Each per-row failure is caught and counted, so the job kept reporting
normal-looking runs the whole time — `AUTOCOUNT_SYNC_DISABLED="false"`, runs
completing, failure counts nobody reads.

This is CLAUDE.md's *"a failure that reaches nobody is worse than a crash"* at
its most expensive: the ERP believed it was mirroring AutoCount, and every
downstream reader — the Service Case SO picker among them — believed the mirror.

**The INSERT is already fixed.** What was NOT visible from the code is whether
the BACKLOG was ever collected, because that lives in one row of
`system_settings`.

**Fix.** `check-autocount-pull-health.mjs` + a `workflow_dispatch` reporting the
three numbers that separate *running* from *working*: where `pull_checkpoint`
sits and how stale that is, the newest `doc_no` actually in the mirror, and how
many rows arrived in the last 7 / 30 days. Its verdict names the remedy:
`pull.ts:29` says `all` mode goes through `/getAll` and does **not** touch the
checkpoint, so a backlog can be collected without unfreezing anything by hand.

**Still open, and it is the real root fix.** Nothing alerts on "the pull ran and
moved nothing". Until something does, this class recurs and is discovered the
same way — by a person who cannot do their job.

**Ref.** `chore/autocount-pull-health`, 2026-08-19.
