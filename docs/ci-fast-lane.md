# CI fast lane — where a small change's time goes, and what was cut (2026-09-15)

**Trigger.** Owner, 2026-09-15: someone told him "with our setup a change takes
5 minutes, with direct access 1 minute". Asked: make small changes ship faster
without weakening the checks that protect money, stock and documents.

**Rule followed.** CLAUDE.md, *Measure before you optimise*: every number below
came from the GitHub API or a job log, and names where it came from. The
collector and analyser are not committed (one-off); the method is in §5 so it can
be re-run.

## 1. Measured: the last 60 merged PRs (#3780s–#3885, merged 2026-09-13..14)

Classified with `ci.yml`'s own `changes` rule: docs-only = every file under
`docs/`, `tasks/` or `*.md`; backend-only / frontend-only = one app plus prose;
mixed = both apps, or any other file.

Median (p90), wall clock:

| type | PRs | open → merge | PR CI (required contexts done) | queue: enqueue → merge | queue CI | merge → live |
|---|---|---|---|---|---|---|
| frontend-only | 9 | 19m22s (124m) | 5m42s (6m03s) | 6m19s (7m46s) | 5m33s | 7m54s (12m58s) |
| backend-only | 14 | 13m47s (49m) | 4m13s (4m51s) | 6m02s (6m49s) | 5m44s | 9m51s (14m30s) |
| docs-only | 3 | 14m05s (18m) | 4m12s (4m23s) | 6m17s (7m24s) | 4m37s | 8m29s (14m17s) |
| mixed | 34 | 24m30s (47m) | 5m47s (6m07s) | 6m16s (6m38s) | 5m36s | 9m27s (12m21s) |
| **all** | **60** | **19m02s (51m)** | **5m34s (6m02s)** | **6m16s (6m49s)** | **5m33s** | **9m03s (12m58s)** |

Other medians: 2 CI runs per PR (p90 3); 1 queue run per PR (p90 1); last push →
enqueue 7m07s (so ~1.5 min of it is the author reacting to a green run); runner
queueing is not a factor (3,260 jobs: median 2s, p90 3s from created to started).

Per-job median, from the same runs:

| job | on the PR | in the queue | on the deploy |
|---|---|---|---|
| `frontend-checks` (vitest --coverage, 484 files) | **5m12s** | **5m09s** | — |
| `backend-typecheck` (≈70 audits + tsc + `test:light`, 811 files) | 4m07s | 4m08s | — |
| `backend-tests (n)` ×3 | 2m49s | 2m49s | — |
| `frontend-perf` | 1m55s | 1m58s | — |
| `frontend-typecheck` | 1m50s | 1m50s | — |
| `lint (backend)` / `lint (frontend)` | 1m20s / 1m17s | same | — |
| deploy `frontend` (typecheck, whole vitest suite, build, retention, Pages, smoke) | — | — | **7m40s** |
| deploy `backend-tests (n)` ×4 | — | — | **4m41s** |
| deploy `backend` (audits, tsc, pg-migrate, wrangler, smoke) | — | — | 1m36s |

Step-level, from job logs (merge-group run 34873941486, deploy run 34874575924):
`npm run test:coverage` 302s of `frontend-checks`' 325s; `test:light` 148s of
`backend-typecheck`'s 253s; deploy `frontend`: `npm test` 182s, typecheck 63s,
build 69s, retention 39s.

### The top three time sinks

1. **Everything runs twice before a merge.** PR CI (5m34s) then the merge-queue
   CI (5m33s) on — in 28 of 60 PRs — a tree identical to the one the PR run had
   already turned green (the queue's base commit equalled `main`'s tip when the
   PR's final green run started). The queue always runs both halves.
2. **`frontend-checks` is the critical path of both runs.** 5m12s, almost all
   of it one serial `vitest run --coverage`. Its own comment said "18s bare,
   20s instrumented" (2026-08-13); the suite grew ~15x and the comment did not.
3. **The deploy re-verifies what the queue just verified, and does it wastefully.**
   9m03s merge → live. The `frontend` job (7m40s) ran for all 60 merges,
   including the 17 that changed no frontend file. Each of the four
   `backend-tests` shards ran `npm test -- --shard=i/4`, and npm appends the
   flag to the LAST command of `test` — so every shard ran all **811** light
   files (112–152s each, logs of deploy run 34874575924) before its quarter of
   the workers suite.

## 2. The candidates, with the saving and the risk

| # | idea | saving (measured basis) | risk found | verdict |
|---|---|---|---|---|
| A | Shard the frontend vitest suite across 3 runners, merge the blob reports + coverage | `frontend-checks` 5m12s → ~3–4m; the run's critical path becomes `backend-typecheck` (~4m10s). ≈1–1.5 min per run, on the PR AND in the queue | coverage merged wrong → ratchet false result. Guarded: the ratchet refuses a report missing a file; merged numbers compared against an unsharded run (§4) | **IMPLEMENTED** |
| B | Deploy: run the light suite once, shard only the workers suite | each deploy shard stops re-running 811 files; backend release path 4m41s → ~3m | none — same files, same commands; `backend` asserts both jobs | **IMPLEMENTED** |
| C | Deploy: skip the frontend release when nothing since the last successful frontend deploy can change the build | 7m40s of runner time on 17/60 merges; docs-only merge → live drops to the `changes` job; deploy runs are serial, so the next run waits less | a collapsed run hiding a frontend change — answered as the backend already answers it: base = last run whose `frontend` JOB succeeded, fail-open, `workflow_dispatch` always publishes. A skip leaves the live Pages deployment (and every chunk #3827 retains) untouched | **IMPLEMENTED** |
| D | Merge queue skips backend/frontend half by path, like the PR run | backend-only queue run 5m44s → ~4m10s | **UNSAFE, not done.** The halves are not independent: 54 frontend test files read backend source (`backend/src/services/capabilities.ts` …), backend tests read `frontend/src`, and tests read `docs/*.md` (`moduleGuideLedger.test.ts`, `bugIndexAreas.test.ts`). The PR run's path skip is only acceptable BECAUSE the queue runs everything — it is the net under it | **REJECTED** |
| E | Merge queue reuses the PR's green result when the tree is identical | 28/60 queue runs × 5m33s ≈ 2.6 min per PR on average | touches what a REQUIRED context means (a success reported without running); a bug in the identity test fails open. Must also refuse reuse where the PR run path-skipped a half (see D) | **PROPOSAL — owner** (§3) |
| F | Backend-only PRs skip frontend vitest; docs-only skip backend tests | — | already true on the PR run since 2026-08-18 (`ci.yml` `changes`); extending it to the queue is D | nothing to do |
| G | Run `test:light` concurrently with the audits inside `backend-typecheck` | ≤ ~40–70s, CPU-contended | `audit:generators` REWRITES generated files that tests import (`check-generators-run.mjs` header) — a read during the rewrite is a flaky failure in a required context | **REJECTED for now** |
| H | Deploy stops re-running tests the queue ran on the identical tree | frontend deploy −4m; backend deploy −3m | **the deploy's backend tests are the only BLOCKING run of the workers suite.** The required contexts are `backend-typecheck`, `frontend`, `company-scope-ratchet`, `completeness-claim`; the `backend` roll-up (workers shards, lint, file-size, e2e-contract) is NOT required, so a red workers shard does not stop a merge | **PROPOSAL — only after §3.2** |

## 3. Needs the owner (ruleset / required-check semantics) — not implemented

1. **Queue reuse on an identical tree (E).** In `ci.yml` on `merge_group`: if the
   group is a single entry, its base (`merge_group.base_sha`) is an ancestor of
   the PR head, the group tree equals the tree the PR's newest `ci.yml` run
   tested, that run concluded success, and its `changes` job ran BOTH halves —
   then the heavy steps report success without re-running. Saves ~5.5 min on
   ~47% of PRs. It changes what "`frontend` passed in the queue" means, so it is
   the owner's call, and it must ship with a test that fails when any of the
   four conditions is dropped.
2. **Make the `backend` roll-up required, or move the workers suite under a
   required context.** Today a failing money/stock DB test in `backend-tests (n)`
   does not block a merge; it blocks the NEXT DEPLOY (every later merge then
   sits unreleased). CLAUDE.md forbids adding `backend` as required because it
   is `skipped` on frontend-only PRs — true, but a job skipped by `if:` inside a
   triggered workflow reports as passing to a required check; the "pending
   forever" failure is a WORKFLOW that never triggers. Verify on a scratch
   ruleset before believing either sentence. Only after this is H safe.
3. **`changes` failing silently greens `frontend`.** Every frontend job needs
   `changes`; if `changes` itself fails they are all `skipped`, which the roll-up
   accepts. Pre-existing, not introduced here; a one-line fix (`ok changes`)
   belongs in its own PR.

## 4. Before / after (filled from the PR run and the next real PRs)

See the PR that introduced this file for the run ids and the timings observed
after it merged. Coverage parity for A is checked by comparing the ratchet's
`frontend/src` line in the sharded run against the unsharded
`coverage.yml` run on `main`.

## 5. Re-running the measurement

`gh pr list --state merged --limit 60 --json number,createdAt,mergedAt,files,headRefOid,mergeCommit`,
the GraphQL timeline (`ADDED_TO_MERGE_QUEUE_EVENT`, `PULL_REQUEST_COMMIT`), and
`actions/workflows/{ci,deploy}.yml/runs` + `runs/<id>/jobs` for job times. A
queue run is the `merge_group` run whose branch is
`gh-readonly-queue/main/pr-<N>-<base sha>`.
