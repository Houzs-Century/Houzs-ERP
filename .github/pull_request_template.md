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
- [ ] `BUG-HISTORY.md` links the regression evidence for a bug fix.
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
