## An upload failure printed no reason at all [medium]

**Symptom.** Uploading the AutoCount line photographs to R2 on 2026-09-07, the
run logged sixteen lines of the shape

```
  !! so-items/HC-SO-010883/0f053f07-.../ac-758398-1.jpg:
```

— the key, a colon, and nothing. Sixteen failures that could not be told apart
from each other, or from a failure we already understand. The end-of-run summary
repeated the same emptiness.

**Root cause (traced, not guessed).** `wrangler()` in
`backend/scripts/upload-line-photos-r2.mjs` returned
`{ ok, out: r.stdout || '', err: r.stderr || '', code: r.status }` and dropped
two fields `spawnSync` sets: `r.error` and `r.signal`.

`spawnSync` reports a process that never STARTED (ENOENT, EAGAIN) or one KILLED
by a signal with `status === null` and BOTH streams empty. The caller then built
its message as `(res.err || res.out).trim()...`, so for exactly those cases the
message was the empty string — and `log(\`  !! ${r.key}: ${...}\`)` printed the
key and nothing else.

**The class, and why it is worth an entry.** The same shape was fixed in the
AutoCount connector the same day: `Session()` threw
`new Exception("AutoCount login failed")` with no user id, and when the deploy
switched the login from ADMIN to AOTG the 500 it produced could not say which
account had been refused. **A message that cannot distinguish its causes is not
a message** — and both were found only because someone was standing over the run
when it failed.

**Fix.**

1. `wrangler()` carries `r.error` and `r.signal`, and synthesises a reason when
   both streams are empty: `spawn failed: <message>` / `killed by <SIGNAL>` /
   `exited with no status and no output`.
2. The failure record falls back to `no output; exit code N[, signal S]` if it
   still somehow has nothing, so an empty reason cannot be recorded by any path.

**Verified.** `node --check` passes, and the three no-output cases were driven
through the new expression directly:

```
ENOENT   -> spawn failed: spawn npx ENOENT
signal   -> killed by SIGKILL
exit1    -> no output; exit code 1
```

**Not fixed here:** WHY those sixteen uploads failed is still unknown — the run
that produced them is gone and it recorded nothing. The next failure will say.
That is the honest state, and it is the reason this entry exists rather than a
root-cause entry about R2.

**Ref.** 2026-09-07, this PR. Sibling fix in the connector: PR #3019
(`AcSyncService.cs`, `Login(USER, PASS)` and the named failure).
