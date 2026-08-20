## `completeness-claim` failed on LINE NUMBERS, so an unrelated merge turned a PR red with nothing in it changed [medium]

<!-- area: Repo tooling: tests, ratchets, generators -->

**Symptom.** A PR whose diff had not touched a single member of the population
it enumerated went red on `completeness-claim` after merging `main`. The
author's only remedy was to regenerate the ```enumeration block by hand and push
again — proving nothing, costing a CI round, and (worse) training people to
treat a red completeness gate as noise. Compounded by finding #3 below: on
2026-08-16 the reaction to one such failure was to DELETE a legitimate
enumeration block out of another agent's PR.

**Root cause (traced, not guessed).** The gate re-runs the pasted command and
diffs its output as a multiset (`diffOutput`, `scripts/lib/completeness-claim.mjs`).
CLAUDE.md, the runner's own `HOW_TO` and the pull_request_template all show
`git grep -n`, so authors write `-n` and every pasted line carries a
`path:NNN:` COORDINATE. The populations this repo enumerates live in
`mfg-sales-orders.ts` (11,988 lines) and `Projects.tsx` (15,128) — files touched
constantly. Any merge into the branch shifts those numbers, every line of the
pasted block mismatches, and the gate reports the stale-enumeration shape for a
population that did not change. The membership was identical; only its
coordinates moved, and the diff was comparing coordinates.

**Fix.** A leading `path:NNN:` is normalised to `path:` on BOTH sides before the
diff (`stripLineNumber`). Same argument as the pre-existing sort: the diff
already drops output ORDER because `rg` walks in parallel and order carries no
meaning — a line number carries no membership either. What the gate still fails
on is unchanged and pinned by tests in both directions: a site ADDED, REMOVED,
RETEXTED, or moved to a DIFFERENT FILE all fail (the path is kept), and two
sites in one file stay two entries in the multiset. `grep -c` output (`path:12`,
no trailing colon) is deliberately NOT matched — there the number IS the
population's size.

Rejected alternative: refusing `-n` in an enumeration command. It would turn
every block already written here, and the example this repo's own documentation
tells authors to copy, into a `COMMAND_REFUSED` failure — more red of exactly
the shape being removed — and it throws away a number the human reviewer wants.

The one coordinate shape left is a BARE `NNN:` from `grep -n pattern onefile`: a
leading number with no path cannot be told apart from content, so the gate still
FAILS and now names the cause and the one-line fix instead of showing two lists
that look identical.

**Proof it still bites.** `node --test scripts/check-completeness-claim.test.mjs`
— 52 pass / 0 fail with the fix; with `stripLineNumber` reverted to the identity,
47 pass / **5 fail**, exit 1.

**Ref.** PR (this one), 2026-08-17.
