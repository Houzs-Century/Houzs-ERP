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

**This file stays THIN on purpose.** It carries rules and traps, not an
inventory. Facts that change with every merge — route counts, file sizes,
module lists — belong in the map below, because a stale fact HERE is worse
than no fact: this file is auto-loaded, so every session believes it. It
described the database as "D1 SQLite" for over a month after the Postgres
cutover, and pointed at a migration directory that production does not read.

## `main` IS protected now — since 2026-07-31

The owner created the `main-protection` **ruleset**. Verify it rather than
trusting this paragraph — `GET /branches/main/protection` still returns 404
because that endpoint only reports CLASSIC protection and this is a ruleset:

```
gh api repos/hello-houzs/Houzs-ERP/rules/branches/main
```

It currently returns `deletion`, `non_fast_forward`, and `required_status_checks`
with contexts `backend-typecheck` + `frontend` and
**`strict_required_status_checks_policy: true`** — that last flag is *Require
branches to be up to date before merging*, and it is the one that matters.
Repository admin is on the bypass list as an emergency escape hatch.

**What this now prevents, which used to be yours to catch by hand.** A PR whose
CI ran against a `main` that has since moved can no longer merge; GitHub makes
you update the branch, which re-runs CI against the real merge base. That closes
the mechanism behind every incident this section used to list:

| incident | how it happened |
|---|---|
| 2026-07-22: `main` red ~20 min | #918 and #925 were each green against a `main` lacking the other |
| 2026-07-22: backend could not deploy | #1039 merged a `0171` colliding with #912's; its CI predated #912 |
| 2026-07-31: backend could not deploy for 2h | #1439 merged a `0230` colliding with #1435's, for exactly the same reason |

The duplicate-migration test would have caught both collisions — it just never
ran against a tree containing the other branch. Now it has to.

**Still yours, because no ruleset checks it:**

1. **Take migration numbers at MERGE time** by re-listing the tree. Being forced
   up-to-date makes a collision *fail loudly* instead of merging, but you still
   have to pick a free number — one branch was renumbered four times in a day
   (`0159 → 0165 → 0167 → 0171`).
2. **Before renaming an applied migration, check whether it has run.**
   `pg-migrate` tracks by FULL FILENAME, so renaming an applied file makes it a
   new file and its SQL runs a SECOND time against a schema it already changed.
   The deploy log's `APPLIED <file>` line is the record.
3. **After merging, confirm the backend job said `success`, not `skipped`.**
   Required status checks gate the MERGE; nothing gates the deploy that follows.
   On 2026-07-31 the backend sat un-deployed for over two hours while `main` was
   green, because the deploy failed at a step CI does not run.

**Do NOT add `backend-tests (N)` or `backend` as required contexts.** The shard
name carries an index that changes with the shard count, and `backend` is a
roll-up that is legitimately `skipped` on frontend-only PRs — a skipped required
check leaves the PR pending forever.

## ⚠️ Run the audit scripts — they answer questions no doc can

Three dependency-free checks (they run in a fresh worktree with no
`node_modules`). Full story in `docs/one-sided-rules-coe.md`.

**Their HEADLINE metrics are at zero as of 2026-08-13 — that is not the same as
"nothing left".** Stated precisely, because an over-claim here is exactly the
kind of thing this file exists to stop: 0 unscoped WRITES (6 read-side findings
remain), 0 SILENT mutations (53 UNRESOLVED ones are listed for a human), 0
DIVERGED rule pairs (2 pairs share no symbols and were NOT compared). Each
script prints its own buckets — read them, do not read this paragraph.

**On `origin/main` today those numbers are 33 unscoped writes and 41 silent
mutations.** The fixes live on `fix/company-scope-sweep`, unmerged.

```
node backend/scripts/check-company-scope.mjs     # 632 SCM handlers: rows touched by id with no company predicate
node frontend/scripts/check-silent-mutations.mjs # 297 mutations: a server refusal that reaches nobody
node backend/scripts/check-shared-mirrors.mjs    # 41 rule pairs: frontend copy vs backend original
```

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
  largest files), regenerated from the tree so it cannot drift.
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

Do not open a 5,000+ line file whole. Several pages and route modules run
past 8,000 lines and one past 12,000. Locate with grep, then read the line
range. The map lists the offenders and roughly what lives where in each.

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

## ⚠️ Never ask the owner to run a query — build the check instead (owner rule)

The owner is not a database console. If you need a fact that lives only in
production, the answer is a script plus a `workflow_dispatch` workflow that
reads it using `secrets.DATABASE_URL` — **not** a SQL snippet pasted into chat
for him to run. Asking costs an interruption every single time, and it puts the
production DSN in front of a human for what is usually a `SELECT`.

Live example to copy: `backend/scripts/check-soak-gate.mjs` +
`.github/workflows/soak-gate-check.yml`. Actions → **Soak gate check
(read-only)** → Run workflow; the verdict appears as a run annotation.

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
  Numbered migrations run in prod. Mig 067 + 069 seeded ~40 fake
  `sales_reps` with `@example.my` emails; mig 079 then had to delete
  them — every new environment now pays a seed-then-cleanup cost
  forever. Put demo data in a one-shot `backend/scripts/seed-*.mjs`
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
  has the trace). Every test-imported `.mjs` already lives in
  `scripts/lib/` and none carry a shebang: if a runnable script needs to
  expose a function to a test, put the pure part in `scripts/lib/` and
  import it from the script.
- **Keep schema and data in separate migrations when both are large.**
  An `ALTER TABLE` + 100-line `INSERT` block in the same file makes
  rollback awkward and the diff hard to read. Numbered migrations are
  cheap; prefer two small ones over one big one.
- **No WebSockets yet.** Polling is the realtime mechanism — see the
  wiki's *Polling Strategy* note for cadence and rationale.
- **URL is state.** Filters/tabs/modes go in `useSearchParams`.
  localStorage is fallback for personal prefs only.
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
  is still hand-written across 3 callsites (project list / calendar /
  notifications); centralising into `projectScopeWhere(user)` is on
  the Roadmap.
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
- `/sync-wiki` — user-scope slash command for the Obsidian refresh; the
  command file is NOT in this repo, so it exists only where the user has it
  installed
- The user's auto-memory MOC at `~/.claude/projects/<hash>/memory/MEMORY.md`
- The Obsidian wiki's `Houzs ERP/00 Home.md` for the map of content
