## CLAUDE.md said the migration-number gate was still open for three days after it had closed [medium]

**Symptom.** `CLAUDE.md` carried, as a standing instruction to every session:
*"Move the duplicate-number assertion into `backend-typecheck` ... **Not done.
This is the open item.**"* A session picking that up on 2026-08-17 began building
a dependency-free `check-migration-numbers.mjs` and wiring it into
`backend-typecheck` — re-implementing a gate that already existed.

**Root cause (traced, not guessed).** The remedy was written on 2026-08-13, the
day #2121 merged a duplicate `0284` and production could not take a backend
deploy for ~30 minutes. It was correct that day: `migrationNumbers.test.ts` ran
in `backend-tests (2)`, which is not a required context.

It stopped being true on 2026-08-14. `d78d55bf` (#2131, *"perf(ci): 565s -> 106s
by not booting a Workers runtime for tests that never use one"*) created the
light vitest project and `classifyTests()` swept this suite into it, because the
suite needs no workerd. `backend-typecheck` runs `npm run test:light`. So the
assertion has blocked a MERGE since 2026-08-14 — nobody was aiming for that, it
was a side effect of a performance change, and nobody connected the two.

Proven three ways, not inferred:

```
$ grep -n "run: npm run test:light" .github/workflows/ci.yml
290:      - run: npm run test:light
$ cd backend && npx vitest list --config vitest.light.config.mts | grep migrationNumbers
tests/migrationNumbers.test.ts > migration numbering > ...
$ gh api repos/hello-houzs/Houzs-ERP/rules/branches/main --jq '...required_status_checks[].context'
backend-typecheck
frontend
```

**Fix.** `CLAUDE.md` corrected: the remedy is marked DONE, with the commands to
re-verify rather than a claim to believe, and the mechanism paragraph is kept
because it still describes every OTHER shard-only assertion truthfully.

**The real residual risk, and what now holds it.** The gating is INCIDENTAL. The
light/workers split is computed at config time by a regex (`NEEDS_WORKERS`) over
the comment-stripped source, so one added string containing `cloudflare:test` or
`env.DB` — a fixture, a fake env, an asserted error message — would move the
suite back to the shards and silently un-gate it, with CI still green. That is
the "check that stops running" shape of `docs/staging-bench-rot-coe.md`.

`backend/tests/classifyTests.test.mjs` now carries a `MUST_GATE_MERGE` list and
fails if any suite on it is not classified LIGHT. Proven to fire, not assumed:
appending `const __probe = "cloudflare:test";` to `migrationNumbers.test.ts`
turns it red with the reason and the three ways out; removing it returns 11/11.
The guard also fails loudly if a listed suite is renamed or deleted, rather than
passing vacuously over a name nothing matches.

**A second stale fact found in the same file, corrected.** That test's own header
recorded a defect — "a file that merely MENTIONS `env.DB` in a comment is exiled
to the serial pool ... five of the 46 workers-pool files" — and named three of
them. `stripComments` has since fixed it: `companyScopeFailClosed`,
`adminResetLink` and `reviewHighFindings` all classify LIGHT today, and the split
is 42/332, not 5-of-46. Corrected in place with the command to re-measure.

**What was NOT done, deliberately.** No second copy of the rule was shipped. A
duplicate `check-migration-numbers.mjs` enforcing an already-enforced assertion
is the "ONE RULE, MANY HAND COPIES" shape the 2026-08-15 handoff names; the
useful protection was on the CLASSIFICATION, not on the rule.

**Ref.** 2026-08-17.
