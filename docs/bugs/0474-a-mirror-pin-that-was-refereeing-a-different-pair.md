## A mirror pin that was refereeing a different pair [high]

<!-- area: Repo tooling: tests, ratchets, generators -->

The DO -> Sales Invoice fix rests on one sentence: the rule has ONE home, and the
browser's copy is *held byte-identical*. The holder named in the PR body, in
BUG-HISTORY and in `docs/modules/document-conversion.md` was
`check-shared-mirrors.mjs --strict`. It was not holding it.

**Measured.** A bogus state added to `frontend/src/vendor/shared/do-shipped-states.ts`
left `check-shared-mirrors.mjs --strict` reporting **0 DIVERGED, exit 0**, and
left `doShippedStatesMirror`, `doStatusCaseNormalisation` and
`oneSystemTwoOrganisations` all green. Nothing in the repository noticed.

**Why.** The script only FAILS a diverging pair it considers unrefereed, and
`refereed()` (`check-shared-mirrors.mjs:94`) is a heuristic over test SOURCE
TEXT: a pair counts as refereed when some test file mentions
`shared/<module>.ts`, contains a cross-tree path fragment, and contains
`readFileSync` / `toBe(` / `toEqual(`. Three independent string matches, none of
which has to occur in the same assertion — or even be about this module. The
file that satisfied all three was `frontend/src/vendor/scm/lib/do-next-step.test.ts`,
which is about `do-next-step` and compares nothing. The pair was reported as
`TESTED` and its divergence printed rather than failed.

`doShippedStatesMirror.test.ts` genuinely does referee a pair — the backend `.ts`
against `backend/scripts/lib/do-shipped-states.mjs`, the hand copy the audit
scripts read, because a `.mjs` audit cannot import TypeScript. A DIFFERENT pair.
The frontend twin had no referee at all, which is how a mirror-plus-pin pattern
ends up with the mirror and without the pin.

**Fix.** `frontend/src/vendor/shared/do-shipped-states.canonical.test.ts`, the
shape `total-height.canonical.test.ts` and `phone.canonical.test.ts` already use:
read both files, normalise line endings, assert byte-identity, plus a
non-vacuity test so the comparison cannot pass on two empty reads. Proven in
both directions — RED with the corrupted twin naming the file, GREEN once
restored. The three claim sites are corrected to name the test that actually
holds the pair.

**NOT fixed here, and it is the wider half:** `refereed()` still passes any pair
whose module name appears in an unrelated test. Tightening it would reclassify
other pairs and could turn `--strict` red repo-wide, so it is raised rather than
changed inside a PR about something else.

**The pin earned itself the same day.** Hours after it was written, #2557 added
`DO_NOT_DELIVERED_STATES`, `doCountsAsDelivered` and `DO_NOT_DELIVERED_IN_LIST`
to `backend/src/scm/shared/do-shipped-states.ts` and NOT to the frontend twin.
`check-shared-mirrors.mjs --strict` passed that divergence, exactly as described
above. `do-shipped-states.canonical.test.ts` failed on it by name and the twin
was synced from the backend home. Nothing else in the repository noticed — which
is the difference between a pin and a paragraph claiming there is one.
