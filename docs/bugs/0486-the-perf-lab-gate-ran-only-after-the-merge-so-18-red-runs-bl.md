## The perf-lab gate ran only AFTER the merge, so 18 red runs blocked nothing [high]

<!-- area: Deploy, CI, migrations -->

**Symptom.** `frontend-perf` went red on `main` and stayed red. Eighteen
consecutive Postsubmit runs failed — first run `32390289786`, head `80f4f9756`,
which is the MERGE COMMIT of #2568; last `32405172079` — while every one of
those PRs merged green. The second step of the job, `npm run test:perf-local`,
ran zero times in that whole window: a failing first step hides every step
behind it, so the browser suite was dark from 2026-08-20 15:43Z without anything
saying so.

**Root cause (traced).** Two independent facts, each verified rather than read:

1. **The gate was on the wrong side of the merge.**
   `.github/workflows/postsubmit.yml` triggers on `push: branches: [main]` only,
   so it can only ever run AFTER the merge that broke it. Confirmed against the
   live ruleset rather than assumed —
   `gh api repos/Houzs-Century/Houzs-ERP/rules/branches/main` returns exactly
   four required contexts: `backend-typecheck`, `frontend`,
   `company-scope-ratchet`, `completeness-claim`. None covers `frontend-perf`.
2. **Nothing else typechecks these files, and that is structural, not
   carelessness.** `frontend/perf-lab/tsconfig.json` extends
   `../tsconfig.app.json` and narrows `types`; `frontend/tsconfig.json`
   references only `tsconfig.app.json` and `tsconfig.node.json`. So perf-lab is a
   SECOND tsc project, not a laxer one, and `tsc -b` — the whole of
   `npm run typecheck` in the required `frontend` path — structurally cannot
   reach it.

The move to postsubmit (2026-08-18) was made on evidence that read
`frontend-perf: 37 success, 0 failure`. That number measures how often the gate
FIRED, not what it GUARDS. It was the only check over an otherwise unguarded tsc
project, so forty greens meant "nobody has broken it yet" — which is not the
same claim, and is the one the decision needed.

**Fix.** `frontend-perf` moved back into `.github/workflows/ci.yml` as a
parallel job (`ci.yml` triggers on `pull_request` + `merge_group`, so the queue
gate is not weaker than the PR gate), gated on `changes` like every other
frontend job, and — the part that actually makes it a gate — added to the
required `frontend` roll-up's `needs` AND to its result assertions. Being in
`needs` alone is not enough: the roll-up is `if: always()`, so without
`ok frontend-perf` it would pass while the job failed. `npm run test:perf-local`
moved with the typecheck, not instead of it.

Wall clock cost is **+0s**, measured, not argued: on ci.yml run `32404531239`
`changes` finishes at +32s and this job takes 92s (postsubmit run `32405631087`:
typecheck 43s, browser suite 15s), so it occupies +34s..+126s, while
`frontend-checks` ends at +163s and `backend-typecheck` at +187s. The runner slot
was checked too — across the last 12 ci.yml runs the worst job-level queue wait
was 3s at 14-16 jobs, against the 20-slot ceiling in `docs/ci-capacity-coe.md`.

Pinned by `frontend/scripts/check-perf-lab-gate.test.mjs`, run from
`frontend-typecheck` — deliberately not from the job it guards, since a checker
inside that job dies with it. **Proved RED on the unfixed tree** against all five
ways this silently un-fixes itself: `frontend-perf` dropped from the roll-up's
`needs`; the `ok frontend-perf` assertion deleted while it stays in `needs`;
`merge_group` removed from the triggers; the job removed from `ci.yml`; and the
`test:perf-local` step dropped. All five exited 1.

**Ref.** `ci/perf-lab-gates-presubmit`, 2026-08-21.
