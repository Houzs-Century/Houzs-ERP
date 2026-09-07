## I edited an applied migration because I inferred from the runner source that it had not applied [high]

<!-- area: Deploy, CI, migrations -->

**Symptom.** Production deploy run **34143840138** (2026-09-07 16:39Z /
2026-09-08 00:39 MYT), the second pipeline block of the night:

```
376 migration(s), 393 applied, 1 pending, ...
Migration drift detected. Applied migration history is immutable:
  DRIFT   20260907T2340_scm_do_item_ac_substituted.sql:
          stored sha256:546ba4e8…, current sha256:c7e15ccd…
Add a new migration instead of editing or deleting an applied one.
```

**Root cause (traced).** PR #3124 rewrote that migration's body — adding a
`lock_timeout` + retry loop after the timeout recorded in
`docs/bugs/0677-*` — on the stated grounds that *"the file never applied, so
there is no checksum to drift against"*.

That claim was produced by **reading `backend/scripts/pg-migrate.mjs`**: each
file runs inside `pg.begin()` and the transaction rolls back on error, so a
failed file records nothing in `_pg_migrations`. The reasoning is correct in
itself. What it cannot tell you is whether some **other** run has succeeded since
— and one had. Between the failure and the rewrite, a later deploy retried and
got the `ACCESS EXCLUSIVE` lock, which had freed on its own. The tracker row
existed.

So a migration that had already applied normally was edited, and the drift check
blocked the pipeline a second time — for a problem that had resolved itself
without help.

**The refuting evidence was on screen and was misread.** The failing run printed
`393 applied, 1 pending` where the earlier one printed `392 applied, 1 pending`.
That increment *is* the migration going in. It was read as noise.

**Fix.** Restore the file to the exact bytes that applied
(`git checkout <sha> -- <file>`), and prove the restore against the stored value
**before** pushing rather than after, using the repo's own checksum module:

```
restored body checksum: sha256:546ba4e883f5a78c94bb3437f26a0c42a8c2bf24a39aed8047a3f0d48c478c43
MATCHES PROD TRACKER  : true
```

The column itself was never in doubt: `scm.delivery_order_items.ac_substituted`
exists in production, applied normally, with the original body.

**The rule this buys.** *Before editing ANY migration file that has ever been
dispatched, PROVE it is absent from `_pg_migrations`. Do not infer it from the
runner's source.* A failed run is evidence about **that run**, not about the
file's state — and on a busy day several runs of the same pipeline overlap.

This is CLAUDE.md's *"reading code is not evidence about production"* rule with a
new instance, and it is a particularly cheap one to have avoided: the hypothesis
("this file never applied") had an obvious refuting observation (read the tracker,
or grep the intervening deploy logs for `APPLIED <file>`), and the rule says to go
and make it. It was skipped because the pipeline was blocked and the fix felt
urgent. **Urgency is exactly when the one-command check is worth most** — the
first block cost one failed deploy; skipping the check cost a second one.

**Ref.** Wrong edit: PR #3124. Recovery: PR #3133 (2026-09-08). The lock-contention
failure it was trying to fix is `docs/bugs/0677-*`.
