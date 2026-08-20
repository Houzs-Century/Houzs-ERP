## /health was the only gate on a service swap, and it opens no database [high]

**Symptom** - the AutoCount write-back service was rebuilt and swapped on the
host. `/health` answered `{"ok":true,"book":"AED_HOUZS"}` and the deploy
reported DONE. The service was in fact unable to reach the account book at all:
the very next real request came back **500 `Error Locating Server/Instance
Specified`**. Nothing staff-facing broke only because the write-back toggle is
still off.

**Root cause (traced, not guessed)** - `/health` answers from CONSTANTS. It
proves the process is listening and which book it was COMPILED for; it opens no
session, so it cannot say whether the connection line works. `deploy-on-host.ps1`
used it as the sole post-swap gate, so a build carrying a server name the host
cannot resolve passed verification. The name came from `setup.json`
(`192.168.1.198\A2006`) while the host actually resolves `.\A2006` - the value
LINQPad has been using all along. Proved by calling `/ensure-masters` on the
host with an empty payload: 500 with that message, while `/health` stayed green.

**Two things the same investigation turned up.** `setup.json` names database
**`AED_DEMO`**, not `AED_HOUZS` - a build that trusted it would point the live
write-back at the wrong book, which is the same shape as the earlier
`DONE - built against AED_TESTING`. And the SQL bridge (`tempdb.ac_src_bridge`),
documented as holding "the CLEAN source", holds **31,897 chars with no
`/ensure-masters` and no fail-closed auth** - it is stale, and a rebuild from it
would have shipped the old service again.

**Fix** - the post-swap gate is now `/health` AND `/ensure-masters` with an
empty payload, which opens the session on its first line and creates nothing; a
non-200 rolls back automatically and prints the `-Server` hint. The deploy also
asserts the PORT before it builds: fixing the BEL byte made
`C:\Temp\ac-svc-port.txt` readable for the first time, so a stray file carrying
the old 8899 would now silently move the service off the port cloudflared
fronts - the script refuses rather than swapping. Verified: dry run with no port
file proceeds on 8900, dry run against a file saying 8899 refuses and swaps
nothing.

**Lesson** - **a health check that shares no code path with the work is not a
health check.** Ours proved liveness and a compile-time constant, and was
trusted for connectivity it never touched. Gate a deploy on the cheapest call
that actually exercises the dependency.

**Ref** - `fix/ac-deploy-verify-db`, 2026-08-12

---
