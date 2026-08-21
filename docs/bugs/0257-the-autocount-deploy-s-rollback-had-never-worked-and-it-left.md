## The AutoCount deploy's rollback had never worked, and it left the service DOWN [critical]

<!-- area: AutoCount sync + write-back -->

**Symptom.** A routine rebuild on the office host, 2026-08-16 22:09. The deploy
correctly refused the new exe, printed `the new exe did not pass verification -
rolling back`, and then died inside the rollback:

```
Copy-Item : The process cannot access the file 'C:\Temp\AcSyncService.exe'
            because it is being used by another process.
At C:\Temp\acbuild-0816b\deploy-on-host.ps1:243 char:3
+   Copy-Item $prev $exe -Force
```

Measured aftermath on the host: `Get-Process *AcSync*` empty, `/health` "Unable
to connect". ERP write-back was dead for roughly ten minutes, until it was
restored by hand. **The outage happened because the deploy was run, and the
rollback that was supposed to make that safe did not work.**

**Root cause (traced, not guessed).** The PowerShell error names the line, and
the source matches it exactly. On `origin/main` before this fix:

```powershell
241  Get-Process -Name "AcSyncService" -EA SilentlyContinue | Stop-Process -Force
242  if (Test-Path $prev) {
243    Copy-Item $prev $exe -Force
```

`Stop-Process -Force` signals the process and **returns**; Windows holds the
executable's image file open until the process has actually exited. There is no
wait of any kind between 241 and 243, so the copy ran against a locked file.
`$ErrorActionPreference = 'Stop'` (line 41) then made that a terminating error,
so the script ended before the `Start-Process` on line 244 that was meant to
bring the old exe back. The new process had already been killed. Neither exe was
running and the last thing the console printed was a stack trace, not "the
service is down".

It had never been caught because the rollback only runs when verification fails,
and verification had never failed before. **The first time the safety net was
needed was the first time it was executed** — and the script's header, the
runbook and the handling listing had all been citing "it rolls back by itself"
as the reason a rebuild is low-risk. The forward swap has the same race with a
`Start-Sleep -Seconds 2` over it (line 180 stop, line 187 copy); it happened to
win that evening.

**Fix.** `Stop-AcSyncAndWait` kills, `WaitForExit`s each handle, then polls the
process NAME until it is gone. `Wait-FileWritable` then opens the destination
with `FileShare::None` in a retry loop, because the process being gone and the
file being free are different facts. `Copy-Verified` retries the copy and
**compares SHA256 of source and destination** — a `Copy-Item` that did not throw
is not a copy that landed. `Invoke-Rollback` is one implementation used by both
failure paths: stop, wait, verified copy, start, then **poll `/health` until it
answers**. The backup moved to BEFORE the stop (reading a running image is
allowed on Windows), so a deploy that cannot take a rollback target refuses
without ever creating an outage window; and the no-`prev` path no longer kills
the running process to reach a state with nothing running. Finally, every exit
routes through `Complete-Exit`, whose last act is to ask whether anything is
answering `/health` — if not, and this run stopped or replaced the service, it
prints a full-width red banner with the five recovery commands and exits **2**
(`0` deployed, `1` refused/rolled back with the service running).

**NOT verified, and this matters.** There is no Windows host, no PowerShell and
no AutoCount licence on the development side; `pwsh` is not installed on the
machine this was written on. The script has never been executed or even parsed
by a real PowerShell. What was checked is balance of braces, parens, brackets
and quotes plus call-before-define, by a tokenizer self-tested against the
known-good pre-change script and two deliberate breakages. **The script's own
next run on the host is the test.** `docs/acsync-deploy-rollback-coe.md`.

**Ref.** fix/acsync-deploy-rollback-preflight, 2026-08-16.
