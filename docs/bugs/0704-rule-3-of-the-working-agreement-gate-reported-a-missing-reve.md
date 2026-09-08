<!-- area: Repo tooling: tests, ratchets, generators -->

## Rule 3 of the working-agreement gate reported a missing Reversal line against a body that stated it [low]

**Symptom.** PR #3207 carried a migration and a PR body with both required
lines, each on a line of its own:

```
Reversal: DROP TABLE IF EXISTS scm.so_reconcile_verdict; ...
Verified against: scm.app_config as created by 0272 ...
```

The gate answered, on run `34197700964` (2026-09-08 15:07 MYT):

```
FAIL [migration-notes] 20260908T1420_scm_so_reconcile_verdict.sql: the PR body
     must state how this migration is REVERSED and what it was VERIFIED AGAINST.
     Missing: a line reading `Reversal: <how it is undone, or why it cannot be>`
     Missing: a line reading `Verified against: <the database/catalog it was proved on>`
```

Both lines were there. Re-typing them differently would not have helped, because
nothing about their wording was wrong.

**Root cause (traced).** `findStatement` in `scripts/lib/working-agreement.mjs`
split the body on `"\n"` only, and **GitHub returns a PR body with CRLF**. Every
matcher it is handed ends `(.*)$` — and in JavaScript `.` does not match `\r`.
So the capture stops before the `\r`, `$` has a character left to consume, and
the line does not match at all.

Observed, not reasoned:

```js
const RX = /^\s*(?:[-*]\s*)?(?:\*\*)?(reversal)(?:\*\*)?\s*:(.*)$/i;
RX.test('Reversal: DROP TABLE x')     // true
RX.test('Reversal: DROP TABLE x\r')   // false
```

and the live body of #3207, read back through `gh pr view --json body`, showed
`"Reversal: ...\r"` as node saw it — 0 matches under the old split, 1 under the
new one.

The first attempt to confirm this was itself wrong and is worth recording: a
`sed` meant to revert the fix for a RED run matched nothing (`grep -c` returned
0), so the "before" test ran against the **fixed** file and passed. That is the
"check that is not running" trap, inside the investigation of a checker. The
second attempt toggled the line by index and printed which line it changed.

**Why it matters more than the two minutes it cost.** This is the repo's own
*"a checker that cannot match reports a clean run"* trap **with the sign
flipped**: it does not report a false clean, it reports a false VIOLATION. That
is not the safe direction it looks like. A gate that fails compliant PRs is a
gate people learn to scroll past, and this one carries three MANDATORY owner
rules. Rule 3 could not have passed for ANY PR whose body GitHub stored with
CRLF, so its green runs were selecting on line endings, not on discipline.

**Fix.** `split(/\r?\n/)`. One line, in the one place the body is split for
statement matching.

Pinned by a new case in `scripts/lib/working-agreement.test.mjs` that feeds a
CRLF body stating both things and asserts `ok === true`. **Proved RED on the
unfixed tree:** with the `\r?` removed, `node --test` reports `pass 44 / fail 1`
and names it — *"a CRLF body states the same two things and must be read the same
way"*; with it, `pass 45 / fail 0`.

**Ref.** `feat/so-lock-by-correctness`, 2026-09-08.
