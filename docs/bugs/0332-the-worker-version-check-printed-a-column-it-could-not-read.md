## The Worker version check printed a column it could not read, and drew a conclusion from it [low]

**Symptom.** The first successful run of `check-worker-versions.mjs` (run
`32097597670`) printed `GIT_SHA=(none)` against all ten versions — including
deploys that demonstrably set it, since `GET /health` serves that exact var. It
then printed, as guidance:

> A source of `wrangler` with no GIT_SHA is a bare hand-run deploy.

Read together, the check accused every deploy we make of being rogue.

**Root cause (traced).** `GIT_SHA` is a version BINDING, and the versions LIST
endpoint (`/workers/scripts/:script/versions`) does not return `resources`. The
script read `v.resources.bindings` off the list response, so the lookup found
nothing on every row and fell through to the `(none)` branch — which the
guidance then interpreted.

**Two defects, and the second is the one that matters.** An empty column is
cosmetic. An empty column plus a sentence that reads meaning into emptiness is a
checker reporting a finding it did not observe — the same class as a matcher that
cannot match reporting a clean run. **A column that cannot be populated must not
be reported as a finding.**

**Fix.**

- `GIT_SHA` is fetched per version from the detail endpoint, in parallel for the
  rows actually printed.
- Three states are now distinct: a **sha** (stamped by CI), **`(none)`** (bindings
  read, GIT_SHA genuinely absent — a hand-run deploy), and **`(unreadable)`** (the
  detail fetch failed; unclassified, and the guidance says so explicitly rather
  than letting it read as rogue).
- The per-version fetches are `soft` — one unreadable version cannot take down the
  answer to the question actually being asked. The two reads that ARE the answer
  stay hard: if either fails we know nothing, and reporting nothing is correct.

**Also fixed: timestamps were truncated to the minute.** The same run printed
`03:55` against two different versions, which made the ORDER of the pair
unknowable — and the order is the whole question when asking which of `deploy`
and `secret bulk` produced which version. Versions now print `created_on` to the
SECOND, and the script counts adjacent same-second pairs so the
two-versions-per-deploy pattern reads as expected behaviour instead of an alarm.

**Ref.** `docs/deploy-secret-version-deadlock-coe.md`, 2026-08-18.
