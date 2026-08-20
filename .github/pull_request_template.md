## Working agreement (CLAUDE.md — MANDATORY, checked by CI)

`Working agreement` in Actions checks these four. Meeting them here is cheaper
than being told afterwards.

- [ ] **Bug logged.** This PR is not a fix, or it adds a new `docs/bugs/` entry
      (Symptom → Root cause → Fix → Ref, newest first, with a severity tag).
      Exception → label `no-bug-history-needed`; the log will print what it waived.
- [ ] **Module guide read, and updated if the SURFACE moved** — a new route, a
      new permission string, a new status value, a field that starts or stops
      being required, a new lock. Exception → label `no-guide-change`.
      No guide for the module yet? Write it, following `docs/modules/sales-order.md`.
- [ ] **Serious incident?** An outage, data at risk, a fault that recurred, or
      anything that made the system feel unreliable to staff gets a
      `docs/<subject>-coe.md`, not just a `docs/bugs/` entry.
- [ ] **Remedy claim proved.** If this PR tells anyone that performing some
      operation repairs something, an `Observed:` line below carries what you
      saw when you did it — a status, a count, a duration, an error, a run URL.
      Never done it? Put the word `UNTESTED` in the sentence, or label
      `remedy-untested`. Reading the source is not evidence about production.

- Observed:

### Migration (required when `backend/src/db/migrations-pg/` changes)

Both lines are parsed. Leave them out and the check fails; there is no label for this.

- Reversal:
- Verified against:

## Scope

- [ ] This PR has one bounded purpose and names the affected modules.
- [ ] Backend/API/database/migration/permission changes are either absent or link the owner's explicit approval below.

Backend approval (required when applicable): N/A

### Completeness

<!--
Claiming a whole population anywhere in this PR? Paste the command that ENUMERATES
it, plus that command's exact output, in a fenced block tagged `enumeration`. CI
re-runs the command against this PR head and fails on any difference, so the list
proves itself instead of asking to be believed. One command per block; add another
block for another population. Allowed: grep, rg, git grep, git ls-files, node -e.

Copy the block below OUT of this comment and fill it in:

```enumeration
$ git grep -n "missingVariantAxes(" -- backend/src frontend/src
<the exact output, pasted>
```

Not claiming a population, but the wording tripped the check? Reword it to what you
actually covered, or add the `completeness-not-claimed` label.
Leave this section empty if it does not apply.
-->


## Regression proof

- Bug / hardening ID:
- Failing-before test or written waiver:
- Passing-after command and result:
- [ ] The `docs/bugs/` entry links the regression evidence for a bug fix.
- [ ] No `.only` / skipped critical proof was introduced.

## Release safety

- [ ] Typecheck, tests and production build pass for every changed app.
- [ ] Frontend changes pass bundle and service-worker gates.
- [ ] Search/list changes state `SERVER_ALL`, `CLIENT_ALL` or `CLIENT_CAPPED` and test page reset plus A→A1 stale races.
- [ ] Mutation changes test failure UX, retry/duplicate-click behavior and preserved user input.
- [ ] Migration changes document target, checksum/drift behavior, rollback/restore and failure injection.
- [ ] PII, tokens and actor identity are absent from logs, screenshots and fixtures.

## Handoff

- Rollback / recovery:
- Evidence or screenshots:
- [ ] Claude Code reviewed the final diff before merge to `main`.
