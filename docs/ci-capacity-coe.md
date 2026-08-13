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
| **Turn on `fileParallelism` — the single largest lever, measured below** | Local runs pass at every setting tried; the documented collapse was seen *in CI*, under runner contention this machine cannot reproduce. Needs one trial PR, not a local verdict | owner |
| Enable the merge queue | The `merge_group` trigger and the `scale-postgres-contract` gate are now both ready (this PR). What remains is the decision and the flaky-test exposure — a queue is serial, so one flaky failure re-runs everything behind it | owner |
| Reduce the test-file count by consolidation | 278 files × ~1.8s of fixed per-file cost. Halving the file count halves it, with no concurrency risk at all — but it is a large mechanical refactor | owner |

### The parallelism measurement, so the decision is not re-derived

Same 20 files (`--shard=1/14`), same machine, full pass each time:

| setting | wall clock | result |
| --- | --- | --- |
| `fileParallelism: false, maxWorkers: 1` (current) | 45.6s | 282 passed |
| `fileParallelism: true, maxWorkers: 2` | **29.8s** (−35%) | 282 passed |
| `fileParallelism: true, maxWorkers: 4` | **24.2s** (−47%) | 282 passed |

The full suite is `565s, of which setup is 490s and the tests themselves are
10.9s`. Setup is 87% of the run and it is per-file startup, so this is where the
remaining time is. Two smaller findings from the same session, recorded so they
are not re-investigated: shrinking the `TEST_MIGRATIONS` binding (201 KB, sent
into every isolated worker) bought ~8% of setup, and the four bindings together
are ~320 KB per file.

**Do not read the table above as permission.** `vitest.config.mts` documents a
CI-only collapse — "50-65 of 66 files failing, ZERO AssertionErrors, 100+
`Timeout calling onTaskUpdate`" — and a local pass on a many-core machine is not
evidence about a two-core runner under contention. The way to settle it is one
PR at `maxWorkers: 2` (the most conservative step, already worth 35%), watched
in CI.
| Reduce the number of simultaneously open PRs | The load generator behind cause 1. Process, not code | owner |
| 286 of the repo's 296 workflow files are one-off `workflow_dispatch` data scripts | No runner cost, but the Actions tab and every `gh` query are unusable | owner |

---

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

4. **A sizing comment is a fact with an expiry date.** `ci.yml` still explains
   the shard count against "112 files" and a "334s" suite. Both are long stale
   (277 files; a single shard now runs ~380s), and every later decision that
   trusted those numbers inherited the error. Sizing comments must be
   regenerated or dated — see the new rule in `CLAUDE.md`.
