## The write-freeze runbook told everyone to run a workflow that did not exist [medium]

**Symptom.** Every lift of the SCM write freeze — the switch that decides
whether the floor can save anything at all — has been carried out, or rather
*prepared*, as a raw SQL statement pasted into a runbook and left for a person.
Three separate sections of `docs/write-freeze-staged-lift.md` end with a
`PREPARED, NOT RUN` statement. On 2026-09-08 the owner asked for delivery orders
to be opened so staff could ship, and the fastest honest answer available was
still a hand-typed `UPDATE`.

That is a direct breach of a MANDATORY owner rule this repo has carried since
2026-08: *never ask the owner to run a query — build the check instead.* Nobody
was ignoring it.

**Root cause (traced).** The runbook's §6 opens with:

> Actions -> **SCM write freeze (on/off)** -> Run workflow:

and lists its inputs — `target`, `state`, `companies`, `areas`, `message`. **No
such workflow was ever built.**

```
$ grep -rl "SCM write freeze" .github/workflows/
.github/workflows/check-write-freeze.yml
.github/workflows/golive-stage0-check.yml
```

Both matches are READ-ONLY checks that report the current value. Neither can set
it. The section immediately below the missing workflow offers *"the equivalent
SQL, if you would rather do it directly"* — so the fallback read as a
convenience, and became the only path, and nobody noticed the primary
instruction was fiction. The doc even warns that SQL *"skips the validation the
workflow runs"*, describing validation that had never existed either.

**Why it survived.** A doc that describes a workflow is indistinguishable from a
doc that describes a workflow that exists, and `check-docs-drift.mjs` resolves
paths, migration numbers, permission keys and `npm run` names — not the NAME of
a GitHub Actions workflow written in prose. This is the same class as `audit:map`
reporting nothing for three weeks: **green is not evidence until you know the
check ran**, and here there was no check at all, only a sentence.

**Fix.** `backend/scripts/set-write-freeze.mjs` +
`.github/workflows/set-write-freeze.yml`, with the runbook corrected to the
workflow that now exists rather than the one that never did.

Four things the SQL path could not do, and each is why the fallback was worse
than it looked:

1. **A mistyped area is REFUSED and named**, validated against the mounts in
   `scm/index.ts` through the same reader the read-only check uses — never a
   second copy of the parse. The middleware treats a token it cannot resolve as
   "stays frozen", so `scm.sales.deliveries` written by hand is a silent no-op
   that reads as a successful lift.
2. **What the value CLOSES is printed as loudly as what it opens.** The value is
   the whole list of what is open, not an addition, so
   `'1 - scm.sales.delivery'` silently re-freezes `scm.procurement.products`,
   open to staff since 2026-09-02. An apply that closes anything is REFUSED
   unless `allow_close=yes` says so out loud. The asymmetry is deliberate:
   opening the wrong module is visible within minutes; silently re-freezing one
   somebody relies on looks like the ERP being broken and nobody connects it to
   this.
3. **`app_config.description` — the sentence staff read when a module refuses
   them — is only touched when asked.** The write names its columns rather than
   upserting the row, so an ordinary lift cannot blank the explanation.
4. **The verification re-reads on a FRESH connection and asserts the SHAPE** —
   which areas the middleware will actually resolve — not that one row came
   back. A stored string that parses to a different set than intended is exactly
   the failure a row count cannot see.

**What this fix does NOT claim.** It does not open anything by itself, and no
value was changed by shipping it. `MODE` defaults to `plan`.

**Ref.** PR pending, 2026-09-08. Runbook: `docs/write-freeze-staged-lift.md` §6.

---

## The first dispatch FAILED, and that is the rule working

**Run `34209796675`, 2026-09-08, `mode=plan` against production:**

```
set-write-freeze — MODE=plan
BEFORE  scm.write_freeze = "1 - scm.procurement.products"
TypeError: areaKeys.has is not a function
    at validateFreezeValue (backend/scripts/lib/scm-area-keys.mjs:80:18)
```

`readScmAreaKeys()` returns a **Set**, and `validateFreezeValue` calls `.has()`
on whatever it is handed. This script normalised it to a sorted ARRAY for its own
filtering and printing — and then passed that array into the library. Every local
check passed: `node --check`, both refusal guards, the release-discipline gate.
None of them reaches that line, because none of them has a database to get past.

**Nothing was written.** It is the plan path, and it died before the write.

Fixed by keeping BOTH shapes and never deriving one at a call site: `AREA_SET`
is what the library gets, `areaKeys` is the sorted array this file filters and
prints with. A startup assertion now refuses to run at all if
`readScmAreaKeys()` ever stops returning something with `.has`, so the next
person gets a sentence instead of a `TypeError` inside somebody else's module.

**This is the repo's own rule earning its keep, not an accident:** *a
`workflow_dispatch` workflow is not shipped until it has been dispatched once
and reported success.* The PR body said UNTESTED in exactly those words. The
first dispatch is what found it — and the same rule was written after #2120
failed on its first dispatch for a different reason.
