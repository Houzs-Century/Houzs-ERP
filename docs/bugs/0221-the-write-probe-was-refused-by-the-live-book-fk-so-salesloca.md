## The write probe was refused by the live book: FK_SO_SalesLocation, and two more defects in the same scripts [medium]

<!-- area: AutoCount sync + write-back -->

**Three defects, all found by RUNNING the scripts against the live host rather
than by reading them. None reached production; all three sat in scripts shipped
hours earlier in #2253.**

**1. `FK_SO_SalesLocation` — the probe could not create its scratch order.**
Symptom: `/create-so` answered
`{"ok":false,"error":"Foreign Key Error (Constraint Name=FK_SO_SalesLocation)"}`.
Root cause: `SalesLocation` is a HEADER field and is not optional;
`fd-probe.ps1` sent `Agent`, `DebtorCode` and a line `Location` but no header
`SalesLocation`. It is the header-level twin of `FK_SODTL_Location`, the line
one already documented. **The ERP itself never trips this** — `autocount-outbox.ts`
raises `MissingSalesLocationError` naming this exact constraint and refuses to
enqueue — so the constraint is invisible until something hand-writes a payload.
`qa-convert.ps1` has always sent it. Fix: send it, with the refusal quoted at the
site.

**2. Both new scripts defaulted to an unreachable base URL.** Symptom:
`Invoke-RestMethod : Bad Request - Invalid Hostname`, HTTP 400, on every call.
Root cause: they defaulted to `http://127.0.0.1:8900`, but the service registers
the prefix `http://localhost:<port>/` (`AcSyncService.cs:100`) and `HttpListener`
matches on the Host header, so a numeric-IP request is refused before any route
runs. `deploy-on-host.ps1` had always used `localhost`, which is why its own
health check passed in the same run that my step 3 failed. Fix: default to
`localhost` in both.

**3. `host-session.ps1` did not fetch the probe it tells you to run.** Its
fetch list was `AcSyncService.cs`, `deploy-on-host.ps1`, `qa-convert.ps1`;
running `fd-probe.ps1` afterwards died on
`The argument ... does not exist`. Fix: added to the list.

**Lesson.** #2253 claimed the C# was compiled and run — it was — but the
PowerShell around it had never executed against anything. A script that has not
been run is not evidence, and the same rule the repo already applies to
`workflow_dispatch` workflows ("not shipped until dispatched once") applies
here.

**Ref:** this PR, 2026-08-15.
