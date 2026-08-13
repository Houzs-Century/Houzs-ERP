# COE — CI capacity: the queue that ate the working day

**Date** 2026-08-13 · **Severity** P2 (no production impact; sustained loss of
delivery throughput) · **Status** partially fixed, see Deferred

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

**"`scale-postgres-contract` should not run on every PR."** Left alone —
`docs/SCALE-PERFORMANCE-HARNESS.md` documents the every-PR execution as a
deliberate design ("the skip is therefore never the only report"), and the job
costs ~80s.

---

## Fixes shipped

| Change | Effect | Ref |
| --- | --- | --- |
| `tests/setup.ts` applies a pre-collapsed schema snapshot instead of replaying 147 migrations per file | Suite total ~10% faster; the `tests` phase itself 7.6s → 1.1s per 20 files | this PR |
| `PRAGMA foreign_keys = ON` when building that snapshot | **Correctness, not speed** — see below | this PR |
| `npm run audit:test-schema` wired into `backend-typecheck` | A migration merged without regenerating the snapshot now fails CI instead of silently giving the suite a schema production does not have | this PR |
| `tests/schemaSnapshotParity.test.ts` | Proves snapshot ≡ replay inside the real D1: DDL, seeded rows, and the Phase-1 soak row | this PR |

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
| **`frontend` is now the slowest job (~285s) and gates every PR** | Untouched by this work. It runs a SECOND full `vite build` of the merge base for the bundle baseline, and downloads Playwright Chromium, inside one serial job. Both plausible, neither measured | owner |
| **Restore an emergency bypass on the `main-protection` ruleset** | `CLAUDE.md` claimed repository admin was on the bypass list; checked 2026-08-13, `bypass_actors` is `null` and `current_user_can_bypass` is `"never"`. Harmless today, but a merge queue that jams with no bypass blocks `main` for everyone. Requires `hello-houzs` admin | owner |
| ~~Enable the merge queue~~ — **NOT POSSIBLE on this repo, see below** | `hello-houzs` is a **User** account, and GitHub's merge queue is organization-only. The ruleset page simply does not offer the option | — |
| Reduce the number of simultaneously open PRs | The load generator behind cause 1. Process, not code | owner |
| 286 of the repo's 296 workflow files are one-off `workflow_dispatch` data scripts | No runner cost, but the Actions tab and every `gh` query are unusable | owner |

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

The split is generated by `npm run gen:test-projects` and gated by
`npm run audit:test-projects`, because a hand-maintained list rots invisibly —
a new test lands in whichever project someone guessed, and the only symptom is
the suite slowly getting slow again.

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
| Reduce the number of simultaneously open PRs | The load generator behind cause 1. Process, not code | owner |
| 286 of the repo's 296 workflow files are one-off `workflow_dispatch` data scripts | No runner cost, but the Actions tab and every `gh` query are unusable | owner |

---

## Confirmed on real runners, and where the bottleneck moved

#2131 merged 2026-08-13. Job times from the merge run, against the ~380s
per-shard the same job cost before:

| job | before | after |
| --- | --- | --- |
| `backend-tests (1)` | ~380s | **141s** |
| `backend-tests (2)` | ~380s | **127s** |
| `backend-typecheck` | ~55s | 92s (it now also runs the 234-file light suite) |
| `scale-postgres-contract` | ~80s | 70s |
| `backend-postgres` | ~60s | 38s |
| `e2e-contract` | ~18s | 17s |
| **`frontend`** | ~285s | **~285s — untouched** |

**The critical path is now `frontend`, and nothing in this work touched it.**
A CI run finishes when its slowest job finishes; that used to be
`backend-tests` at ~380s and it is now `frontend` at ~285s. Further backend
work buys the PR author almost nothing from here.

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
page no matter what else is configured. This was found the slow way — by
recommending it, watching the owner look for a checkbox that does not exist,
and only then checking the account type. Check `owner.type` before proposing
anything org-scoped.

The `merge_group` work already merged is not wasted: the trigger and the
`scale-postgres-contract` gate are correct, and they become live the moment the
repo moves under an organization. Until then:

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

8. **A sizing comment is a fact with an expiry date.** `ci.yml` still explains
   the shard count against "112 files" and a "334s" suite. Both are long stale
   (277 files; a single shard now runs ~380s), and every later decision that
   trusted those numbers inherited the error. Sizing comments must be
   regenerated or dated — see the new rule in `CLAUDE.md`.
