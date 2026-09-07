## The AutoCount exporter printed the SQL password whenever sqlcmd failed [high]

**Symptom.** A Desc2 export window hit its statement timeout on 2026-09-07 while
the live book was busy, and the thrown error printed the whole sqlcmd command
line into stdout — including `-P <the AED_HOUZS password>`. Anyone reading that
run's output, in a terminal or a pasted traceback, was reading the credential.
Nothing in the script logged it deliberately; the failure path did.

**Root cause (traced).** `backend/scripts/export-ac-reconcile-truth.mjs` passes
the password as an argv value to `execFileSync` — which is the right place for
it, and is why it never reaches a shell. But Node builds a failed
`execFileSync`'s message as `Command failed: <the entire command line>`, so the
argv it was protecting comes straight back out in `e.message` on ANY non-zero
exit: a timeout, a dropped ZeroTier tunnel, a bad login. The script caught none
of them, so the default handler printed the message and the stack.

Observed, not reasoned: the run's own output carried
`Command failed: ...sqlcmd.exe -S 10.147.17.100,55500 -d AED_HOUZS -U sa2 -P <redacted> ...`
followed by `Timeout expired`. That is the whole trace — one line of real
output, on the first failure this script had ever had.

The window is the entire life of the file. It shipped in #3031 on 2026-09-07 and
had no failing run before this one, so the exposure is one local terminal, not a
CI log: `.github/workflows/ac-erp-reconcile.yml` runs the CHECKER, never the
exporter — the book is reachable only over ZeroTier from the office network and
a GitHub-hosted runner has no route to it.

**Fix.** Every sqlcmd invocation is now wrapped, and the rethrown error goes
through `scrub()`, which replaces the password with `<redacted>` in both the
message and any captured stdout. `scrub` guards against an empty password
because `String.split("").join(x)` would otherwise insert the replacement
between every character. The same wrapper is what lets a timed-out Desc2 window
narrow itself and retry instead of dying, so the fix and the resilience are one
change.

Not covered by a test: reproducing it needs a live sqlcmd that fails, which is a
credentialed network round trip and not something CI can hold. What IS checkable is
that there is exactly one call site, inside the wrapper —
`grep -n "execFileSync(" backend/scripts/export-ac-reconcile-truth.mjs` names one
line, and it is the one the try/catch encloses. (Measured 2026-09-07: `grep -c
execFileSync` on that file is 4 — the import, this call, and two mentions in
comments — so count the CALL, `execFileSync(`, not the word.)

**Ref.** feat/ac-variant-reconcile-2026-09-07, 2026-09-07.
