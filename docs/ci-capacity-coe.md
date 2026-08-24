# COE — CI capacity: the queue that ate the working day

**Date** 2026-08-13 · **Severity** P2 (no production impact; sustained loss of
delivery throughput) · **Status** fixed; the remaining items in Deferred are
decisions, not defects

---

## Trigger

The owner, in their words:

> "以前我们每一次完成一个东西，它的 CI 跑得很快的，现在就因为这个东西，拖慢了我们的工作进度"
>
> ("CI used to run fast every time we finished something. Now this thing is
> slowing our work down.")

and, on first looking at the Actions tab:

> "它的 CI 好像有点夸张，排队很长" ("the CI looks a bit crazy, the queue is very
> long")

Nothing was broken. Everything was slow, and had got slower without anyone
changing CI.

---

## Root cause

Three independent causes, measured separately. Every number below came from
`gh run list --json`, `gh api .../jobs`, or a direct timing probe run inside the
workers pool — not from reading the workflow files.

### 1. Every PR runs CI ~4.7 times, because 35 of them are open at once

`main`'s ruleset has `strict_required_status_checks_policy: true` — *require
branches to be up to date before merging*. That rule is correct and was added
for a good reason (three migration-collision incidents, see `CLAUDE.md`). But
it is quadratic when PRs are open in bulk: merging any one PR makes the other
34 stale, each needs *Update branch*, and each update fires a fresh CI run.

Measured over 24h: **173 CI runs across 35 open PRs**. One branch,
`fix/variant-itemcode-required`, ran CI **19 times in a single day**.

### 2. One CI run asks for 10 runner slots; the account has 20

`ci.yml` fans out to `backend-typecheck`, `backend-tests` ×4 shards,
`backend`, `scale-postgres-contract`, `backend-postgres`, `frontend`,
`e2e-contract`. With several PRs pushing together the demand is 60–90
concurrent jobs against a **20-job free-plan ceiling**.

> **That fan-out is the INCIDENT-DAY shape and both fixes in this document
> changed it.** On `origin/main` today `backend-tests` is `shard: [1, 2]` (two,
> per #2131) and `frontend` is four jobs (`frontend-checks`, `frontend-build`,
> `frontend-perf` and the `frontend` roll-up, per #2142) — eleven slots, not
> ten, arranged differently. Read this paragraph as the measurement that
> motivated the work, not as a description of CI now.

At the moment of measurement: **24 jobs unfinished, 5 sitting in `queued`**.
Worst observed waits: 132s at job level, **850s (14 minutes)** at run level.

### 3. The suite pays a fixed per-file cost 277 times, serially

`vitest.config.mts` sets `fileParallelism: false` and `maxWorkers: 1`
(deliberately — the workers pool collapses at higher concurrency; see the
comment there). So the per-test-file cost is multiplied by the file count, and
the file count has grown from the **112** that `ci.yml`'s sharding comment was
sized against to **277**.

CI shard 3 of run 31700016666:

```
Duration 378.84s (transform 6.14s, setup 262.33s, import 1.68s, tests 80.80s)
```

Setup was 69% of the job. 69 files × ~3.8s each.

---

## What the audit RULED OUT

This section is the point of the document. Four plausible theories were
followed and killed, three of them ours.

**"GitHub is queueing our jobs — we need a bigger plan."** Refuted by
`gh run list --json createdAt,startedAt`: across 24h the run-level wait was
`0s` for every run but one. Runners were being handed out immediately. The
contention was real but self-inflicted (cause 2), not a GitHub capacity
problem.

**"The per-file migration replay is what costs 262s of setup."** This was the
headline theory and it was wrong. `tests/setup.ts` did replay `schema.sql` plus
147 migrations — 1020 individually awaited statements — once per test file,
which *looked* like an obvious 283,000-round-trip disaster. A direct probe
inside the pool timed it: **1020 statements complete in 391ms.** The replay was
never the bottleneck. Setup time is dominated by per-file workerd startup and
module loading (~2s/file with any setup file at all, ~0.96s/file with none),
which is cause 3 and is unaffected by anything the SQL does.

**"Cut `backend-tests` from 4 shards to 2 to free runner slots."** Refuted by
arithmetic before it was implemented: 4 shards × 440s and 2 shards × 880s
occupy the *same* runner-seconds. Sharding trades latency for slots at a fixed
total cost; when the pool is saturated it changes nothing about throughput. The
only real saving would be ~28s of per-shard fixed overhead, at 2× the wall
clock.

**"`pretest` runs `test:scale-contract` on all four shards — three of those are
waste."** True, and irrelevant: measured at **0.36s**. Left alone.

**"`scale-postgres-contract` should not run on every PR."** Left alone at the
time — `docs/SCALE-PERFORMANCE-HARNESS.md` documents the every-PR execution as a
deliberate design ("the skip is therefore never the only report"), and the job
costs ~80s.

> **REVERSED 2026-08-18.** The job moved to `.github/workflows/postsubmit.yml`,
> together with `frontend-perf`. Two things changed since the paragraph above was
> written. First, evidence: over the last 40 `ci.yml` runs `scale-postgres-contract`
> was **37 success, 0 failure** and `frontend-perf` **37 success, 0 failure** —
> together ~180 runner-seconds spent on every PR to restate an unchanged result,
> against the 20-slot ceiling that is the whole subject of this document. Second,
> the harness doc's actual requirement is *one* execution per change, not a
> *pre-merge* one ("running it twice buys nothing"); a postsubmit run on `main`
> still gives exactly one, on the genuinely merged tree rather than a speculative
> merge ref. What is given up is that the evidence now arrives after merge instead
> of before — accepted for a job with no failures on the record, and reversible:
> if it fails on `main`, move it back.
>
> **RE-REVERSED for `frontend-perf` on 2026-08-21 (#2591). `scale-postgres-contract`
> stays.** The reversibility clause above was not decoration — it was cashed three
> days later. `frontend-perf` failed **18 consecutive** postsubmit runs (first
> `32390289786`, head `80f4f9756` = the merge commit of #2568; last `32405172079`)
> and blocked nothing, because postsubmit triggers only on push to `main`.
>
> **The lesson is about the EVIDENCE, not the decision.** "37 success, 0 failure"
> measures how often a gate FIRED, never what it GUARDS. `frontend-perf` owned the
> ONLY typecheck of `frontend/perf-lab/` — `perf-lab/tsconfig.json` extends
> `../tsconfig.app.json` and narrows `types`, while `frontend/tsconfig.json`
> references only `tsconfig.app.json` + `tsconfig.node.json`, so `tsc -b` cannot
> reach it — and forty greens therefore meant "nobody has broken it yet", not
> "nothing can break it". Proven on PR #2592, a deliberate re-break: the required
> `frontend-typecheck` passed and `frontend-perf` failed **on the same tree**.
>
> Before moving any job here, ask what would be UNGUARDED if it never ran again.
> If the answer is "an input nothing else checks", a pass count is the wrong
> evidence. `scale-postgres-contract` survives that question — the scale fixture
> is not the only thing exercising the pg schema.
>
> It cost +0s of wall clock to bring back. Measured on `32407322884` and
> `32407903048`: the job runs ~92-114s in parallel and finishes 61-65s BEFORE
> `frontend-checks`, which is the frontend critical path. Job-level queue wait
> across the 12 runs before the change: worst 3s, median 2s, at 14-16 jobs — the
> 20-slot ceiling was not binding. It is pinned by
> `frontend/scripts/check-perf-lab-gate.test.mjs`, which fails if the job leaves
> `ci.yml`, leaves the `frontend` roll-up's `needs` or its assertions, or if
> `merge_group` leaves the triggers.
>
> Not everything moved. `backend-postgres` (34 success, **4 failure**, spanning
> several pg test files at once — a broken tree, not a flake) and `file-size`
> (2 real findings) stayed in presubmit. A job earns presubmit by having caught
> something; those two have.

---

## Fixes shipped

| Change | Effect | Ref |
| --- | --- | --- |
| Path filtering in `ci.yml` (`changes` job) + `scale-postgres-contract` and `frontend-perf` moved to `postsubmit.yml` (`frontend-perf` RETURNED to `ci.yml` 2026-08-21, #2591 — see the re-reversal note above) | Frees ~180 runner-seconds on **every** PR unconditionally. On top of that, replaying the classifier over the last 60 merged PRs: 21 skip the frontend half, 3 skip the backend half, 2 skip both — **26 of 60 (43%)** save at least one half, against the 20-slot ceiling. (A naive path-prefix count claims 58%; it miscounts PRs that also touch a root file or `scripts/`, which correctly run both. 43% is what the rule delivers.) | #2412 |
| `tests/setup.ts` applies a pre-collapsed schema snapshot instead of replaying 147 migrations per file | Suite total ~10% faster; the `tests` phase itself 7.6s → 1.1s per 20 files | #2131 |
| `PRAGMA foreign_keys = ON` when building that snapshot | **Correctness, not speed** — see below | #2131 |
| `npm run audit:test-schema` wired into `backend-typecheck` | A migration merged without regenerating the snapshot now fails CI instead of silently giving the suite a schema production does not have | #2131 |
| `tests/schemaSnapshotParity.test.ts` | Proves snapshot ≡ replay inside the real D1: DDL, seeded rows, and the Phase-1 soak row | #2131 |
| 221 of 265 backend test files moved off the Workers pool onto a plain node runner | Suite 565s → 106s; slowest CI shard 380s → 141s; `backend-tests` 4 shards → 2 | #2131 |
| `frontend` split into `frontend-checks` / `frontend-build` / `frontend-perf` with a roll-up, plus a Playwright browser cache | The gate 285s → **150s**; whole CI critical path now ~150s | #2142 |
| `BUG-HISTORY.md merge=union` in `.gitattributes` | The append-at-top ledger stops being a merge conflict — **for local merges only**, see the caveat above | #2133 |
| `test:scale-contract` invoked by name in `backend-typecheck`, and its two stale assertions corrected | Restores 100 checks that #2131 silently stopped running; a new assertion fails if CI is ever rerouted around it again | #2146 |
| The light/workers split computed at config time instead of from a committed list | Removes a per-PR regeneration tax #2131 had introduced; two PRs had already gone red on it | #2150 |

### The near-miss the parity test caught

The snapshot generator was first written with `PRAGMA foreign_keys = OFF`,
reasoning that ordering should not matter for a rebuild. It does:
`079_clean_sales_team_demo.sql` deletes from `sales_reps` and documents in its
own comments that it is *relying on* `ON DELETE CASCADE` to clear
`sales_rep_brands` and `sales_team_activity`. With enforcement off there is no
cascade, and the generated seed carried 24 tables / 315 rows instead of
**22 tables / 225 rows** — 90 orphans in a shape production cannot hold.

**To be precise about blame: this was never in the repo.** The old per-file
replay ran against D1, which enforces foreign keys, so the cascade fired and the
test database was correct. The defect existed only in the new generator, for
about twenty minutes, and `tests/schemaSnapshotParity.test.ts` refused to let it
merge. That is the entire argument for building the equivalence proof before
trusting the artifact, rather than shipping the artifact and watching for
fallout.

### One measured effect we have not fully explained

The `tests` phase — not setup — is consistently ~6.5x faster on the snapshot
path (7.6s vs 1.1s over the same 20 files, reproduced twice, 282/282 passing
both ways). It is not the orphan rows: the parity test proves both databases end
in the same state, so the same rows are present either way.

The most likely explanation is that a database assembled by 1020 statements —
including drops, alters, and hundreds of swallowed failures — is physically
more fragmented than one built by a single `exec()`, leaving the query planner
worse off. That is a hypothesis, not a traced root cause, and it is recorded
here as such so nobody later cites it as established.

---

## Deferred

| Item | Why deferred | Owner |
| --- | --- | --- |
| ~~**`frontend` is now the slowest job (~285s) and gates every PR**~~ — **CLOSED by #2142, 2026-08-13** | It was deferred as "untouched by this work, both plausible, neither measured". It was then measured and split: `frontend` on `main` is now a ROLL-UP over `frontend-checks` / `frontend-build` / `frontend-perf`, with the Playwright browser cached. See the Fixes table above. | — |
| **Restore an emergency bypass on the `main-protection` ruleset** | `CLAUDE.md` claimed repository admin was on the bypass list; checked 2026-08-13, `bypass_actors` is `null` and `current_user_can_bypass` is `"never"`. Harmless today, but a merge queue that jams with no bypass blocks `main` for everyone. Requires `hello-houzs` admin | owner |
| ~~Enable the merge queue~~ — **NOT POSSIBLE on this repo, see below** | `hello-houzs` is a **User** account, and GitHub's merge queue is organization-only. The ruleset page simply does not offer the option | — |
| Reduce the number of simultaneously open PRs | The load generator behind cause 1. Process, not code | owner |
| Nearly every workflow file is a one-off `workflow_dispatch` data script (289 of 300 carry `secrets.DATABASE_URL`, re-counted 2026-08-14; this row said "286 of 296") | No runner cost, but the Actions tab and every `gh` query are unusable | owner |

---

## The fix for cause 3: run the light tests on a light runner

Cause 3 was framed above as "277 serial workerd boots", and the obvious levers
were all bad ones — raise concurrency (documented collapse), add shards (costs
the slots cause 2 is already short of), or consolidate 278 files by hand.

The actual question turned out to be different: **how many of those files needed
workerd at all?**

Of 265 files in the pool, **44** reference `cloudflare:test` or a D1 binding.
The other **221 were pure logic**, booting a Workers runtime and an isolated
database they never touched. Run on a plain node runner, unchanged, those 221
files complete in **6.09s** — against roughly 390s of workerd startup for the
same set.

| | before | after |
| --- | --- | --- |
| light suite (221 files, 3433 tests) | inside the pool | **6.9s**, plain node |
| workers suite (44 files, 379 tests) | — | 99.3s |
| **total** | **565.4s** | **106.2s** (5.3x) |
| slowest CI shard | ~380s | **56s** |
| `backend-tests` shards | 4 | 2 |

Test counts reconcile exactly: 3433 + 379 + 24 (the Postgres suite, which
`test:pg` owns) = **3836**, the same number the single-project run reported.
Nothing was dropped. The 13 `tests-pg/` and `tests-node/` files were
additionally being run *inside workerd* by the old config's default glob, on top
of their own `test:pg` run; they now execute only where they belong.

The split is computed from the source tree at config time by
`backend/scripts/lib/classify-tests.mjs`, which both vitest configs call.

**It was not built that way, and the first attempt is the more useful story.**
It shipped in #2131 as a generated JSON file with an `audit:test-projects`
gate, following this repo's `gen:`/`audit:` convention. Within the same day
#1898 and #2058 both went red on *"Test project split is stale"* — for adding a
backend test file. Every PR touching backend tests would have paid that tax
forever.

The convention was followed correctly and applied to the wrong kind of fact.
`gen:`/`audit:` earns its keep where a human authors something that could be
wrong and re-deriving it is expensive: the schema snapshot (baseline + 147
migrations), the route capability matrix. This split is a **pure function of
the tree** — does the file mention `cloudflare:test` or a D1 binding — so a
committed copy can never be *more* correct than computing it, only less, and
the gate existed solely to detect that it had become so.

#2150 deleted the generator, the committed JSON, both npm scripts and the CI
step. The staleness they guarded against is no longer representable.

**Before adopting a convention, ask what it is defending against.**

> Current size of the split, for scale rather than as a fact to maintain —
> re-run `classifyTests()` rather than trusting this line: **light 236 /
> workers 44** on 2026-08-14.

### What this replaced, and why `fileParallelism` was not the answer

Raising pool concurrency was measured first (same 20 files, all green locally):
`maxWorkers: 1` 45.6s · `maxWorkers: 2` 29.8s · `maxWorkers: 4` 24.2s. Tempting,
and wrong to ship: `vitest.config.mts` documents a CI-only collapse ("50-65 of
66 files failing, ZERO AssertionErrors, 100+ `Timeout calling onTaskUpdate`"),
and a local pass on a many-core machine says nothing about a two-core runner
under contention. The split beats it anyway — 5.3x versus 1.9x — and carries no
concurrency risk at all, because the 221 files that moved never touch the pool
that collapses. `fileParallelism: false` stays exactly as it was.

Also measured and recorded so it is not re-investigated: the four test bindings
total ~320 KB shipped into every isolated worker, and shrinking the largest
(`TEST_MIGRATIONS`, 201 KB) bought ~8% of setup. Not pursued — the split makes
it irrelevant for 221 of the files and marginal for the remaining 44.

---

## Confirmed on real runners, and where the bottleneck moved

#2131 merged 2026-08-13. Job times from the merge run, against the ~380s
per-shard the same job cost before:

| job | before | after |
| --- | --- | --- |
| `backend-tests (1)` | ~380s | **141s** |
| `backend-tests (2)` | ~380s | **127s** |
| `backend-typecheck` | ~55s | 92s (it now also runs the light suite — 234 files at the time of this run; 236 as of 2026-08-14, and the split is derived at config time by `classifyTests()`, so run that rather than trusting this cell) |
| `scale-postgres-contract` | ~80s | 70s |
| `backend-postgres` | ~60s | 38s |
| `e2e-contract` | ~18s | 17s |
| **`frontend`** | ~285s | **~285s — untouched by #2131** |

**As of #2131 the critical path was `frontend`, and nothing in THAT PR touched
it.** A CI run finishes when its slowest job finishes; that used to be
`backend-tests` at ~380s and it became `frontend` at ~285s.

> **Superseded 2026-08-13 by #2142, which is why this section no longer ends the
> story.** `frontend` was then split three ways and the Playwright browser
> cached; on `origin/main` today `frontend` is a ROLL-UP job over
> `frontend-checks`, `frontend-build` and `frontend-perf` (`ci.yml`). That
> membership went out and came back: `frontend-perf` moved to `postsubmit.yml` on
> 2026-08-18 and RETURNED on 2026-08-21 (#2591), so the roll-up covers
> `frontend-checks`, `frontend-typecheck`, `frontend-build` and `frontend-perf`
> again, plus `lint`. **Read the membership from `ci.yml`, not from here** — a job
> absent from the roll-up's `needs` is advisory no matter what any doc says, which
> is exactly the failure #2591 fixed. Not the one
> serial block described below. The paragraph is kept because the ANALYSIS below
> is what identified the two candidates that #2142 acted on — read it as the
> diagnosis, not as the current shape of the job.

That job does, in one serial block: `npm ci`, `check:test-focus`, `typecheck`,
`test`, two `node --test` gate scripts, `build`, **a second full `vite build` of
the merge base** for the bundle baseline, `check:sw`, `test:smoke-script`,
`typecheck:perf-local`, a Playwright Chromium download, and `test:perf-local`.
The merge-base rebuild and the browser download are the two obvious candidates
and neither has been measured — measure before touching, per `CLAUDE.md`.

## The merge queue is not available here, and what to do instead

Cause 1 — 35 open PRs against `strict_required_status_checks_policy`, giving
~4.7 CI runs per PR — has an obvious textbook fix, and `ci.yml` has carried the
`merge_group` trigger for it since before this work started. It cannot be used:

```
gh api users/hello-houzs --jq '.type'   ->  "User"
```

**GitHub's merge queue is organization-only.** `hello-houzs` is a personal
account, so the "Require merge queue" checkbox never appears on the ruleset
page no matter what else is configured. *(True as written on 2026-08-14; the
repo has since moved to an organization — see the resolution note below.)* This was found the slow way — by
recommending it, watching the owner look for a checkbox that does not exist,
and only then checking the account type. Check `owner.type` before proposing
anything org-scoped.

> **RESOLVED 2026-08-18. The repo moved, and the queue is on.**
> `hello-houzs/Houzs-ERP` -> **`Houzs-Century/Houzs-ERP`**, by TRANSFER, not by
> converting the account. That distinction is the point: converting a user into
> an organization is irreversible, kills the ability to sign in as that user,
> uninstalls its GitHub Apps, and **disables Actions until someone re-enables
> them**. Transferring a repository keeps secrets, webhooks, deploy keys, issues,
> PRs, stars and watchers — verified after the move: the `main-protection`
> ruleset survived intact with the same two required contexts, all 10 Actions
> secrets came across, and CI ran on the new owner within three minutes.
>
> The queue is configured `merge_method: SQUASH`, `max_entries_to_build: 3`,
> `grouping_strategy: HEADGREEN` (only the head commit of a group must be green,
> which is the cheap setting and the right one against a slot ceiling), and
> `check_response_timeout_minutes: 30`.
>
> **Measured on the first real queued merge (#2409):** entered the queue and its
> CI started at 07:03:50, CI finished 07:07:22, merged 07:07:40. **212s of CI,
> 18s of queue overhead, 230s total.** The `min_entries_to_merge_wait_minutes: 5`
> setting does NOT add five minutes to a lone PR — a single entry already meets
> `min_entries_to_merge: 1`, so nothing waits for a group to fill. That was an
> open question when the queue was switched on and it was settled by measurement,
> not by reading the docs, which do not say.
>
> One trap did NOT bite, because `ci.yml` had carried the `merge_group` trigger
> since before any of this: **a required check whose workflow does not run on
> `merge_group` leaves every queued PR hanging forever.** Both required contexts
> (`backend-typecheck`, `frontend`) live in `ci.yml`, so both fire in the queue.
> Verify that before enabling a queue anywhere else.

The `merge_group` work already merged was not wasted: the trigger and the
`scale-postgres-contract` gate were correct, and went live the moment the repo
moved. The options weighed at the time, kept for the reasoning:

| option | effect | cost |
| --- | --- | --- |
| **Reduce the open-PR count** (chosen) | 35 → ~10 cuts the re-run storm ~3.5x | none; it is triage, not infrastructure |
| Transfer the repo to an organization | unlocks the queue, plus org secrets and teams | a real migration; collaborators and integrations need re-setting |
| Turn OFF `strict_required_status_checks_policy` | removes the O(n²) entirely | removes the guard added after three migration-collision incidents. Would need the duplicate-migration check moved to a pre-deploy gate first |

## The hidden cost of the BUG-HISTORY rule, and the one-line fix

Draining the backlog surfaced something nobody had measured. Of the first five
pull requests that turned `DIRTY` after an unrelated merge landed:

| PR | conflicting file |
| --- | --- |
| #2043 | `BUG-HISTORY.md` |
| #1914 | `BUG-HISTORY.md` |
| #1867 | `BUG-HISTORY.md` |
| #2037 | `docs/modules/autocount-writeback.md` |

> The table lists FOUR of the five, so the ratio below cannot be re-derived from
> it. The fifth PR — the one whose conflict was in code, and therefore the whole
> point of the comparison — was never written down. Noted 2026-08-14 rather than
> invented: the claim is plausible and unverifiable as published.

**Four out of five, and not one line of code.** `BUG-HISTORY.md` is
append-at-the-top and mandatory, so with N branches open, every one of them
edits the same first line of the same file. Merge any one and the other N-1
conflict — on a file where both sides are always wanted.

The rule is right and should not change; the mechanics were wrong.
`.gitattributes` now carries:

```
BUG-HISTORY.md merge=union
```

`union` is a built-in git merge driver that keeps both sides of a conflicting
hunk instead of stopping. For a newest-first ledger where each branch prepends
its own block, that is the correct resolution every time — it is precisely what
was being done by hand. Scoped to this one file: two branches revising the same
*existing* entry would get both copies, which is wrong for `docs/modules/*.md`
and anything else edited in place.

Resolving one of these by hand also demonstrated the treadmill: the fix was
pushed, and `main` had moved again before GitHub finished recomputing. Manual
resolution does not converge while the base branch is live.

### The half of this that does NOT work — read before relying on it

**GitHub's server side does not honour `.gitattributes merge=union`.** Tested
2026-08-13 on #1905, whose only conflict was `BUG-HISTORY.md`:

```
$ git merge origin/main          # local, in a worktree
   0 unresolved files            # union applied, clean

$ gh pr update-branch 1905
   X Cannot update PR branch due to conflicts
```

Same two commits, opposite answers. The attribute is applied by the git that
performs the merge, and the "Update branch" button is GitHub's git, which reads
its own configuration and not the repository's.

So the fix is real but its reach is narrower than it looks:

| how the branch is updated | union applies |
| --- | --- |
| `git merge origin/main` locally, then push | **yes** |
| GitHub's *Update branch* button / `gh pr update-branch` | **no** |

**The practical consequence:** when a PR is behind and its only conflict is
`BUG-HISTORY.md`, do not press *Update branch* — it will refuse. Merge `main`
into the branch locally and push. The union driver resolves the ledger on the
way through and the push lands a branch GitHub then sees as clean.

This was initially reported here as working server-side, on the strength of a
local `git merge-tree` returning no conflict. That was local git applying the
attribute, being mistaken for GitHub's behaviour — the same shape of error as
the `391ms` and merge-queue mistakes recorded above: a local observation read as
a platform guarantee.

## The fix that switched off its own alarm

The worst thing found all day was caused by the work itself, and it was found by
accident.

`test:scale-contract` — 100 checks across 7 files — is wired as `pretest` in
`backend/package.json`. **npm fires `pretest` for `npm test` and nothing else.**
#2131 split the backend suite and pointed CI at `test:light` and `test:workers`.
Neither is `npm test`, so the whole guard suite stopped running in backend CI —
silently, because a suite that does not run reports nothing and every check
stays green.

Two of its checks had been failing the entire time, against changes made in the
same PR that silenced them:

| check | why it broke | was the invariant actually broken? |
| --- | --- | --- |
| `scale-postgres-contract` runs on `pull_request` | the condition became a folded multi-line `if: >-` (it now also fires on `merge_group`), so the single-line regex stopped matching | **no** — the gate got stronger; the assertion pinned YAML layout instead of the rule |
| the backend test script stays a single command | `test` became a two-command chain and sharding moved to `test:workers` | **no** — npm appends `--shard` to the LAST command, and `test:workers` is `vitest run`, still single |

Neither was a real weakening. That is not the point: **nobody could have known
either way, because the thing that would have asked was the thing that stopped
running.** It surfaced only because an unrelated `package.json` conflict on
#1907 was resolved by hand and the script happened to be run manually.

Fixed in #2146: the suite is invoked by name in `backend-typecheck`, the two
assertions now match the invariant rather than the formatting, and a **new**
assertion fails if the workflow ever stops calling this suite by name.

> **The `scale-postgres-contract` assertion broke a THIRD time, on 2026-08-18
> (#2412), and that is the useful part of this entry.** #2146 rewrote it to
> "match the invariant rather than the formatting" — but the invariant it then
> pinned was still *runs on `pull_request` in `ci.yml`*, which is a LOCATION.
> When the job moved to `postsubmit.yml` the assertion failed again, on a change
> that took nothing away from the evidence.
>
> The property it actually exists to protect is: the 100k run **executes once
> per change, in a workflow that really triggers, and its report is retained**.
> It now finds whichever workflow defines the job, asserts exactly one does, and
> accepts `pull_request` or `push`. Moving the job again will not break it;
> deleting it, duplicating it, or hiding it behind `workflow_dispatch` will.
>
> Twice is a coincidence, three times is a pattern: each rewrite pinned one
> layer further out — YAML layout, then the event name, then the file. The guard
> was verified RED against all three violations before being trusted, not merely
> observed green.

## Lessons

1. **Time the thing before optimising it.** The migration replay looked
   catastrophic — 283,000 round-trips is a number that sells itself — and it was
   391ms. One probe would have saved a day; it was run late instead of first.
   The same discipline `docs/system-foundation-coe.md` records for schema claims
   ("verify against the live DB, not migration files") applies to performance:
   *verify against a stopwatch, not against an arithmetic estimate.*

2. **A `PRAGMA` is a semantic, not a setting.** Turning foreign keys off to make
   a rebuild "simpler" silently changed which rows existed, because a migration
   was using cascade as its delete mechanism. Any tool that rebuilds the
   database must match production's enforcement exactly.

3. **`strict` without a merge queue does not scale past a handful of PRs.** The
   rule is right; the missing half of the pair is what made it quadratic.

4. **The generated snapshot has TWO inputs, and the forgettable one is the
   baseline.** Within an hour of opening #2131 its own gate turned red, and the
   cause was not a migration: #2106 edited `src/db/schema.sql`. Both feed
   `gen:test-schema`, but "regenerate after adding a migration" is the sentence
   everyone remembers, so the audit's own error message said exactly that and
   pointed the reader at the wrong directory. Fixed to name both. A gate that
   fires correctly and explains incorrectly still costs the next person the
   afternoon.

5. **Fixing the slowest job just promotes the second-slowest.** `backend-tests`
   went 380s → 141s and the run did not get 240s faster for the author, because
   `frontend` was already sitting at ~285s behind it. Always re-read the whole
   job table after a win; the number that matters is the max, not the one that
   moved.

6. **Check the platform can do the thing before recommending it.** The merge
   queue was proposed, prepared for, and written into this document twice
   before anyone ran `gh api users/hello-houzs --jq '.type'` and got `"User"`.
   One call, available from the first minute, would have replaced a whole
   strand of the plan. Capability questions are cheap to answer and expensive
   to assume.

7. **"No output" is not "no difference".** While triaging PRs for closure,
   `git diff origin/main origin/<branch>` printed nothing and was read as "this
   branch is already merged". The ref had simply never been fetched. #2029 was
   one step from being closed while still holding an unlanded 45 KB change.
   Verify the input exists before believing the empty result — the repo's
   standing rule that exit code 0 is not success, in a new costume.

8. **A check that stops running is worse than a check that fails.** Rerouting
   CI away from `npm test` took 100 assertions offline without a single red
   mark, and two of them were already failing. Any suite reached only through a
   lifecycle hook (`pretest`, `prepare`, `pre-commit`) is one refactor away from
   silence — invoke it by name, and assert that the workflow does.

9. **Every mistake here had the same shape.** Four times in one session, "how it
   has always worked" was used as "how it works now": the migration replay was
   assumed to be the bottleneck (391ms), the merge queue was assumed available
   (organization-only), `merge=union` was assumed to apply server-side (it does
   not), and `pretest` was assumed to still fire (it does not). Every one cost
   less than a minute to check and none of them were checked first.

10. **A convention is an answer; check it matches the question.** The
    `gen:`/`audit:` pattern is right for facts a human authors and that are
    expensive to re-derive. Applied to a pure function of the source tree it
    produced a gate whose only job was to notice a copy had gone stale — and
    two innocent PRs paid for it before it was removed. Following the house
    style is not the same as understanding what the house style defends.

11. **A sizing comment is a fact with an expiry date.** `ci.yml` still explains
   the shard count against "112 files" and a "334s" suite. Both are long stale
   (277 files; a single shard now runs ~380s), and every later decision that
   trusted those numbers inherited the error. Sizing comments must be
   regenerated or dated — see the new rule in `CLAUDE.md`.
