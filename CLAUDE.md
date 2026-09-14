# Houzs ERP — Working agreement

Auto-loaded everywhere, so RULES only. Each section's story: `docs/working-agreement-history.md`; id map:
`docs/working-agreement-rule-inventory.md`. New rule = one bullet here + story there + inventory row [R121].

## ⚠️ Do not guess. Prove it, or say you do not know yet — MANDATORY (owner rule)
[why](docs/working-agreement-history.md#h-guess) · *"我要确定的答案，有时找 bugs 都是猜的，很不好."*

- [R01] An unobserved cause is a hypothesis. Before a fix: name the observation that would REFUTE it, make it (live query, `wrangler tail`, dispatch, repro) naming the tool, then fix. Refuted → say so.
- [R02] Label every claim to the owner: **PROVEN** (ran it, output here) / **LIKELY** (fits, here is what settles it) / **UNKNOWN** (always acceptable, never disguised).
- [R03] Code, migrations and comments are intent, not evidence about production. Measure the running system.
- [R04] Trap: a check answering a different question (`UPDATE 1`, `res.count`) — ask what success is ALSO true of.
- [R05] Trap: a check that is not running — green is not evidence until you know it ran, and against what.
- [R06] Never make evidence say what you want: a missing marker row IS the finding, never insert it; a matcher that misses → fix the library, never loosen the guard.
- [R07] **RE-RUN, never recall**: every date, count, run id or causal claim in a document comes from a command run at the moment of writing.
- [R08] **A contradiction is a finding — STOP, do not bridge it.** Find which side is wrong; an unresolved disagreement beats a seamless story.
- [R09] **A REMEDY CLAIM needs the run that proved it — ENFORCED** (rule 4, `scripts/check-working-agreement.mjs`). "Running X will fix" → paste the status/count/error/run URL, or write **UNTESTED** in the sentence. Retract → fix every copy.
- [R10] AutoCount pull backlog: `?mode=all` dies (HTTP 503); use `?since=YYYY-MM-DD` windows.

## ⚠️ 用白话文跟老板讲 — MANDATORY (owner rule, 2026-08-18)
[why](docs/working-agreement-history.md#h-plain) · *"都没有用白话文让人简单明白。因为我不是 IT 出身的。"* Output rule; rigour unchanged.

- [R11] First sentence = the business effect (not in AutoCount; stock off by N) — never a function, path or identifier.
- [R12] Identifiers (paths, functions, PRs, columns) are evidence and go LAST, under a labelled heading.
- [R13] Numbers carry his denominator: "1 张 / 11,134 张交货单", not "0.0%".
- [R14] Define an unavoidable technical word once, in his words.
- [R15] Not a licence for vagueness: labels, numbers and the reproducing command stay.

## ⚠️ A root cause is a request for OPTIONS, not for agreement — MANDATORY (owner rule, 2026-08-18)
[why](docs/working-agreement-history.md#h-options) · *"给我 proposal，给我 suggest，让我去选择"*

- [R16] Don't repeat his cause back. Read OUR code: say what changes in THIS system — module, table, what breaks, cost.
- [R17] Say how a normal ERP (AutoCount / SAP / Odoo / NetSuite) does it and whether and why ours differs.
- [R18] 2–3 NAMED options, each: cost, what breaks, effect on existing documents, life after.
- [R19] RECOMMEND one, with why. He picks.
- [R20] Never end a diagnosis without options.
- [R21] PROVABLE defect → fix without asking; JUDGEMENT (require? label? charge? allow?) → options + recommendation.

## ⚠️ 挖到真正的 ROOT CAUSE，从根本解决，不拿补丁当终局 — MANDATORY (owner rule, 2026-08-18)
[why](docs/working-agreement-history.md#h-root-cause) · *"所有的问题都要找出来真的 root cause 然后根本解决"*

- [R22] Trace the real mechanism with code evidence to the line that goes wrong — not the symptom.
- [R23] A switch/retry/cache-bust/flag is a STOPGAP: may ship as relief, but name it one, name the root fix and what it takes. Never call it solved.
- [R24] Options ranked stopgap → proper with effort/risk/benefit, how large ERPs solve the class, and a recommendation.

## ⚠️ 任务清楚就一路做完，不要每步停下来问 — MANDATORY (owner rule, 2026-08-18)
[why](docs/working-agreement-history.md#h-execute) · *"不要一直问我…跟着你的 worktree 把所有 tasks complete 掉"*

- [R25] Direction chosen + steps clear → drive to the end (commit, PR, next) without per-step approval. Options are for choosing, not re-asking.
- [R26] Interrupt only for: a business/judgement call that is his; a destructive/irreversible action; a blocker only he can clear (secret, repo setting).
- [R27] Design around the last: an unset secret reads as a NO-OP, ship inert, he activates later.

## ⚠️ Log every bug in the ledger — MANDATORY (owner rule, everyone)
[why](docs/working-agreement-history.md#h-bug-ledger)

- [R28] Every bug fixed gets `docs/bugs/NNNN-slug.md` in the SAME PR: **Symptom → Root cause (traced) → Fix → Ref (PR/date)** + severity.
- [R29] Scaffold, never hand-pick the number: `node scripts/new-bug.mjs "<title>" --severity high`
- [R30] Read a subsystem's entries before touching it: `npm --prefix backend run gen:bug-index` / `gen:bug-history` (gitignored; `docs/bugs/README.md`).
- [R31] Cite an entry by FILENAME, never by line number.

## ⚠️ Read the module guide before you work in a module — MANDATORY (owner rule)
[why](docs/working-agreement-history.md#h-module-guide)

- [R32] Read `docs/modules/<module>.md` before touching the module.
- [R33] SURFACE change (endpoint, permission, status, required-field flip, lock) → update the guide in the same PR.
- [R34] No guide → write it, shaped like `docs/modules/sales-order.md`.

## ⚠️ Coverage ratchets — and one of them BLOCKS your PR
[why](docs/working-agreement-history.md#h-coverage)

- [R35] Per area, coverage only UP and untested-file count only DOWN (`coverage-baseline.json`, `scripts/coverage-ratchet.mjs`). `frontend/src` blocks per PR; backend areas are measured on `main` (`.github/workflows/coverage.yml`); `backend/scripts` no-test floor is off.
- [R36] Raise: `npm run coverage:update`. Lower: `--update --allow-drop` + reason in the PR. The 0.1-pt slack is for the merge base, not you. Blind spots: `docs/TESTING-RATCHET.md` §6.
- [R37] Don't chase the percentage; test untested files that decide MONEY or STOCK.

## ⚠️ A serious incident gets a COE — MANDATORY (owner rule)
[why](docs/working-agreement-history.md#h-coe)

- [R38] Outage, data at risk, recurrence, or felt unreliability → `docs/<subject>-coe.md` like `docs/system-foundation-coe.md`: Date · Trigger (staff's words) · Root cause + proving tool · Fixes (row per PR) · RULED OUT + how · Deferred + owner · Lessons.

## ⚠️ The bug ledger, the module guide and migrations are CHECKED on every PR
[why](docs/working-agreement-history.md#h-pr-checks)

- [R39] `scripts/check-working-agreement.mjs` (advisory) fails: a fix-shaped code PR with no NEW `docs/bugs/` file; a surface change with its guide untouched; a `migrations-pg/` change without `Reversal:` + `Verified against:` body lines. Escapes: labels `no-bug-history-needed` / `no-guide-change`. Known gaps: `scripts/lib/working-agreement.escapes.test.mjs`.
- [R40] A "no guide covers this" warning names the guide to write — write it.
- [R41] Keep this file THIN: rules and traps, no facts that change per merge (those belong in the map/generated docs).

## ⚠️ A number in a comment is a fact with an expiry date — MANDATORY (owner rule)
[why](docs/working-agreement-history.md#h-numbers)

- [R42] A number you write is yours to keep true: prefer generated + `audit:` gate (`audit:test-schema`, `audit:map`, `audit:routes`); else date it inline ("as of 2026-08-13, 277 files").

## ⚠️ Measure before you optimise, and put the stopwatch in the PR — MANDATORY (owner rule)
[why](docs/working-agreement-history.md#h-measure)

- [R43] No performance change on arithmetic: probe, paste before/after, name the tool.
- [R44] Must not destabilise: prove behaviour-equivalence on the real runtime (`backend/tests/schemaSnapshotParity.test.ts`).

## `main` IS protected now — since 2026-07-31
[why](docs/working-agreement-history.md#h-main-protected)

- [R45] Verify: `gh api repos/hello-houzs/Houzs-ERP/rules/branches/main` (a ruleset; classic endpoint 404s). Required `backend-typecheck` + `frontend`, strict up-to-date, PR required with 0 approvals, no bypass — nobody can force a merge.
- [R46] Auto-merge doesn't resolve conflicts; DIRTY needs a person.
- [R47] Pick a migration number at MERGE time by re-listing the tree.
- [R48] Renaming an applied migration is safe if byte-identical; NEVER edit its body (checksum `DRIFT` blocks the deploy).
- [R49] After merge, check the Deploy run's jobs (`gh api repos/hello-houzs/Houzs-ERP/actions/runs/<id>/jobs`): run conclusion WITH `backend` job. `failure`+`skipped` = FAILED; `success`+`skipped` = no backend change (path filter `backend/**`); `success`+`success` = shipped.
- [R50] A `workflow_dispatch` workflow ships only after one successful dispatch; copy a precedent proven to run, not a similar name.
- [R51] Never make `backend-tests (N)` or `backend` required. A merge-blocking assertion goes in `backend-typecheck` (light project) + `MUST_GATE_MERGE` in `backend/tests/classifyTests.test.mjs`.
- [R52] Never `gh pr merge --auto` a PR carrying a migration or integration batch.
- [R53] Check the tree before believing a remedy is still outstanding.

### ⚠️ Update a behind branch by merging `main` LOCALLY. Never press *Update branch*
[why](docs/working-agreement-history.md#h-merge-locally)

- [R54] `git merge origin/main` locally, then push — never *Update branch* / `gh pr update-branch` (GitHub's git ignores our `.gitattributes`).
- [R55] Per clone: `git config merge.regen.driver "scripts/regen-generated.sh %A"`.
- [R56] Prefer a layout with no shared line over a merge driver.

### ⚠️ `statusCheckRollup` LIES. Read `mergeStateStatus` and the newest run
[why](docs/working-agreement-history.md#h-rollup)

- [R57] Confirm any rollup entry against the newest run (`gh pr view <N> --json mergeable,mergeStateStatus`; `gh run list --workflow=<name>.yml --branch <branch> --limit 5`). They disagree → the run list is right; never edit code for the stale one.

## ⚠️ Run the audit scripts — they answer questions no doc can
[why](docs/working-agreement-history.md#h-audit-scripts)

- [R58] Run them (no `node_modules` needed); never quote a count from a doc; output is evidence:
  `node backend/scripts/check-company-scope.mjs` · `node frontend/scripts/check-silent-mutations.mjs` · `node backend/scripts/check-shared-mirrors.mjs` · `node backend/scripts/check-docs-drift.mjs`
- [R59] `check-docs-drift --strict` gates on missing references. Mark on the SAME LINE right after it: `[gone]` `[planned]` `[external]` `[generated]` (gitignored only) `[renumbered]`. Fences are scanned. No silent exemption lists.

## ⚠️ `tsc --noEmit -p tsconfig.json` CHECKS NOTHING on the frontend
[why](docs/working-agreement-history.md#h-tsc)

- [R60] Frontend typecheck = `npm --prefix frontend run typecheck` (`tsc -b`, `--force` to recheck), never `npx tsc --noEmit` (solution file: 0 files, exit 0). `-p` is fine in `backend/`. Fast silent pass → plant a type error, confirm it FAILS.
- [R61] A ledger entry with no test attached is unfixed.
- [R62] A failure that reaches nobody is worse than a crash: every mutation gets an error path (`vendor/scm/lib/mutation-error.ts`).
- [R63] Checkers self-test their patterns; a verdict over nothing never reads as a pass.
- [R64] Read the DDL header + the READ path, not the column list. `42501 → 403` is not scoping: the SCM client bypasses RLS; the route predicate is the only boundary.

## ⚠️ The C# AutoCount service DOES compile here — check before writing UNCOMPILED
[why](docs/working-agreement-history.md#h-csharp)

- [R65] Before writing UNCOMPILED: `powershell -ExecutionPolicy Bypass -File backend/scripts/autocount-service/build-local.ps1` (seconds, no DB).
- [R66] Compiling ≠ deploying: the office host swaps via `deploy-on-host.ps1`; until then our half is INERT.

## There IS a linter now — since 2026-08-13, and it is a RATCHET
[why](docs/working-agreement-history.md#h-linter)

- [R67] `npm run lint` (root/`backend`/`frontend`); CI job `lint`, not required.
- [R68] "ESLint can't run locally" = stale `node_modules` → `npm ci` in that app.
- [R69] Frontend leg enforces; CI backend leg stays `-- --advisory` until honest types make it green. Hard errors are never advisory; never use `continue-on-error`.
- [R70] Keep `node_modules/eslint/bin/eslint.js` under `process.execPath`, not the `.bin` shim (Windows).
- [R71] `scripts/lint-ratchet.mjs`: per-file ceilings in `<app>/eslint-ratchet.json` only FALL (no entry = 0). Never raise one — fix, or `// eslint-disable-next-line <rule> -- <reason>`; `npm run lint:update` only lowers.
- [R72] Rules in `scripts/eslint/houzs-lint-rules.mjs`; each cites its ledger entry — none without.
- [R73] Scope: `backend/src/**/*.ts`, `frontend/src/**/*.{ts,tsx}` only.

## Read the map before exploring
[why](docs/working-agreement-history.md#h-map)

- [R74] Read `docs/CODEBASE-MAP.md` instead of exploring; `docs/modules/<module>.md` for one module. `docs/generated/`:

  | artifact | gated in CI? |
  | --- | --- |
  | `route-capability-matrix.csv` | YES — `audit:routes` |
  | `codebase-map-facts.md` | YES — `audit:map` in `backend-typecheck` |
  | `bug-index.md` · `bug-history.md` | NOT TRACKED — `gen:bug-index` / `gen:bug-history` |
  | `route-locator.md` | NO — re-run `npm --prefix backend run gen:route-locator` before trusting a line number |
- [R75] Find a handler via `docs/generated/route-locator.md`; never read a 10,000-line router whole.
- [R76] A fact goes in the layer forced to update it (`docs/KNOWLEDGE-SYSTEM.md`); per-merge numbers are GENERATED.
- [R77] Never open a 5,000+ line file whole (`frontend/src/pages/Projects.tsx`, `mfg-sales-orders.ts`): grep, read the range.
- [R78] `scripts/file-size-ceilings.json` ceilings only FALL; other files cap at 2,000 lines; over → new module (`npm run check:file-size`, `docs/repo-hygiene.md`).
- [R79] Correcting a doc paragraph → DELETE the one it replaces.

## What this repo is

- [R80] Houzs internal ERP: Cloudflare Workers + Hono, React/Vite SPA, R2. **Data store: Supabase Postgres via Hyperdrive; D1 is test-only.**

## Migrations — two trees, only one is real
[why](docs/working-agreement-history.md#h-migrations)

- [R81] `backend/src/db/migrations-pg/` is LIVE (applied on every push to main by `pg-migrate`; a failure blocks all later ones). `backend/src/db/migrations/` is D1/test only — production never sees it.
- [R82] Gaps are safe; DUPLICATE numbers break it (R47).

## Release discipline — the two things a revert cannot undo (ENFORCED)
[why](docs/working-agreement-history.md#h-release)

- [R83] Gate: `npm --prefix backend run audit:release-discipline` (in required `backend-typecheck`).
- [R84] A migration carries `-- REVERSAL:` or `IRREVERSIBLE — <why>`; `DROP VIEW` names the grants to restore.
- [R85] A `backend/scripts` DB-writing script has all four: default-plan `MODE`/`APPLY` gate (not an opt-out); `CONFIRM` phrase on apply; re-read on a FRESH connection asserting SHAPE, not count; `RE-RUN:` header line. Copy `repair-array-shaped-variants.mjs`.
- [R86] `backend/scripts/release-discipline-grandfathered.json` only SHRINKS; new scripts comply.

## ⚠️ Never ask the owner to run a query — build the check instead (owner rule)
[why](docs/working-agreement-history.md#h-no-query)

- [R87] A production-only fact → script + `workflow_dispatch` on `secrets.DATABASE_URL`, never SQL for him. Copy `backend/scripts/check-soak-gate.mjs` + `.github/workflows/soak-gate-check.yml`.
- [R88] `DATABASE_URL` is the only DB credential; for a PostgREST shape use `backend/scripts/lib/pgrest-shim.mjs` (copy `recompute-so-allocation.mjs`).
- [R89] The Supabase MCP lists three projects: production = **`anogrigyjbduyzclzjgn`** ("HOUZS ERP SG"), staging = `minnapsemfzjmtvnnvdd`, `ctbaifabbzghtsrmpirm` ("Houzs PostgreSQL Database") is an OLD COPY. Check the id before calling a query production evidence.
- [R90] `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are Worker secrets; adding them to Actions is FORBIDDEN (public repo, key bypasses RLS). REST-edge needs → `GET /api/admin/health/rest-page-ceiling`. `SOURCE_*` secrets = the 2990 source system.
- [R91] Diagnostic workflows: read-only; manual trigger, never scheduled; own concurrency group; exit 0 for every real answer (non-zero = DB unreachable); never insert a missing marker.
- [R92] Never take a credential via chat or print one (print only the matched field). If exposed: say so, record rotation in the repo, remind until rotated.

## Desktop and mobile are one product
[why](docs/working-agreement-history.md#h-desktop-mobile)

- [R93] `frontend/src/mobile` is first-class: desktop + mobile pairs change TOGETHER via one shared logic layer.

## Obsidian wiki — keep it current
[why](docs/working-agreement-history.md#h-wiki)

- [R94] Wiki = Obsidian vault `Houzs ERP/`. No `mcp__obsidian__*` tools → skip and say so; the repo map is the fallback.
- [R95] Update after surface, data-model, architecture (`Houzs ERP/Decisions.md`), core-pattern or roadmap changes, not fixes/bumps. Append, `[[wiki-link]]`, real columns/SQL/keys.

## Coding conventions specific to this repo
[why](docs/working-agreement-history.md#h-conventions)

- [R96] **No emoji** anywhere — UI copy, comments, commits.
- [R97] **A parameter that DECIDES something is required** (`x: T | null`, explicit `null`); optional only when absence is STRICTER, said in a comment (`docs/bugs/0098-bug-class-optional-param-noop-an-optional-argument-that-deci.md`).
- [R98] **Claim "every call site / all / everywhere" → prove it** with a ` ```enumeration ` block (`grep`/`rg`/`git grep`/`git ls-files`/`node -e` + output, include paths) — `completeness-claim.yml` re-runs it. Else reword, or label `completeness-not-claimed`.
- [R99] **Drizzle for new code** (`backend/src/db/schema.ts`, `getDb(env)`); never mix with raw SQL in one function. Migrations stay hand-written `.sql`; drizzle-kit never runs them.
- [R100] **No demo/seed data in numbered migrations** → one-shot `backend/scripts/seed-*.mjs`.
- [R101] **Test-imported modules live in `backend/scripts/lib/` with NO shebang** (Windows-only load failure). The three in `backend/scripts/` imported by `tests/scale*.test.mjs` and `tests/soFeeLineRepairRow.test.ts` — `scale-pg-real-schema.mjs`, `scale-target-guard.mjs`, `repair-so-fee-line-integrity.mjs` — must never get `#!`.
- [R102] **Separate schema and large data migrations.**
- [R103] **No WebSockets** — polling.
- [R104] **URL is state** (`useSearchParams`); localStorage only for personal prefs.
- [R105] **Company scope: the predicate is the only isolation — on WRITES too** (service role bypasses RLS). (a) `company_id` on the write, not just the read; (b) a parent predicate (`so_doc_no`) is not company scope — need both; (c) cross-company takes `scopeToAllowedCompanies`. Use `scm/lib/companyScope.ts` helpers, `maybeSingle` on by-id; comment WHY a route is deliberately shared.
- [R106] **Permissions are flat strings** (`projects.read`) in `backend/src/services/permissions.ts`; either-verb gates use `requireAnyPermission([...])`.
- [R107] **Project visibility is COMPANY-ONLY** (owner, 2026-08-19): `requirePageAccess` + company predicate; crew scoping stays; `user_brands` only splits the DIRECTOR approval lane (`docs/modules/projects-pms.md` Axis 2).
- [R108] Task sections/attachments: `project_checklist_sections`, `project_checklist_attachments` (mig 050); `project_attachments` is legacy.

## Working agreement

- [R109] No features, refactors or abstractions beyond the task.
- [R110] Default to no comments. WHY only, never WHAT.
- [R111] Test UI changes in the browser before claiming success.
- [R112] Confirm before destructive ops (force push, dropping tables, deleting branches); auto-mode is not consent.
- [R113] Write TODO when planning is confirmed.
- [R114] After meaningful work lands, offer `/sync-wiki` in one line.

## A merged PR's branch gets DELETED — MANDATORY (owner rule, 2026-08-12)
[why](docs/working-agreement-history.md#h-branch-delete) · *"确保做好了的PR 就delete掉."*

- [R115] Auto-delete head branches is ON (`gh api repos/Houzs-Century/Houzs-ERP --jq .delete_branch_on_merge`); no manual delete after merge.
- [R116] Don't replace the setting with a workflow.
- [R117] Never bulk-delete branches of CLOSED-unmerged PRs or with no PR (incl. `main`, `staging`).
- [R118] Hand-prune only by PR MERGED, never by age or `git branch -r --merged`; record `sha<TAB>branch`; restore with `git push origin <sha>:refs/heads/<branch>`.

## See also

- [R119] `docs/KNOWLEDGE-SYSTEM.md` · `docs/CODEBASE-MAP.md` · `docs/bugs/` · `docs/repo-hygiene.md` · `/sync-wiki` (user-scope) · auto-memory `MEMORY.md` · wiki `Houzs ERP/00 Home.md`
- [R120] `docs/working-agreement-history.md` · `docs/working-agreement-rule-inventory.md`
