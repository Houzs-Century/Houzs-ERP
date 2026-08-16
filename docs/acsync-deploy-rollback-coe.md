# AcSyncService Deploy — The Rollback Had Never Worked COE (Correction of Error)

**Date:** 2026-08-16
**Trigger:** A routine rebuild of the AutoCount service on the office host. The
deploy refused the new exe correctly, tried to roll back, and the rollback died
mid-way. Measured aftermath on the host: `Get-Process *AcSync*` empty, `/health`
"Unable to connect", ERP write-back dead until it was restored by hand — about
ten minutes.
**Status:** FIXED IN CODE, **NOT YET PROVEN ON THE HOST.** The fix is in
`backend/scripts/autocount-service/deploy-on-host.ps1`. Nobody on the
development side has a Windows host or an AutoCount licence, so the script's own
next run is the test. Read §6 before treating this as closed.

---

## 1. Why this is a COE and not just two `BUG-HISTORY.md` entries

`CLAUDE.md` reserves a COE for "an outage, data at risk, a fault that recurred,
or anything that made the system feel unreliable to staff." This clears that bar
twice, and the second reason is the one worth the document:

**A rollback that has never been exercised is not a rollback, and three
documents were resting their safety argument on this one.** The script's own
header said it "ROLLS BACK by itself". `docs/autocount-service-deploy.md` §2
repeated it. `docs/autocount-handling-listing.md` listed the rebuild as the
low-risk job, on the strength of it. None of those sentences had ever been
tested, and all three were false. The bug was not that a copy failed; it was
that a *safety mechanism nobody had run* was being counted as protection by
everything downstream of it.

That is the same shape as `docs/staging-bench-rot-coe.md` (a check that had been
crashing for three weeks while its greenness was read as evidence) and the MRP
guard that could never fire. **A gate that cannot fail, and a rollback that has
never run, are the same defect: they read as protection and are not.**

---

## 2. Root cause, traced

### Fault 1 — the rollback raced the file handle, and `Stop` on error finished the job

The host transcript names the line:

```
the new exe did not pass verification - rolling back
Copy-Item : The process cannot access the file 'C:\Temp\AcSyncService.exe'
            because it is being used by another process.
At C:\Temp\acbuild-0816b\deploy-on-host.ps1:243 char:3
+   Copy-Item $prev $exe -Force
```

The source at that point, on `origin/main` before this PR:

```powershell
241  Get-Process -Name "AcSyncService" -ErrorAction SilentlyContinue | Stop-Process -Force
242  if (Test-Path $prev) {
243    Copy-Item $prev $exe -Force
```

Three separate things had to be true, and all three were:

1. **`Stop-Process -Force` does not wait.** It signals the process and returns.
   Windows keeps the executable image file open until the process has actually
   gone, so line 243 ran against a file that was still locked. There is no
   `Start-Sleep`, no `WaitForExit`, and no retry between the two lines.
2. **`$ErrorActionPreference = 'Stop'`** (line 41) turns that `Copy-Item` failure
   into a terminating error. The script ends *there* — before the
   `Start-Process` on line 244 that was supposed to bring the old exe back.
3. **The new process had just been killed** by line 241. So neither exe was
   running, and nothing said so. The last thing the console printed was a
   PowerShell stack trace, not "the service is down".

The forward path had the same race with a two-second sleep over it
(`Stop-Process -Force; Start-Sleep -Seconds 2` at line 180, `Copy-Item` at 187).
It happened to win that evening. It is the same defect with a cushion.

**Why it was never caught:** the rollback only runs when verification fails, and
verification had not failed before. The first time the safety net was needed was
the first time it was executed.

### Fault 2 — the connection was tested at the most expensive possible moment

```
connection line assembled from setup.json — server '192.168.1.190\A2006'
/ensure-masters: (500) ... error: 26 - Error Locating Server/Instance Specified
```

Measured on the host the same evening:

| tried | result |
|---|---|
| `.\A2006` | OK — `DESKTOP-TQ4S0IT\A2006` |
| `localhost\A2006` | OK — `DESKTOP-TQ4S0IT\A2006` |
| `192.168.1.190\A2006` | FAIL — error 26, Error Locating Server/Instance Specified |

Host addresses: `10.147.17.100`, `192.168.0.104`, `169.254.*`. SQL is **local to
that box**; `setup.json` points at a subnet the machine is not on.

The script read that address, assembled it into the connection line, printed it,
substituted it into three methods, compiled 77,824 bytes, **stopped the running
service**, swapped the exe, started the new one — and only then asked whether
the address worked, via `/ensure-masters`. `/health` cannot ask: it answers from
compile-time constants and passes regardless.

So a wrong string in a config file cost a service stop and a rollback attempt,
when the same discovery three minutes earlier would have cost nothing.

**`setup.json` is not ours to fix.** It lives at
`C:\InistateConnector\setup.json` and belongs to Inistate, the system this ERP
is replacing and which is still running. Editing another live system's config to
make our deploy convenient is out of bounds. The fix is on our side.

---

## 3. Fixes shipped, 2026-08-16

All in `backend/scripts/autocount-service/deploy-on-host.ps1`.

| Change | Effect |
|---|---|
| `Stop-AcSyncAndWait` | Kills every `AcSyncService`, `WaitForExit`s each handle, then polls the process **name** until it is gone (so a second instance started by another session is waited for too). Returns false on timeout instead of pretending. |
| `Wait-FileWritable` | Opens the destination with `FileShare::None` in a retry loop. The process being gone and the file being free are different facts; this asks for the second one. |
| `Copy-Verified` | Waits, copies with retry, then **compares SHA256 of source and destination**. A `Copy-Item` that did not throw is not a copy that landed — the whole rollback rests on the bytes being right. |
| `Invoke-Rollback` | One implementation for both failure paths. Stop → wait → verified copy → start → **poll `/health` until it answers**. It reports what actually happened at each step instead of assuming. |
| Backup moved **before** the stop | Reading a running image is allowed on Windows, so the rollback target is taken while the service is still up. If the backup cannot be made, the deploy refuses **without ever creating an outage window**. |
| No-`prev` path no longer stops anything | Previously it killed the new process and then discovered there was nothing to restore. It now leaves the running exe alone: a service that answers and fails its database beats no service at all. |
| **SQL pre-flight, section 3** | Opens a real `SqlConnection` with the same server, user, password and book the exe is about to be compiled with, and reads `DB_NAME()` back. Runs **before** substitution, compile, backup or stop. |
| Pre-flight failure message | Names the server tried and where it came from, the host's own IPv4 addresses, that `setup.json` must not be edited, and `-Server '.\A2006'` as the override. Then probes the local instance and, if one answers, prints the exact re-run command. |
| **`Complete-Exit` — the last act, on every path** | Every exit routes through one function that asks "is anything answering `/health`?" If no, and this run stopped or replaced the service, it prints a full-width red banner and the five recovery commands, and exits **2**. |
| Exit codes | `0` deployed and verified · `1` refused or rolled back, service running · `2` **the service is not running**. There was no way to tell these apart before. |
| `Wait-Health` | Replaces `Start-Sleep 3` / ask / `Start-Sleep 5` / ask with a poll. Faster on a healthy host, patient on a loaded one. |
| `Protect-Secret` | The pre-flight can surface SQL errors, so the "credentials NOT shown" property is now enforced rather than assumed: the password is scrubbed from any message printed, and SQL error 18456 (*Login failed for user 'X'*) — the one error whose text quotes a credential back at you — is described, never quoted. |
| `$buildCs` deleted first in `Complete-Exit` | The substituted source holds the password and the exit path now does real work (an HTTP probe) before ending. It is removed before any of that, in addition to the existing `finally`. |

### How the rollback now guarantees a running service

It cannot *guarantee* one — a host can defeat any script, and if the previous
exe is also broken there is nothing to restore to. What it guarantees is
narrower and is the thing that was missing:

1. A verified rollback target exists **before** the service is stopped, or the
   deploy refuses and stops nothing.
2. Every copy waits for the handle and is checked by hash afterwards, so a
   locked file produces a retry and then a message, never a dead script.
3. The restored exe is **started and polled** until `/health` answers.
4. Whatever the outcome, the last thing printed is whether something is
   listening — and if nothing is, and this run is why, it is impossible to miss
   and the exit code says so.

Number 4 is the load-bearing one. The failure mode being corrected is not "the
copy failed"; it is "the copy failed and the console's last line was a stack
trace."

---

## 4. What this audit RULED OUT

- **The new exe was not the problem.** It compiled cleanly (77,824 bytes) and
  answered `/health` with `{"ok":true,"book":"AED_HOUZS"}`. Rejecting it was
  correct — `/ensure-masters` returned 500 because it could not reach SQL. The
  verification logic worked; only the response to it failed.
- **Not a code defect in `AcSyncService.cs`.** The 500 was
  `error: 26 - Error Locating Server/Instance Specified`, which is the client
  failing to find the instance before any AutoCount code runs.
- **Not a credential problem.** `.\A2006` and `localhost\A2006` both opened with
  the same credentials from the same `setup.json`. Only the address was wrong.
- **Not `setup.json` being malformed.** The script parsed it correctly and
  printed exactly what it found. The file is internally fine; it is describing a
  network that no longer exists.
- **`AcSyncService.prev.exe` was not missing or corrupt.** The backup was taken
  successfully — `previous exe kept as C:\Temp\AcSyncService.prev.exe` is in the
  transcript. The restore never got as far as reading it.
- **Not a permissions problem on `C:\Temp`.** The same script had written
  `AcSyncService.exe` there seconds earlier. The lock was the running image, not
  an ACL.

---

## 5. The address contradiction, recorded and NOT bridged

`docs/autocount-handling-listing.md` said `setup.json` names
`192.168.1.198\A2006`. The 2026-08-16 transcript read `192.168.1.190\A2006` from
the same file. **One of those is wrong, or the file changed between the two
readings, and nobody has looked.** Neither is written down as fact; the doc now
carries the contradiction instead of a number.

It does not change any conclusion here — both are on `192.168.1.0/24`, which the
host is not on — but `CLAUDE.md` is explicit that a contradiction is a finding
and the urge to reconcile it into a clean sentence is where wrong answers come
from. **What settles it:** the next run prints the server it read, before it
touches anything.

---

## 6. What is NOT verified, plainly

This is the part to read before trusting the rest.

- **The fixed script has never been executed.** There is no Windows host, no
  PowerShell, and no AutoCount licence on the development side. `pwsh` is not
  installed on the machine this was written on (`which pwsh` → not found), so it
  has not even been parsed by a real PowerShell.
- **What WAS checked**, and it is weak evidence about behaviour: a purpose-built
  tokenizer confirmed braces, parentheses, brackets and quotes balance and that
  no function is called before it is defined. It was self-tested — it passes the
  known-good pre-change script and fails a deliberately dropped brace and a
  deliberately unterminated string. It says nothing about whether the logic is
  right.
- **The `-DbLineFile` path's pre-flight is a regex over a C# line.** If it does
  not match, the script says `PRE-FLIGHT NOT RUN` loudly and continues rather
  than refusing, because refusing would block a legitimate deploy over a
  formatting difference. That warning has never been seen on a real file.
- **The pre-flight is necessary, not sufficient.** It opens SQL from the
  PowerShell session. `/ensure-masters` after the swap is still the only thing
  that proves the *running exe* can reach the book through AutoCount's own
  session layer, and it is retained.
- **The banner has never been seen.** Its wording, width and colour are
  untested against a real console.

**The script's own next run on the host is the test.** If the pre-flight refuses
with a named override, or a rollback completes and reports a listening service,
that is the first real evidence either half works.

---

## 7. Deferred

| Item | Why deferred | Decision owner |
|---|---|---|
| **Nothing in CI parses `.ps1` at all.** `grep -rl "\.ps1" backend/tests scripts` returns nothing; a syntax error in this script reaches the host. A parse gate would need PowerShell in CI or a checked-in tokenizer. | Out of scope for a fix to two defects, and a checker nobody maintains is its own failure mode (`staging-bench-rot-coe.md`). | Owner |
| **Automatic fallback to the local SQL instance.** Deliberately NOT built. Two instances can each hold a database called `AED_HOUZS` — a restored backup is one — and silently pointing production write-back at the wrong copy would be data divergence with no error anywhere. The script probes the local instance and prints the exact re-run command instead, which gets the operator to the same place in one extra command with the decision still theirs. | Judgement call, argued in the PR. Revisit only if the manual `-Server` step is being skipped in practice. | Owner |
| **`setup.json`'s stale address.** Not ours. `-Server` is the fix on our side. | Inistate's file, and Inistate is still running. | Owner |
| **The service is started with `Start-Process`, not as a Windows service.** Nothing restarts it if the host reboots or the process dies on its own; this deploy script is the only thing that ever starts it. | Pre-existing, unrelated to these two defects, and a real change in operational shape. | Owner |

---

## 8. Lessons

1. **A rollback that has never run is not a rollback.** It is a paragraph. This
   one was cited as the safety argument in three documents and had never been
   executed once. If a recovery path cannot be exercised, say in the document
   that it is untested — do not let downstream text spend it as protection.
2. **`Stop-Process` returns before the process is gone.** Waiting for the
   process and waiting for the file handle are two different waits, and both are
   needed before you overwrite a running executable on Windows.
3. **`$ErrorActionPreference = 'Stop'` inside a recovery path is a trap.** It is
   right for the forward path — refuse early, change nothing. In the rollback it
   converts a retryable file lock into an abandoned recovery. Recovery code must
   be written to survive its own failures and report them.
4. **Test the expensive precondition first.** Anything that can refuse should
   refuse before the first irreversible step. Discovering a bad server address
   after the stop cost an outage; the same discovery before the stop costs
   seconds.
5. **A script that can leave a service down must never exit quietly.** The last
   line of output is the only thing an operator reliably reads. Making the final
   act a listening check, with an exit code that distinguishes "refused" from
   "down", costs ten lines.
6. **Do not edit another live system's config to make your deploy convenient.**
   `setup.json` belongs to Inistate. An override flag on our side is the fix; a
   silent edit to their file is a second outage waiting for a different team.
