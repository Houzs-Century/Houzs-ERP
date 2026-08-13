# The coverage ratchet — what is measured, what is enforced, and what it cannot see

Measured 2026-08-13 against `origin/main` at `01599df1`, on an M-series Mac
(10 cores). Every number here came from a run. Re-derive them with §5 rather
than trusting this page — and note that the project split this document depends
on (`vitest.light.config.mts` vs `vitest.config.mts`) landed the same day in
#2131, which invalidated an earlier draft of this file measured hours before it.

## 1. Why per-area, and why two floors

One repo-wide percentage lets a well-tested area subsidise an untested one. That
is not hypothetical here: `scm/shared` is small and mostly pure functions with
tests beside them, `scm/routes` is 94 files and 27k executable lines of
handlers, and a single average hides which of the two you are about to change.
So each area carries its own floor, in `coverage-baseline.json`.

Two floors per area, both one-directional:

| floor | direction | why it exists |
|---|---|---|
| line coverage % | may only go **up** | the obvious one |
| files with **no test at all** | may only go **down** | the percentage cannot see the shape that hurts |

The second is the one that earns its keep in the two big areas. Dropping a
400-line untested module into `frontend/src` moves line coverage by about 0.1 of
a percentage point — a percentage-only gate waves it through. It moves the
no-test count by exactly 1. §6 says where it is blind.

## 2. The numbers

Line coverage, istanbul semantics (a line counts as covered when any statement
starting on it ran), `all: true` so untested files are in the denominator.

**Measured and floor are different numbers on purpose.** The floor is a tenth of
a point BELOW the measurement — slack for the MERGE BASE, not for the author. On a `pull_request` GitHub builds the merge with `main`, so a PR
inherits whatever main's coverage currently is; a floor pinned to the exact
hundredth fails whichever PR happens to run after someone else merges twenty
uncovered lines. This repo has already paid for that once on the bundle gate,
where a DOCS-ONLY PR failed by 0.1 KB (ci.yml, *Measure the merge base*). The
slack is bounded — 0.1pp is ~60 lines in `frontend/src`, ~3 in `scm/shared` —
and the second floor, `files with NO test`, carries no tolerance in the areas
where it means anything. A fully covered area floors at 100% with no slack at
all. This was not theoretical: the first CI run of this very feature failed
because `backend/scripts` measured exactly 4.20%, got a 4.20% floor, and main
landed one more untested ops script in the minutes between.

The table below is GENERATED from `coverage-baseline.json` by
`node scripts/coverage-ratchet.mjs --sync-docs`, and ci.yml fails if it drifts —
a typed number in a doc is exactly how CLAUDE.md came to claim the database was
D1 SQLite for a month after the Postgres cutover.

<!-- MEASURED-TABLE -->
| area | files | lines | covered | measured | floor | files with NO test |
|---|---:|---:|---:|---:|---:|---:|
| `backend/src/scm/routes` | 94 | 27004 | 3803 | **14.08%** | 13.98% | 0 |
| `backend/src/scm/lib` | 146 | 7628 | 4437 | **58.17%** | 58.07% | 10 |
| `backend/src/scm/shared` | 48 | 2401 | 1135 | **47.27%** | 47.17% | 4 |
| `backend/scripts/lib` | 40 | 2656 | 1430 | **53.84%** | 53.74% | 15 |
| `backend/scripts` | 379 | 31906 | 15 | **0.05%** | 0.00% | 378 |
| `frontend/src` | 593 | 59866 | 7624 | **12.74%** | 12.64% | 353 |

Floors as committed in `coverage-baseline.json`, measured 2026-08-13.
<!-- /MEASURED-TABLE -->

The unratcheted remainder — `backend/src` outside `scm/`, `frontend/functions` —
is measured and printed by the gate but carries no floor.

## 3. What runs where, and what it costs

Three suites produce coverage; all six areas are checked on every PR.

| suite | files | provider | bare | with coverage | job |
|---|---:|---|---:|---:|---|
| backend light (plain node) | 240 | istanbul | 7s | **41s** | `backend-typecheck` |
| backend workers (workerd) | 44 | istanbul | 106s | **265s** | `backend-tests`, 4 shards |
| frontend (jsdom) | 137 | v8 | 18s | **20s** | `frontend-checks` |

**Why istanbul on the backend at all.** The workers project runs inside workerd,
where v8 coverage is impossible: `node:inspector` is not functional there and
`@cloudflare/vitest-pool-workers` refuses the provider by name, naming istanbul
as the alternative.

**Why istanbul on the backend LIGHT project too, where v8 would be cheaper.**
The two backend projects' reports are MERGED, and a file in `scm/lib` is
executed by both. v8 and istanbul derive different statement maps for the same
file, so mixing them would either double-count that file or trip the gate's
shape check. One provider per merged set. The frontend is v8 and is never merged
with the backend.

**This was affordable only after #2131.** Before that split, all 284 test files
booted a workerd instance, and instrumenting `src/scm/routes` for each of them
took the suite from ~1s per file to ~20s: a single serial run reached 49 files
in 21 minutes, and five local shards took ~35 minutes wall. That is a gate
somebody turns off. Moving the 238 pure files to a plain node runner is what
made a per-PR coverage gate cost about a minute of extra runner time. (240/44 as
of 2026-08-13; `npm run audit:test-projects` owns the split.)

**On a `main` this busy, the baseline is refreshed with the branch.** Between
this feature's first measurement and its first CI run, main merged three more
untested `backend/scripts` files; the gate reported it correctly and the PR went
red for something its author did not do. That is the same problem the bundle
gate solves by rebuilding the merge base, and the same fix is available here at
the cost of a second full coverage run — not worth it yet. Until then: when you
update a branch, re-run `npm run coverage:update` and commit the baseline with
the update. The floors only ever move in the direction the tree actually moved.

**What blocks a merge today.** `backend-typecheck` and `frontend` are the repo's
required contexts (CLAUDE.md, *`main` IS protected now*). `frontend-checks` —
which the `frontend` roll-up covers — checks `frontend/src` inline, so a
frontend regression hard-blocks. The merged
all-areas check is its own `coverage-ratchet` job — a red X on the PR, not yet a
required context, because that list is the owner's to change.

## 4. The checks that make a green result mean something

`scripts/coverage-ratchet.mjs` refuses to report a percentage at all when:

- **no report was found.** A gate pointed at a moved artifact directory
  otherwise passes in silence.
- **an area matched zero files.** `covered/total` with a total of 0 is 100% by
  convention; without this check a scanner pointed at nothing scores perfectly
  forever.
- **a file on disk is absent from the report.** This is what turning
  `coverage.all` off looks like from here: the untested files vanish, the
  denominator shrinks, and the percentage JUMPS — a false green that looks like
  progress. A genuinely un-instrumentable file goes in `coverage-baseline.json`'s
  `knownAbsent` **with a `why`**, in the diff, where a reviewer sees it. There
  are three today: two `export *` barrels that compile to no statements, and the
  frontend's own vitest setup file.
- **two reports disagree about a file's statement map.** They were produced from
  different trees — a stale shard artifact — and merging them would invent a
  number describing no tree that exists. This fired for real while the feature
  was being built, on a file that was edited mid-run.
- **`--only` names an area that does not exist.** A typo that silently checks
  nothing is precisely the failure this file exists to prevent.

Its own logic is tested by `node --test scripts/check-coverage-verdict.mjs`,
which ci.yml runs in two jobs. Each check above has been observed RED against a
real violation and GREEN after.

## 5. Reproducing the measurement

```
npm --prefix backend  run test:coverage    # -> backend/coverage/{light,workers}/coverage-final.json
npm --prefix frontend run test:coverage    # -> frontend/coverage/coverage-final.json
npm run coverage:check                     # every area against its floor
npm run coverage:update                    # raise the floors after adding tests
npm run coverage:test-gate                 # the gate's own unit tests
```

`--only <area-id>` narrows both to the areas whose reports you actually have.
Lowering a floor needs `--update --allow-drop`, which says so loudly in the log
and shows up in the diff.

The area list lives in `scripts/coverage-areas.mjs` and is imported by ALL THREE
vitest configs' `coverage.include` and by the gate. One list, so what vitest
instruments and what the gate audits cannot drift apart.

## 6. Where it is thin, and where the gate is blind

**`backend/src/scm/routes` reports zero files with no test — and that is not
what it sounds like.** Every route module is imported through the router graph
by some test, so its module-level `new Hono()` runs and it never counts as
untested. Only the line figure is meaningful there; the no-test floor is blind
in this area and must not be read as reassurance. The handlers are what is
uncovered.

**`backend/scripts` is split in two, because one number over it was a lie in
both directions.** `scripts/lib/` — the modules that exist *because* a test
imports them (CLAUDE.md's shebang rule) — and the rest, the one-shot operational
scripts at 0.05%. Averaged together they read about 4%, which flatters the ops
scripts and slanders the library. Split, each says something true, and
`scripts/lib` is held to both floors. Both figures are in §2's generated table;
neither is typed here, because a typed number goes stale and the one that used
to sit in this sentence did.

**The one-shot area has its no-test floor turned OFF, deliberately.** Several
new ops scripts land a week; each is dispatched by hand through a workflow and
its output read once by a human, and a new one legitimately has no test. A floor
that goes red on every ops PR is a floor somebody deletes, and then there is no
floor at all. The count is still measured and printed, and the percentage floor
still applies, so deleting an existing test there still fails. The largest
untested files are diagnostics (`backfill-fifo-divergence.mjs`,
`repair-2990-doc-refs.mjs`, both around 900 lines); a wrong answer from a
diagnostic is a wasted afternoon, not a wrong ledger.

**`scripts/lib` has a MEASUREMENT blind spot, and it is the largest single
source of noise in this gate. Read this before you believe its no-test count.**

The merged report is produced by **vitest only** — `test:coverage:light` plus
`test:coverage:workers`. Vitest does not execute `node:test` files, so a module
whose only test is a `backend/tests/*.node.mjs` harness has **every line
reported as uncovered** and is counted as a file with NO test. It is not
untested; it is untested *by the runner that measures*.

Measured 2026-08-14, `backend/scripts/lib` reports **15 files with no test**.
Only **four** of those genuinely have none:

| file the gate calls untested | actually tested by | in which runner | line % under that runner |
|---|---|---|---:|
| `release-discipline.mjs` | `tests/releaseDiscipline.node.mjs` | `node:test`, `npm run test:release-discipline` (ci.yml) | 98.60% |
| `route-matrix-diff.mjs` | `tests/routeMatrixDrift.node.mjs` | `node:test`, `test:scale-contract` | 100.00% |
| `jsonb-bind-scan.mjs` | `tests/jsonbBindScan.node.mjs` | `node:test`, `test:scale-contract` | 95.53% |
| `po-cost-plan.mjs` | `tests/poCostPlan.node.mjs` | `node:test`, `test:scale-contract` | 97.91% |
| `id-restamp-exec.mjs` | `tests-pg/idRestampExec.pg.test.ts` | vitest **pg project**, `npm run test:pg` — a third config whose report is never merged | — |
| `ac-po-line-match.mjs` | `tests/acPoLineRepair.node.mjs` | `node:test`, `test:scale-contract` | 95.10% |
| `swallowed-read-scan.mjs` | `tests/swallowedReadScan.node.mjs` | `node:test`, `test:scale-contract` | 100.00% |
| `so-line-dedication.mjs` | `tests/acPoLineRepair.node.mjs` | `node:test`, `test:scale-contract` | 100.00% |
| `ac-po-line.mjs` | `tests/acPoLineRepair.node.mjs` | `node:test`, `test:scale-contract` | 100.00% |
| `ac-line-key-audit.mjs` | `tests/acPoLineRepair.node.mjs` | `node:test`, `test:scale-contract` | 96.15% |
| `catalogue-series.mjs` | `tests/catalogueSeriesOneList.node.mjs` | `node:test`, `test:scale-contract` | 100.00% |
| `sqlite-default-to-pg.mjs` | **nothing** | — | — |
| `scm-area-keys.mjs` | **nothing** | — | — |
| `bedframe-special-map.mjs` | **nothing** | — | — |
| `classify-tests.mjs` | **nothing** (it is imported by both vitest configs at config-load time, so it executes outside instrumentation) | — | — |

Reproduce the right-hand column with:

```
cd backend && node --experimental-test-coverage --test tests/*.node.mjs
```

**This is not a curiosity; it fails PRs.** This PR's own `coverage-ratchet`
check went red on `backend/scripts/lib` for three rounds. The cause was three
modules landing on `main` on 2026-08-13 — `release-discipline.mjs`,
`jsonb-bind-scan.mjs`, `swallowed-read-scan.mjs`, 407 lines between them — each
arriving *with* a thorough `node:test` suite that runs in CI. The gate saw 407
new uncovered lines and three new files with no test, and reported a coverage
regression that had not happened. The floors were re-baselined deliberately
(`--update --allow-drop`) on 2026-08-14 to record the measurement, not to
forgive a regression.

Expect this to recur every time a `scripts/lib` module lands with a `node:test`
suite. Until the gap is closed, the honest response is to confirm the module has
a test in another runner — the command above proves it in one line — and
re-baseline with `--allow-drop`, saying so in the PR. Do not close it by
deleting the floor, and do not close it by writing a second, redundant vitest
test for a module that already has a good one.

**Closing it properly** means one of: (a) converting the `node:test` harnesses
to vitest so their coverage lands in the same istanbul report — cheapest, but
`test:scale-contract` deliberately runs on plain node with no vite transform,
which is part of what makes it a *contract* test; (b) collecting node's own
`--experimental-test-coverage` output and converting v8 ranges to istanbul
statements before merging — the gate refuses mixed providers on purpose
(`shape_mismatch`), so this needs a real conversion, not a concatenation; or
(c) giving the baseline a `testedElsewhere` list beside the existing
`knownAbsent`, each entry carrying the harness that covers it and a `why`, so
the count means "no test anywhere" again. (c) is the smallest change that makes
the number honest, and it keeps the escape hatch visible in the diff.

**`frontend/src` is where the dangerous untested files actually are.** 353 files
with no test at all, and the largest are the screens that take money and move
stock: `MobileNewSO.tsx`, `SalesOrderDetail.tsx`, `SalesOrderNew.tsx` — each
several hundred executable lines — and `MobilePOD.tsx`, the driver's
proof-of-delivery screen at the centre of the RM 3,888 double-collection in
BUG-HISTORY, still at 0%. Rank them yourself with the gate's own report; the
list moves.

**`scm/routes` is thin for the worst reason of the three:** handlers carry
decisions inline that `scm/lib` exists to hold. CODEBASE-MAP §2 already states
the rule — *"If a rule could be wrong about money or about who may read
something, it belongs here with a test beside it, not inline in a route"* — and
the routes line figure is the measurement of how often it was skipped. Moving a
decision out of a handler into `lib/` with a test raises two areas at once,
which is the direction this ratchet should push.

**A percentage is not the point.** Chasing it by testing getters raises the
number and protects nothing. A test earns its place by FAILING when the decision
it guards is inverted, and the way to know it does is to invert the decision and
watch it go red — every test added with this ratchet was accepted on that basis,
and the inversions are listed in its PR.
