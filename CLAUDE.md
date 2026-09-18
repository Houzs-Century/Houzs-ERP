# Houzs ERP — working rules

Loaded into every session, so it stays short. Adding a rule means removing or merging one. Hard cap: 150 lines.

## Working with the owner
- He is not an engineer. Answer in plain Chinese: business effect first, numbers with their denominator ("1 / 11,134 张交货单"), file paths and PR numbers last.
- A judgement call (require it? charge it? allow it?): give 2–3 options with cost and a recommendation. He picks.
- A clear task: finish it (code, test, PR) without stopping to ask. Stop only for his business decision, a destructive or irreversible action, or a blocker only he can clear.
- Don't guess about production. If an answer depends on live data, query it read-only first, or say plainly that it is not verified.

## Working fast
- One requirement = one branch = one PR. Fix-ups go into the same PR before merge, not into follow-up PRs.
- Read only what you need: grep, then read the line range. Never open a 5,000+ line file whole (`frontend/src/pages/Projects.tsx`, `backend/src/scm/routes/mfg-sales-orders.ts`).
- Before changing a module, skim `docs/modules/<module>.md` (short, current rules only). Map of the repo: `docs/CODEBASE-MAP.md`.
- Update a behind branch with `git merge origin/main` locally, never GitHub's "Update branch".
- Merge conflict in `CLAUDE.md` or `docs/**`: take main's version, then re-add at most one line if your change moved a rule.
- `gh pr view --json statusCheckRollup` can be stale: trust `mergeStateStatus` and the newest `gh run list` entry.

## Documentation — keep it small
- Bug fixed: add a regression test, and write Symptom / Cause / Fix in 3 lines in the PR body. No per-bug file. Only a NEW recurring bug class gets one line in `docs/bugs/README.md`.
- The test is the memory, so it is not optional: `Fix needs a test` reports a fix PR that changed `*/src` and moved no test (label `no-test-needed` to waive, with the reason in the body).
- Module guide: current rules only (statuses, permissions, locks, required fields, gotchas), at most 300 lines. Edit the line when a rule changes; never append history, dates or measurements. `scripts/check-docs-size.mjs` fails a PR past the limits.
- No handoff documents and no incident essays. Open items live in `tasks/TODO.md`, one line each (what, waiting on whom, since when). A real outage gets one short entry in `docs/LESSONS.md`.
- Don't regenerate or commit `docs/generated/*` unless a check asks for it. Generate locally when you need one (`npm --prefix backend run gen:route-locator`).
- Obsidian wiki: only when the owner asks.

## What this repo is
- Internal ERP: Cloudflare Workers + Hono backend, React/Vite SPA, R2. Data: Supabase Postgres via Hyperdrive. D1 is test-only.
- Desktop and mobile (`frontend/src/mobile`) are one product: one shared logic layer, change both together.

## Production data
- Read-only questions: use the Supabase MCP. Production project `anogrigyjbduyzclzjgn`, staging `minnapsemfzjmtvnnvdd`; `ctbaifabbzghtsrmpirm` is an OLD copy. Check the id. No script and no PR for a one-off question.
- Run a `backend/scripts` tool on production with the one runner: Actions → "Run a backend script on production" (script, plan/apply, CONFIRM, `KEY=VALUE;…`). Do not add a new workflow file per script; a script on the release-discipline grandfather list is refused there until fixed.
- A read-only check, when a script is really needed: exit 0 for every real answer (copy `backend/scripts/check-soak-gate.mjs`).
- Never ask the owner to run SQL. Never accept or print a credential. Never add `SUPABASE_SERVICE_ROLE_KEY` to GitHub Actions.
- AutoCount pull backlog: `?since=YYYY-MM-DD` windows; `?mode=all` dies with HTTP 503.

## Money, stock and data safety — enforced, do not weaken
- Migrations: only `backend/src/db/migrations-pg/` reaches production, applied on every push to main. Pick the number at MERGE time by re-listing the tree. Never edit an applied migration's body. Each carries `-- REVERSAL:` or `IRREVERSIBLE — <why>`; a `DROP VIEW` names the grants to restore. No demo data in migrations; large data separate from schema.
- A `backend/scripts` script that writes to the DB has: plan-by-default `MODE`/`APPLY`, a `CONFIRM` phrase, a re-read on a fresh connection that checks shape (not count), and a `RE-RUN:` header. Copy `backend/scripts/repair-array-shaped-variants.mjs`. Gate: `audit:release-discipline`.
- Company scope: the service-role client bypasses RLS, so the `company_id` predicate is the only boundary, on writes as well as reads. Use `backend/src/scm/lib/companyScope.ts`; `maybeSingle` for by-id. A parent predicate (`so_doc_no`) is not company scope.
- Never `gh pr merge --auto` a PR that carries a migration or an integration batch.
- After merging a `backend/**` change, check the Deploy run: conclusion `failure` with `backend` skipped = the deploy FAILED; `success` with `backend` skipped = nothing to deploy.

## CI
- Required checks: `backend-typecheck`, `frontend`, `company-scope-ratchet`, `completeness-claim`. No approvals; merge queue.
- Don't make `backend-tests (N)` or `backend` required. An assertion that must block a merge goes in the light test project and `MUST_GATE_MERGE` in `backend/tests/classifyTests.test.mjs`.
- Frontend typecheck is `npm --prefix frontend run typecheck` (`tsc -b`). `npx tsc --noEmit` in `frontend/` checks nothing.
- Ratchets only improve: frontend coverage (`coverage-baseline.json`), lint ceilings (`*/eslint-ratchet.json` — never raise; fix, or `// eslint-disable-next-line <rule> -- <reason>`), file size (`scripts/file-size-ceilings.json`; new files at most 2,000 lines). "ESLint can't run" means stale `node_modules`: `npm ci` in that app.
- A new `workflow_dispatch` workflow is not done until it has run once successfully.
- If a PR body pastes an ```enumeration block, CI re-runs it and fails on any difference.

## Code conventions
- No emoji anywhere.
- A parameter that decides something is required (`x: T | null`), never optional.
- Drizzle for new backend code (`backend/src/db/schema.ts`, `getDb(env)`); don't mix with raw SQL in one function.
- Modules imported by tests live in `backend/scripts/lib/` with no shebang.
- Permissions are flat strings (`backend/src/services/permissions.ts`); either-verb gates use `requireAnyPermission`.
- Every mutation shows its failure to the user (`frontend/src/vendor/scm/lib/mutation-error.ts`).
- Polling, not WebSockets. URL is state (`useSearchParams`); localStorage only for personal preferences.
- Project visibility is company-only (`requirePageAccess` + company predicate); crew scoping stays.
- Comments only for a non-obvious WHY. Nothing beyond the task.
- The C# AutoCount service compiles locally (`backend/scripts/autocount-service/build-local.ps1`). Compiling is not deploying: the office host swaps via `deploy-on-host.ps1`.
- Test UI changes in the browser before saying done.
- Confirm before destructive operations (force push, dropping tables, deleting branches).
