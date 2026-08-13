# Houzs ERP — Working agreement

This file is loaded into every Claude session. It tells you what's
non-obvious about this codebase and how the user wants to collaborate.

## ⚠️ Log every bug in `BUG-HISTORY.md` — MANDATORY (owner rule, everyone)

Every bug you find and fix **must** get an entry in [`BUG-HISTORY.md`](./BUG-HISTORY.md) at the repo root — no exceptions. One short entry: **Symptom → Root cause (traced, not guessed) → Fix → Ref (PR/date)**, newest first, with a severity tag. This is how we stop re-introducing the same class of bug: **read it before touching a subsystem, and add to it in the same PR that fixes the bug.** This applies to every contributor and every agent/session.

## ⚠️ Read the module guide before you work in a module — MANDATORY (owner rule)

`docs/modules/<module>.md` exists so you do NOT have to read the whole system to
change one part of it. **Read the guide for the module you are touching, before you
touch it.** If your change alters that module's SURFACE — a new endpoint, a new
permission, a new status, a field that starts or stops being required, a new
lock — **update the guide in the same PR.** A guide nobody updates becomes the next
thing that lies to us.

If a module has no guide yet, that is the gap to close, not a licence to explore:
write the guide as you learn the module, following the shape of
`docs/modules/sales-order.md`.

## ⚠️ A serious incident gets a COE — MANDATORY (owner rule)

**COE = Correction of Error** (the industry term, AWS's). `BUG-HISTORY.md` is the
per-bug ledger; a COE is for the bigger class: an outage, data at risk, a fault that
recurred, or anything that made the system feel unreliable to staff. Write
`docs/<subject>-coe.md`, following the ones already written — `ls docs/*-coe.md`,
and read `docs/system-foundation-coe.md` for the canonical shape:

**Date · Trigger** (what staff actually saw, in their words) · **Root cause, traced
with evidence, never guessed** — name the tool that proved it (`wrangler tail`, a
live DB query) · **Fixes shipped**, one row per PR with its effect · **What the
audit RULED OUT** — the suspicions that turned out false, and how they were refuted
· **Deferred**, with the decision owner · **Lessons.**

The ruled-out section is not padding: it is what stops the next person re-chasing a
theory we already disproved. One real example from `system-foundation-coe.md` —
money corruption was suspected from reading a migration file, then refuted against
the live database. The lesson recorded there ("verify schema claims against the live
DB, not migration files") is worth more than the fix was.

## ⚠️ The bug ledger, the module guide and migrations are CHECKED on every PR

`.github/workflows/working-agreement.yml` runs
`scripts/check-working-agreement.mjs` and holds a PR to the two MANDATORY rules
directly above — the `BUG-HISTORY.md` entry and the module-guide update — plus
the migration discipline described under *Migrations* below. Before it existed
they lived only in prose: on 2026-08-13 ten hand-written PRs shipped that read
as fixes and changed code, not one added a `BUG-HISTORY.md` entry, and nothing
said a word. (The COE rule is not checked: an incident is a judgement call, not
a diff shape.)

| It fails when | It wants |
|---|---|
| the title, the branch name, or a body HEADING reads as a fix, code changed, and `BUG-HISTORY.md` gained no new `## ` entry | the entry, in this PR |
| a changed file under `backend/src` / `frontend/src` adds a route, a permission string, a status value, a required-field flip or a lock, and the module guide that quotes that file is untouched | the guide update, in this PR |
| `backend/src/db/migrations-pg/` changed and the body does not carry a `Reversal:` line and a `Verified against:` line | both lines, filled in |

The escapes are LABELS — `no-bug-history-needed`, `no-guide-change` — and they
are not silence: the check prints the violation it waived, so the exception
lands in the log. Rule 3 has no label; two lines in the body is the whole cost.

Where NO guide covers a file whose surface moved, the check WARNS and names the
guide that should exist. It does not fail you for a gap you did not open — but
that gap is the one CLAUDE.md asks you to close.

**This file stays THIN on purpose.** It carries rules and traps, not an
inventory. Facts that change with every merge — route counts, file sizes,
module lists — belong in the map below, because a stale fact HERE is worse
than no fact: this file is auto-loaded, so every session believes it. It
described the database as "D1 SQLite" for over a month after the Postgres
cutover, and pointed at a migration directory that production does not read.

## ⚠️ A number in a comment is a fact with an expiry date — MANDATORY (owner rule)

If you write a measurement into a comment, a doc, or a commit message — a file
count, a duration, a row count, a "we chose N because" sizing argument — you own
keeping it true, or you make it self-checking. A stale number is worse than no
number: the next person does arithmetic on it and inherits your error without
ever knowing they trusted anything.

This rule was bought at full price. `ci.yml` explains its 4-way test shard with
a worked calculation over "112 files" and a "334s" suite. By 2026-08-13 the
suite was **277 files** and one shard alone ran **~380s**. Every later decision
that reasoned from that comment — including the first plan written to fix the CI
slowdown — was wrong in the same direction. See `docs/ci-capacity-coe.md`.

So: prefer a generated artifact with an `audit:` gate over a hand-written
number (`npm run audit:test-schema`, `audit:map`, `audit:routes` are the shape
to copy). If it must be prose, date it inline — "as of 2026-08-13, 277 files" —
so the reader can see how much to trust it.

## ⚠️ Measure before you optimise, and put the stopwatch in the PR — MANDATORY (owner rule)

Never ship a performance change justified by arithmetic alone. Run the probe,
paste the before/after, and name the tool that produced it — same evidential bar
`BUG-HISTORY.md` sets for root causes, and the COE section above sets for
incidents.

The cost of skipping it, from the same incident: `tests/setup.ts` replayed 147
migrations per test file, ~283,000 database round-trips per suite run. It is an
overwhelming-looking number and it was the wrong target — timed inside the pool,
those 1020 statements took **391ms**. The real cost was per-file workerd startup,
which no amount of SQL work would have touched.

Performance work also carries the owner's standing rule that it must not
destabilise: change only what you can show is behaviour-preserving. When a
rebuild or fixture is involved, that means proving equivalence against the real
runtime — see `backend/tests/schemaSnapshotParity.test.ts`, which is what caught
a `PRAGMA foreign_keys` difference that was silently putting 90 impossible rows
into every test database.

## `main` IS protected now — since 2026-07-31

The owner created the `main-protection` **ruleset**. Verify it rather than
trusting this paragraph — `GET /branches/main/protection` still returns 404
because that endpoint only reports CLASSIC protection and this is a ruleset:

```
gh api repos/hello-houzs/Houzs-ERP/rules/branches/main
```

It currently returns FOUR rules: `deletion`, `non_fast_forward`,
`required_status_checks` with contexts `backend-typecheck` + `frontend` and
**`strict_required_status_checks_policy: true`**, and `pull_request`.

That strict flag is *Require branches to be up to date before merging*, and it
is the one that will cost you TIME rather than correctness: on a busy day `main`
moves faster than a large PR can finish CI, so the branch has to be re-merged
and re-run, repeatedly. GitHub auto-merge helps — it fires the moment checks are
green AND the branch is current — but it does **not** resolve conflicts, so a
merge that goes DIRTY still needs a person. Measured 2026-08-13 on a 70-commit
PR: five rounds.

The `pull_request` rule is why a direct push to `main` is refused at all, and it
carries `required_approving_review_count: 0` — a PR is required, an approval is
not.

Checked 2026-08-14, it returns FOUR rule types — `deletion`,
`non_fast_forward`, `required_status_checks` and **`pull_request`** — with
contexts `backend-typecheck` + `frontend` and
**`strict_required_status_checks_policy: true`**. That last flag is *Require
branches to be up to date before merging*, and it is the one that matters.

The `pull_request` rule is the newer one and this paragraph listed only three
until it was re-checked. Its parameters are worth knowing before you plan a
merge: `required_approving_review_count: 0`, `require_code_owner_review: false`,
`require_last_push_approval: false`, `allowed_merge_methods: [squash, rebase,
merge]`. So it forces work through a PR — a direct push to `main` is refused —
but it asks for no approvals, which is why one-person merges still land. Do not
read "0 approvals" as "no PR needed".

**There is NO emergency escape hatch.** This paragraph used to end "Repository
admin is on the bypass list as an emergency escape hatch". Two independent
sweeps landed on the same correction on 2026-08-13:
`gh api repos/hello-houzs/Houzs-ERP/rulesets/20119902` returns
`bypass_actors: null` with `enforcement: active` and `current_user_can_bypass:
"never"`. Nobody can force a merge, including the owner. That is fine while
merges are one-at-a-time, and it is the thing to fix FIRST if a merge queue is
ever switched on — a queue that jams with no bypass blocks `main` for everyone
until someone edits the ruleset itself.

**What this now prevents, which used to be yours to catch by hand.** A PR whose
CI ran against a `main` that has since moved can no longer merge; GitHub makes
you update the branch, which re-runs CI against the real merge base. That closes
the STALE-BRANCH mechanism behind the incidents below:

| incident | how it happened |
|---|---|
| 2026-07-22: `main` red ~20 min | #918 and #925 were each green against a `main` lacking the other |
| 2026-07-22: backend could not deploy | #1039 merged a `0171` colliding with #912's; its CI predated #912 |
| 2026-07-31: backend could not deploy for 2h | #1439 merged a `0230` colliding with #1435's, for exactly the same reason |
| **2026-08-13: backend could not deploy for ~30 min** | **#2121 merged a `0284` colliding with #2106's — and the branch was NOT stale. It had merged `main`. The test RAN and FAILED, and the merge happened anyway.** |

> **CORRECTED 2026-08-14.** This paragraph used to end: *"The duplicate-migration
> test would have caught both collisions — it just never ran against a tree
> containing the other branch. Now it has to."* That is now false, and the
> counter-example is the row added above.
>
> On 2026-08-13 `backend/tests/migrationNumbers.test.ts` did run against the
> right tree and did catch the collision —
> `AssertionError: src/db/migrations-pg: 0284 is taken twice — rename your file
> to 0286_*.sql` — and #2121 merged four minutes into that run anyway. **Branch
> protection does not gate on it.** The required contexts are `backend-typecheck`
> + `frontend` (`gh api repos/hello-houzs/Houzs-ERP/rules/branches/main`);
> `migrationNumbers.test.ts` runs in `backend-tests (2)`, which the section below
> forbids making required, for good reasons that remain good. So this class is
> **structurally ungated**, and `gh pr merge --auto` — armed on 12 PRs in 27
> seconds that morning — merges the moment the two required checks go green,
> which is exactly what happened.
>
> The deploy stayed broken from 13:06Z (#2121 merged) until #2124 landed:
> `Deploy` runs 31703284503 and 31704506807 both concluded `failure` with the
> `backend` job **`skipped`**, so nothing merged in that window reached
> production. Recovered by `0c2a4e88` — renumber to `0286`, plus the return-shape
> fix the same batch missed.
>
> **Two remedies, neither of which is "be careful":**
> 1. Move the duplicate-number assertion into `backend-typecheck` — the job that
>    IS a required context — so a collision blocks the merge instead of only the
>    deploy. **Not done. This is the open item.**
> 2. Never arm `gh pr merge --auto` on a PR carrying a migration or an
>    integration batch. Auto-merge structurally cannot wait for a check that is
>    not required.

**Still yours, because no ruleset checks it:**

1. **Take migration numbers at MERGE time** by re-listing the tree. Being forced
   up-to-date makes a collision *fail loudly* instead of merging, but you still
   have to pick a free number — one branch was renumbered four times in a day
   (`0159 → 0165 → 0167 → 0171`).
2. **Renaming an applied migration no longer double-applies it — but it can
   still fail the deploy closed.** Since #914 (2026-07-22) `pg-migrate` tracks
   filename **and checksum**. A rename whose SQL is byte-identical is detected
   as a rename, the tracker row is REPOINTED to the new name, and the SQL is
   explicitly not re-run (`RENAMED <from> -> <to>` in the deploy log,
   `pg-migrate.mjs:167` and the repoint at `:209`). A rename whose CONTENT also
   changed cannot be proven to be the same migration: it is reported as
   `DRIFT ... probable_renumber` and the runner exits 1, blocking the deploy
   until the tracker row is repointed by hand. So renumber freely; edit an
   applied file's body never.
3. **After merging, confirm the backend job said `success`, not `skipped`.**
   `gh api repos/hello-houzs/Houzs-ERP/actions/runs/<id>/jobs`. Required status
   checks gate the MERGE; nothing gates the deploy that follows. On 2026-07-31
   the backend sat un-deployed for over two hours while `main` was green, and it
   happened again on 2026-08-13 — two `Deploy` runs, both `failure` with
   `backend: skipped`. **Treat `skipped` on `backend` as a failed deploy.**
4. **`frontend` is `npm run typecheck` (`tsc -b`), never `npx tsc --noEmit`.**
   *Added 2026-08-14.* `frontend/tsconfig.json` is `{"files": [], "references":
   [...]}` — a solution-style config with no inputs of its own. In `frontend/`,
   `tsc --noEmit --listFiles` emits **0 files** and exits 0; `tsc -p
   tsconfig.app.json --listFiles` emits 1084. CI was never fooled
   (`.github/workflows/ci.yml:70` runs `npm run typecheck`), but three merged PRs
   on `main` — #2106, #2112, #2117 — carry "`tsc --noEmit` clean" as their
   frontend evidence, and #2122 repeated the claim after the no-op was known.
   The same trap is already in `BUG-HISTORY.md:5562` from 2026-07-31; it produced
   prose instead of a check, so it recurred. **A BUG-HISTORY entry with no test
   attached is unfixed.**
5. **A `workflow_dispatch` workflow is not shipped until it has been dispatched
   once and reported success.** *Added 2026-08-14.* #2120's new AutoCount requeue
   workflow failed on its first dispatch (run 31704539182) reaching for
   `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`, which exist nowhere in this repo
   — it copied `recompute-2990-so-allocation.yml`, a workflow that has never run,
   instead of `recompute-so-allocation.yml`, which works. Precedent was taken by
   name similarity rather than by evidence the precedent runs.

**Do NOT add `backend-tests (N)` or `backend` as required contexts.** The shard
name carries an index that changes with the shard count, and `backend` is a
roll-up that is legitimately `skipped` on frontend-only PRs — a skipped required
check leaves the PR pending forever. This rule stands — but note what it costs:
every assertion living only in a shard is advisory at merge time. If an assertion
must BLOCK a merge, it belongs in `backend-typecheck`, not in a shard.

## ⚠️ Run the audit scripts — they answer questions no doc can

Three dependency-free checks (they run in a fresh worktree with no
`node_modules`). Full story in `docs/one-sided-rules-coe.md`.

**Run them; do not quote a number from this file.** An earlier version of this
paragraph said all three were "at ZERO", and that was wrong — not because the
code changed but because `check-company-scope.mjs` was. It counted a handler as
scoped when a helper NAME appeared anywhere in its body, so
`delivery-orders-mfg PATCH /:id` passed while writing `update(updates).eq('id',
id)` with no predicate, on the strength of an `activeCompanyId(c)` twenty lines
LATER inside an audit field. Two independent readers found that handler while
the script reported zero. It now requires the helper to sit inside a real
`.from(` QUERY, and the honest count went 0 → 20 unscoped writes.

That is the third dead-or-too-loose pattern found in these checkers in one day.
Treat their output as evidence, and this sentence as a pointer to where the
evidence lives.

Each script prints its own corpus size on the first line, so no count is typed
here — an earlier version said "632 SCM handlers" and the checker now reports
1019, which is exactly the drift this file keeps producing.

```
node backend/scripts/check-company-scope.mjs     # SCM handlers: rows touched by id with no company predicate
node frontend/scripts/check-silent-mutations.mjs # useMutation sites: a server refusal that reaches nobody
node backend/scripts/check-shared-mirrors.mjs    # rule modules: frontend copy vs backend original
node backend/scripts/check-docs-drift.mjs        # docs: paths, migration numbers, permission keys, npm scripts
```

**The fourth one exists because THIS FILE lied for a month.** `check-docs-drift`
resolves every mechanically checkable claim the documentation makes — a path, a
`mig NNNN`, a permission key, an `npm run` — against the tree, and `--strict`
gates a PR on the CERTAIN half. It does NOT check behaviour: no script settles
"the confirm gate requires a venue", and that half still needs a reader.

Three markers keep an honest doc green, and each tells the READER the same thing
it tells the checker:

| marker | meaning |
| --- | --- |
| `` `path` [gone] `` | the doc is RECORDING a deletion — most of `BUG-HISTORY.md` is this by construction |
| `` `path` [planned] `` | proposed, not written yet |
| `` `path` [external] `` | lives in the 2990 source repo this SCM tree was vendored from, not here |

Do not add a silent exemption list instead. A suppression the reader cannot see
is a suppression nobody re-checks — which is the whole failure mode here.

## ⚠️ `tsc --noEmit -p tsconfig.json` CHECKS NOTHING on the frontend

`frontend/tsconfig.json` is a **solution file** — `{"files": [], "references": [...]}`.
Pointing `tsc` at it compiles **zero files** and exits **0**. A whole session's
worth of "frontend typecheck green" can mean nothing was ever compiled.

```bash
npm --prefix frontend run typecheck    # tsc -b  — the real gate
```

Add `--force` when you want it to ignore `.tsbuildinfo` and recheck everything.
`backend/tsconfig.json` is a normal config with `include`, so `-p` is fine THERE —
which is exactly why the frontend one slips past: the same command is correct one
directory over. If a typecheck finishes suspiciously fast and silent, verify it
with a deliberate type error and confirm it FAILS before trusting a pass.

**Three traps this repo produced repeatedly. Each is now a rule.**

1. **A default is a decision nobody reviews.** `SoLineCard`'s
   `variantsRequired = true` made nine forms demand a field their own server
   never asked for; `scm.pos_carts`' `staff_id PRIMARY KEY` (a column added by
   mig 0100, the KEY left alone) let one company's cart overwrite the other's.
   Where the right answer differs per caller, make the parameter REQUIRED so
   forgetting it fails to compile.

2. **A failure that reaches nobody is worse than a crash.** Thirty-five write
   paths refused correctly and told no one — the owner reported it as "the
   button does nothing". Budget an error path per mutation the way you budget a
   success path (`vendor/scm/lib/mutation-error.ts`).

3. **A checker that cannot match reports a clean run.** Two scripts did this in
   one day: a lost `\s`/`\b` made one scan the wrong function bodies for weeks,
   and repairing it took the count from 34 findings UP to 37 — the extra being a
   cross-company GL posting. Every checker here now self-tests its patterns at
   startup and refuses to report rather than report from a dead one. **A verdict
   computed over nothing must never read as a pass.**

**Read the DDL's own words, not its column list.** Counting `company_id` columns
gave the WRONG answer twice in opposite directions on the fleet tables. The
authority is the migration header plus the READ path — migs 0202/0203/0204/0238
each say `company_id` is stamped "for provenance but NOT used to scope reads",
and `GET /fleet-maintenance/dashboard` reads every row with no predicate. And
`error.code === '42501' → 403` in a handler is NOT a database permission check
doing your scoping: mig 0061 enabled RLS with NO policies and the SCM client is
the SERVICE-ROLE client, which bypasses RLS. The only boundary is the predicate
in the route.

## Read the map before exploring

- **`docs/CODEBASE-MAP.md`** — what each area is FOR, which trees are dead,
  which folders are vendored, where desktop and mobile diverge, and which
  files are too big to open whole. Read this INSTEAD of exploring from
  scratch; it is the hand-written judgement layer.
- **`docs/generated/`** — the mechanical inventory (routes, migrations,
  largest files). It is COMPUTED from the tree, which is not the same as
  being current: only `route-capability-matrix` is a CI gate (`audit:routes`,
  in `ci.yml` + both deploy workflows). `route-locator.md` and
  `codebase-map-facts.md` are regenerated ON DEMAND and nothing in CI runs
  their `--check`; `gen-codebase-map.mjs` says so in its own output. As of
  2026-08-13 `codebase-map-facts.md` IS drifted at HEAD — it records
  `consignment-returns.ts` at 957 lines against an actual 1118. Run
  `npm --prefix backend run audit:map` / `audit:route-locator` before trusting
  a number from either.

  largest files), regenerated from the tree. **"Cannot drift" is only true of
  the CI-gated half, and this bullet used to claim it of all four.** CI runs
  `audit:routes` (the capability matrix) on every PR; it does NOT run
  `audit:route-locator` or `audit:map`, and both of those artifacts were found
  STALE on `main` on 2026-08-14. That is deliberate, not an oversight — both
  generators say so in their own headers ("a navigation doc going stale must
  never block a deploy"). The practical rule: **treat `route-locator.md` and
  `codebase-map-facts.md` as hints and re-run the generator before trusting a
  line number**, and do not "fix" the gap by adding a CI gate without the owner,
  because the absence is a decision.
- **`docs/modules/<module>.md`** — everything needed to work in ONE module
  without reading the others. Read the guide for the module you are touching
  before touching it.
- **`docs/generated/route-locator.md`** — every route's FILE and LINE. Before
  changing an endpoint in a large router (`mfg-sales-orders.ts` and the other
  multi-thousand-line files), grep this for the path and jump to the line. Do
  NOT read a 10,000-line route file whole to find one handler — that is the
  single biggest source of slow, token-heavy sessions here (see
  `docs/AI-DEV-VELOCITY.md`). Pair it with `route-capability-matrix.csv` for the
  full mount path + permission gates. Regenerate with
  `npm --prefix backend run gen:route-locator`.

**Where does a new fact go?** `docs/KNOWLEDGE-SYSTEM.md` answers that, and
explains why these layers exist. One rule decides it: *a fact belongs in the
layer that will be forced to update it when it changes.* A number that shifts
every merge must be GENERATED, never typed — that is exactly how this file
came to claim the database was D1 SQLite for a month after the cutover.

Do not open a 5,000+ line file whole. Three run past 8,000 lines and TWO past
12,000 — `frontend/src/pages/Projects.tsx` is the largest at ~14,900, ahead of
`backend/src/scm/routes/mfg-sales-orders.ts` at ~12,000. Locate with grep, then
read the line range. The map lists the offenders and roughly what lives where
in each.

**Those files may not get any bigger.** `scripts/file-size-ceilings.json`
records what each already is and CI fails if one grows past it; every other
file is capped at 2,000 lines, so a new 3,000-line module fails. Shrinking is
always free and a ceiling may only FALL — `--update` cannot raise one, so if
you are over, the fix is a new module, never a bigger number. Nothing requires
you to SPLIT an existing file. `npm run check:file-size`, rules in
`docs/repo-hygiene.md`.

## What this repo is

Internal ERP for Houzs. Cloudflare Workers + Hono backend, React/Vite SPA
frontend, R2 storage. Single Worker, single SPA.

**The data store is Supabase Postgres, reached through Hyperdrive.** D1 is
test-only now — which matters most for migrations, below.

## Migrations — two trees, only one is real

- **`backend/src/db/migrations-pg/`** is the LIVE tree. `deploy.yml` runs
  `node scripts/pg-migrate.mjs` on every push to main, so a merged file is
  applied to production automatically. A file that fails there blocks every
  later migration until it is fixed.
- **`backend/src/db/migrations/`** is the older D1/test tree. A change put
  there ships, passes CI, merges — and production never changes. Check which
  tree you are in before writing a migration.
- `pg-migrate` tracks applied files by FULL FILENAME, so number gaps and
  out-of-order merges are safe; DUPLICATE numbers are what break it. Pick the
  number at MERGE time by re-listing the tree, not when you branch — parallel
  PRs otherwise pick the same one.

## Release discipline — the two things a revert cannot undo (ENFORCED)

Reverting a commit un-ships a route. It does not un-ship a **migration** (the
file is applied to prod on the next push to main and is immutable from that
moment) and it does not un-ship a **repair script that has already run**. For
those two, the discipline IS the rollback plan, so it is a CI gate and not a
paragraph: `npm --prefix backend run audit:release-discipline`, wired into the
required `backend-typecheck` check.

**A migration carries a `-- REVERSAL:` note.** What undoes it, or `IRREVERSIBLE
— <why>`. If it does `DROP VIEW`, the note has to name the GRANTS the recreate
must put back: a recreated view is a NEW object with an empty ACL, which is how
0189 took prod's Sales Order list down for every user and needed both 0190 and
0191 to repair — nobody had written down what the view's grants were.

**A script in `backend/scripts` that opens a database and WRITES carries all
four of:**

1. a `MODE` / `APPLY` gate whose DEFAULT is plan (any non-`apply` default —
   `'plan'`, `'dry-run'` — counts; an opt-OUT like `DRY=1` does not, because
   unset it writes);
2. a `CONFIRM` phrase on the apply path, refused with an exit (a value you must
   repeat, like `delete-test-so.mjs`'s `CONFIRM_DOC`, is stronger and also counts);
3. a verification that re-reads on a **FRESH connection** and asserts the
   **SHAPE**. A row count is not a shape: on 2026-08-13 a repair written to undo
   the jsonb double-encoding COE reproduced that exact bug on 7 production rows,
   and its row count reported 7 of 7 while only its shape check saw it;
4. a `RE-RUN:` line in the header saying what a SECOND run does.

Copy `repair-array-shaped-variants.mjs` or `unify-processing-date.mjs` — both
pass all four today.

**It is a ratchet.** Today's tree is grandfathered rule-by-rule in
`backend/scripts/release-discipline-grandfathered.json`, and that list may only
SHRINK: fix a rule and the check makes you delete it from the ledger in the same
PR, and the count is printed on every run so the debt stays visible. A NEW
script complies or CI fails.

## ⚠️ Never ask the owner to run a query — build the check instead (owner rule)

The owner is not a database console. If you need a fact that lives only in
production, the answer is a script plus a `workflow_dispatch` workflow that
reads it using `secrets.DATABASE_URL` — **not** a SQL snippet pasted into chat
for him to run. Asking costs an interruption every single time, and it puts the
production DSN in front of a human for what is usually a `SELECT`.

Live example to copy: `backend/scripts/check-soak-gate.mjs` +
`.github/workflows/soak-gate-check.yml`. Actions → **Soak gate check
(read-only)** → Run workflow; the verdict appears as a run annotation.

**`DATABASE_URL` is the credential. There is no other one.** Nearly every
workflow here uses `secrets.DATABASE_URL` (289 of 300 as of 2026-08-14 —
`grep -rl secrets.DATABASE_URL .github/workflows | wc -l`, which is the number
to re-run rather than trust); it is the only database secret this repo holds, at
repo level or in any of its three environments. If your script needs a
PostgREST-shaped client — because it imports a real service function out of
`src/` rather than re-implementing it, which is the right instinct — it needs
the SHAPE, not PostgREST credentials: `backend/scripts/lib/pgrest-shim.mjs`
gives you `sb.from(...)` over the pg connection. Copy
`recompute-so-allocation.mjs`, which does exactly this.

**Do NOT copy `recompute-2990-so-allocation.yml`.** It is three characters away
from that one by name and it is wired to `SUPABASE_URL` +
`SUPABASE_SERVICE_ROLE_KEY`, which do not exist here — so it has never run and
cannot. On 2026-08-13 a new workflow was written by copying it and failed on its
first dispatch with both secrets empty. `SOURCE_SUPABASE_URL` /
`SOURCE_SERVICE_ROLE_KEY` DO exist and are a third thing again: they point at
the 2990 SOURCE system, not at Houzs.

Rules for anything in this shape:

- **Read-only means read-only.** One statement, no DDL, no writes, no
  transaction. If a check needs to write, it is not this pattern.
- **Manual trigger only.** Never put a production DB read on a schedule; it
  turns a real query into CI noise nobody reads.
- **Own concurrency group, never the deploy's.** A diagnostic must not queue
  behind — or displace — a release.
- **Exit 0 for every legitimate answer.** A red job reads as "the check broke".
  The answer is the output. Reserve non-zero for an unreachable DB.
- **Evidence is not a setting.** When a marker row is MISSING, say so and stop.
  Never insert it to make a gate pass — that forges the exact evidence the gate
  exists to check. (This is why `check-soak-gate.mjs` treats zero rows as its
  own outcome, not as "false".)

**Never accept a credential through chat, and never read one out.** On
2026-07-22 an attempt to identify which database a local `.dev.vars` pointed at
echoed the whole DSN, password included, into a transcript — the file's value
was quoted, so the `sed` that was supposed to strip it did not match. If you
must inspect a secret-bearing file, match the field you want and print only
that; never print a line and never let a failed match fall through to the raw
value. If one is exposed anyway: say so immediately, record the rotation task
in the repo, and keep reminding until the owner confirms it is rotated.

## Desktop and mobile are one product

`frontend/src/mobile` is a first-class surface, not a viewport tweak. Most
features exist as a desktop file and a mobile file that must change TOGETHER
— the owner's standing rule is ONE shared logic layer, with the two surfaces
differing only in presentation. Fixing a rule on one surface and not the
other is a recurring bug class here (see `BUG-HISTORY.md`). The map lists the
known pairs.

## Obsidian wiki — keep it current

A companion knowledge base lives in the user's Obsidian vault under
`Houzs ERP/`. It's the human-readable counterpart to the codebase
(architecture, decisions, module guides, glossary). It is the human-facing
counterpart to `docs/CODEBASE-MAP.md`, which is the agent-facing one.

The Obsidian MCP is registered at USER scope, not in this repo, so
`mcp__obsidian__*` is available only in sessions that have it connected —
several do not. If those tools are absent, skip the wiki and say so rather
than working around it; the repo-side map is the fallback that always works.

**When to update the wiki** — after work that meaningfully changes:

- A module's surface (new endpoints, new permission, new tab)
- The data model (new migration that touches an existing concept)
- An architectural decision (always add to `Houzs ERP/Decisions.md`)
- A core pattern (ACL, polling, UDF, scoping)
- The roadmap (move items between sections, mark done, add new ones)

**When NOT to update** — bug fixes, refactors that don't change the
surface, dependency bumps, doc fixes inside the code itself.

**How to update** — append a section under the existing structure;
don't rewrite. Cross-link with `[[wiki-link]]` syntax. Match the tone
of the existing notes (concrete, terse, callouts where useful).

The user's preference, in their words: *"do your best and be creative"*
and *"fill them with details specific"* — the wiki should always carry
real schema columns, real LOC counts, real SQL, real permission keys.
Not generic narrative.

## Coding conventions specific to this repo

- **No emoji.** Anywhere. Empty states, status copy, comments, commits.
- **A parameter that DECIDES something is required, never optional.** If its
  absence changes an answer — a gate, an exemption, a scope, a threshold, a
  default that is not neutral — write it as `x: T | null` and let the compiler
  enumerate the call sites. `x?: T` means every caller that says nothing keeps
  the OLD behaviour, with no compile error, no failing test and no runtime
  signal, so the rule ends up applying only where someone remembered it. This
  cost four days on `itemCode` (DIVAN ONLY lines kept demanding a mattress Gap
  after PR #1763 said "every desktop + mobile call site"), and the same hole
  shipped `onMultiPo` on the drop-ship batch resolver, where the silent default
  was the permissive one. Where "no value" is legitimate, pass an explicit
  `null` — it reads as a decision — and assert what `null` means. An optional
  parameter is acceptable only when its absence is the STRICTER direction, and
  then the comment has to say so (precedents: `assertNotMirrored`'s missing
  context leaves the guard active; `scopeToCompanyId` in
  `scm/lib/companyScope.ts` states this rule in full). See **BUG CLASS
  optional-param-noop** at the top of `BUG-HISTORY.md`.
- **Drizzle ORM for new code.** New routes / services use Drizzle —
  schema in `backend/src/db/schema.ts`, client via
  `getDb(env)` from `backend/src/db/client.ts`. Raw
  SQL via `c.env.DB.prepare(...)` is still allowed in legacy code
  paths until they're converted route-by-route. Don't mix the two
  styles inside a single function — convert the whole handler. **Migrations
  remain hand-written `.sql` files** — in `src/db/migrations-pg/` for
  anything that must reach production (see *Migrations* above) — numbered
  and immutable after deploy. Drizzle-kit is for type generation /
  schema diffing only, never as the migration runner.
- **Demo / test seed data does NOT belong in numbered migrations.**
  Numbered migrations run in prod. Migs 067 + 069 seeded 39 fake
  `sales_reps` with `@example.my` emails; mig 079 then had to delete
  them. All three live in `src/db/migrations/`, the D1 tree production
  no longer reads, so the seed-then-cleanup cost is now paid only by a
  fresh D1 test DB — not by prod. Do not read that as the rule being
  spent: it is the same mistake in `migrations-pg/` that would be
  permanent. Put demo data in a one-shot `backend/scripts/seed-*.mjs`
  script you run manually against the local D1 (precedent: existing
  `backend/scripts/backfill-project-codes.mjs`). Numbered migrations
  are for schema changes + production-required data only — lookup
  tables, default roles / permissions, canonical enum rows. If a
  table needs sample rows to develop against, that's a script, not
  a migration.
- **Anything a TEST imports lives in `backend/scripts/lib/` and carries
  NO shebang.** Runnable scripts keep their `#!/usr/bin/env node` (~200
  do). A module a test imports must not have one: on Windows vitest
  INLINES it and wraps the source before `vm.runInThisContext`, so a `#!`
  that is no longer at byte 0 is `SyntaxError: Invalid or unexpected
  token`. It dies at LOAD, so it reports as a failed FILE with zero
  tests, no assertion and no line number — it reads exactly like a
  corrupt byte, and one such throw is counted TWICE (failed suite +
  Unhandled Rejection), so it looks like two broken files. Linux
  externalizes the same module and node strips the shebang itself, so
  **CI stays green and only local Windows breaks** (#2062 — BUG-HISTORY
  has the trace). No test-imported `.mjs` carries a shebang today, which
  is the property that matters — but three of them do NOT live in
  `scripts/lib/`: `scale-pg-real-schema.mjs`, `scale-target-guard.mjs`
  and `repair-so-fee-line-integrity.mjs` sit directly in
  `backend/scripts/`, imported by `tests/scale*.node.mjs` and
  `tests/soFeeLineRepairRow.test.ts`. Adding a `#!` to any of those three
  breaks local Windows and CI will not tell you. If a runnable script
  needs to expose a function to a test, put the pure part in
  `scripts/lib/` and import it from the script.
- **Keep schema and data in separate migrations when both are large.**
  An `ALTER TABLE` + 100-line `INSERT` block in the same file makes
  rollback awkward and the diff hard to read. Numbered migrations are
  cheap; prefer two small ones over one big one.
- **No WebSockets yet.** Polling is the realtime mechanism — see the
  wiki's *Polling Strategy* note for cadence and rationale.
- **URL is state.** Filters/tabs/modes go in `useSearchParams`.
  localStorage is fallback for personal prefs only.
- **Company scope: the predicate is the only isolation — on WRITES too.**
  The SCM/Houzs supabase client is the **service role**, so it **bypasses
  RLS** and no policy is ever evaluated on an app request. The
  `company_id` predicate a statement carries is the entire tenant
  boundary. Three rules follow:
  (a) put it on the write itself, not only on the read that preceded it —
  nothing re-checks between two PostgREST round trips, which is how a
  scoped-read-then-open-update shipped across the whole system;
  (b) a parent-ownership predicate (`so_doc_no`, `purchase_invoice_id`,
  `trip_id`) proves the row is on that document, NOT that the document is
  in your books — you need both;
  (c) a cross-company module still takes a predicate, just a wider one
  (`scopeToAllowedCompanies` = the caller's granted companies); "shared
  queue" never means "no predicate". Use `scopeToCompany` /
  `scopeToCompanyId` from `scm/lib/companyScope.ts` (that file's header is
  the reference), and `maybeSingle` not `single` on any by-id statement
  carrying one — the predicate can legitimately match zero rows and
  `single()` reports that honest 404 as a 500. If a route is
  deliberately cross-company or deliberately shared, say so in a comment
  naming why, so the next sweep does not "fix" it. Background:
  `docs/MULTICOMPANY-MODULE-MAP.md`.
- **Permissions are flat strings**, e.g. `projects.read`. Catalogue
  lives in `backend/src/services/permissions.ts`. New verbs since
  mig 047: `projects.chat`, `projects.checklist.tick` — use
  `requireAnyPermission([...])` to gate routes that accept either a
  narrow verb or `projects.write`.
- **Row-level scope is two-dimensional now.** PIC one-hop +
  brand allow-list (mig 049). Use `getProjectScope(user)` from
  `backend/src/services/projectAcl.ts` — returns
  `{ pic_ids, brands }`. The SQL fragment
  `COALESCE(p.pic_id, p.created_by) IN (...) AND p.brand IN (...)`
  is still hand-written at FIVE statements across four callsites —
  project list (`services/projects.ts:1889`), calendar
  (`routes/projects.ts:4916` + `:4924`, two arms of one handler),
  notifications (`routes/notifications.ts:96`, written in Drizzle
  template form so a raw-string grep MISSES it), and the two finance
  endpoints `GET /finance/by-project` (`:2752`) and `GET /finance/lines`
  (`:2961`). `projectScopeWhere(user)` does not exist yet; centralising
  into it is on the Roadmap.
- **Section + attachment data on tasks** (mig 050). Project tasklist
  groups by `project_checklist_sections`; per-task attachments live
  in `project_checklist_attachments`. The project-level
  `project_attachments` table is kept for legacy data, no longer
  surfaced in the UI.

## Working agreement

- Don't add features, refactor, or introduce abstractions beyond what
  the task requires.
- Default to no comments. WHY only, never WHAT.
- For UI changes, test in the browser before claiming success.
- Confirm before destructive ops (force push, dropping tables, deleting
  branches). Auto-mode is not blanket consent for risky writes.
  - Write TODO when planning is confirmed 
  - After meaningful work lands, end the reply with a one-line offer to
  `/sync-wiki` if the wiki should be updated.

## See also

- **`docs/KNOWLEDGE-SYSTEM.md`** — the layers, what belongs where, and why
- **`docs/CODEBASE-MAP.md`** — start here for anything you would otherwise
  go exploring for; `docs/generated/` for the mechanical inventory
- **`BUG-HISTORY.md`** — read the entries for a subsystem before touching it
- **`docs/repo-hygiene.md`** — the branch rules and the file-size ratchet
- `/sync-wiki` — user-scope slash command for the Obsidian refresh; the
  command file is NOT in this repo, so it exists only where the user has it
  installed
- The user's auto-memory MOC at `~/.claude/projects/<hash>/memory/MEMORY.md`
- The Obsidian wiki's `Houzs ERP/00 Home.md` for the map of content
