## The relink sweep stamped zero three times and could not say why [high]

**Symptom.** The hands-free relink sweep was run in `apply` against production
on 2026-09-11 — once at ~01:20 UTC and twice more that afternoon, the later runs
after a real fix to its matcher (`docs/bugs/0812`). **Every run stamped ZERO
keys.** The held-back documents stayed held back, and on each occasion the cause
could not be established. The handoff of that morning filed it as UNKNOWN with a
hypothesis ("LIKELY these are SOFAS") that nothing could check, and named making
this observable as the next action. That action was deferred twice more, and
both times the cause was guessed at and both times the guess was wrong.

**Root cause of the BLINDNESS, which is what this fixes.** The sweep computes
exactly what is needed — `SweepDocResult` already carries `keylessBefore`,
`stamped`, `wouldStamp`, a `refused[]` naming each line it could not match, and
a `skipped` reason — and then **throws it away**. Its only output was, in
`index.ts`:

```
console.log(`[cron ac-relink-sweep] ${JSON.stringify(r)}`)
```

`wrangler tail` on `autocount-sync-api` is DENIED for this account's token, so
that line cannot be read. A sweep that reads and writes a LIVE account book had
no readable account of itself.

**Two states that looked identical and are not.** A quiet day and a failed
candidate read both returned `scanned: 0` and logged nothing, because the error
branch returned the same empty summary. They are now distinguishable: a read
failure records itself with the message.

**Fix.** `recordSweepRun` writes a trimmed JSON summary to `scm.app_config`
under `scm.autocount_relink_sweep_last_run` — counts always, plus per-document
detail including the refusals, which is the part nobody could see. The health
workflow prints it under **RELINK SWEEP**. `scm.app_config` and not a new table:
this module already reads its switch from there, it needs no deploy to change,
and a run summary is operational state of exactly that kind.

**Best-effort, deliberately.** A report about a repair must never cost the
repair, so `recordSweepRun` swallows its own failure.

**Tests.** Two in `autocountRelinkSweep.test.ts`, both RED against the unfixed
tree: a run whose every line refuses records the counts AND the refusal text;
and a failed candidate read is recorded rather than passing as a quiet day.
`scm/lib` whole: 2292 passed. `typecheck` clean.

**What it does NOT do.** It does not make the sweep stamp anything. It makes the
next run say why it did or did not — which is what two rounds of guessing were
missing, and what has to exist before the real cause can be named at all.

**Ref.** 2026-09-11. Related: `docs/bugs/0812` (the matcher's sofa fold),
`docs/bugs/0813` (the same silence one layer up, in the drain).
