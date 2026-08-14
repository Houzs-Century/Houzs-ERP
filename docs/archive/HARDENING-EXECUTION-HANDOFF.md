> **ARCHIVED 2026-08-13.** Continuation record for a hardening batch merged **2026-07-22**; the file's own header already warns its state columns are stale. Live status is `docs/HARDENING-COMPLETION-LEDGER.md`. Kept for history; do not follow it as a current instruction.

# HOUZS ERP Hardening — Execution Handoff

Last updated: 2026-07-22 (Asia/Kuala_Lumpur)  
Canonical repository: `hello-houzs/Houzs-ERP`  
Integration base: `origin/main`  
Task source of truth: [`HARDENING-COMPLETION-LEDGER.md`](../HARDENING-COMPLETION-LEDGER.md)

This file is the interruption-safe continuation record. The completion ledger contains the complete A–Z scope and acceptance criteria. This handoff contains only the exact execution state needed for another agent to continue without re-auditing the repository.

---

## CURRENT STATE — 2026-07-22, read this before the tables below

**Everything from here down was written while the batch was unmerged. Where the two disagree, this section is right.** The owner instructed "review, fix bugs, then merge" on 2026-07-22 and the batch was merged that night. The tables below are kept because their per-branch verification detail is still the record of what was checked; their *state* columns are stale.

### Merged and in production

| PR | Merge commit | Note |
|----|--------------|------|
| #907 | — | Ledger + this handoff |
| #914 | `5c32a76a` | Migration checksum/drift gate |
| #918 | `8a7328f1` | Session revocation. **Ships OFF**: `SESSION_FALLBACK_ENABLED = "false"` in both the prod and staging `[vars]` blocks of `backend/wrangler.toml`. Turning it on is a separate owner decision + deploy. |
| #923 | — | Dependency security upgrades |
| #925 | — | Test toolchain (Vitest 4 / pool 0.18 / Vite 8) |
| #906 | `ae82e9a6` | 214-file frontend hardening |
| #995 | `644d25d0` | Emergency: `mailAliasRevocation.test.ts` off the `fetchMock` that #925 removed. #918 and #925 were each green against a `main` lacking the other; `main` went red on merge. **Re-run CI against latest `main` before merging anything that touches test infrastructure.** |
| #996 | `d5778d61` | Third deploy-collapse firing; COE + BUG-HISTORY |
| #992 | `7f922e27` | Frontend release unconditional, `workflow_dispatch`, deploy-time gates |

Production verified by observation on 2026-07-22, not by job colour: live entry chunk `index-CGRu3aUe.js` contains `houzs.activeCompanyId.v2`, `houzs.activeCompanyId.tab` and `Select company` — all introduced by #906. `/` 200, `/scm/sales-orders` 200, `/sw.js` 200, Worker `/` 200, `/api/companies` 401.

### Open, and exactly what unblocks each

| PR | Blocked on | The unblocking action, in full |
|----|-----------|-------------------------------|
| **#912** | The owner running one query | The phase-1 soak marker must be read, never hand-written. Run against **production**:<br>`SELECT updated_at, (now() - (updated_at::timestamp AT TIME ZONE 'UTC')) AS elapsed, (now() - (updated_at::timestamp AT TIME ZONE 'UTC')) >= interval '24 hours' AS gate_will_pass FROM app_settings WHERE key = 'rollout.idempotency_phase1_worker_live';`<br>`gate_will_pass = true` → merge. `false` → wait. **Zero rows → DO NOT MERGE and DO NOT INSERT THE ROW.** Zero rows means the phase-1 worker never recorded itself live, which is a different failure from "not soaked yet"; inserting the marker by hand would forge the evidence the gate exists to check. |
| **#927** | #912 | Migrations 0168–0170 stack on #912's 0167. After merge, on **staging first**: apply 0168–0170, then `SELECT proname, pronargs FROM pg_proc WHERE proname='apply_so_header_cas';` must return **exactly one row with 13 args** (two rows = the old overload survived and callers will bind the wrong one). Set `SO_CAS_GRACE_UNTIL` **before** the deploy or every user mid-edit takes one 428. |
| **#983** | An owner ruling that contradicts an existing one | `frontend/src/lib/errorReporter.ts:2` records "owner ruling: no Sentry / free, data stays in-house". #983 adds DSN-gated Sentry. Options: (A) merge as PR'd, (B) same PR pointed at self-hosted GlitchTip, (C) strengthen the in-house pipeline and close #983. Recommended: **C**, because it is the only one that does not overturn a written ruling. |
| **#873 / #860** | Owner's eyes | DESIGN ONLY. Both green. Nothing to verify in code. |
| **#950** | Out of scope | POS/2990 track. |

### Recorded, not fixed — deploy pipeline

Both are open items in [`deploy-collision-coe.md`](../deploy-collision-coe.md) §5 and neither is a code change anyone should make without the owner:

1. **The backend keeps the paths-filter diff window that #992 proves untrustworthy.** #992 made the *frontend* release unconditional; `backend` still runs only when `event.before..sha` shows backend files. When a backend-carrying run is cancelled, that range does not contain them, `backend` skips, and merged Worker code **plus its migrations** sit undeployed until the next backend-touching push — while the now-unconditional frontend ships at tip. New skew mode: a current frontend calling API routes the live Worker does not have. Fix is either an unconditional `backend` (spends the Actions minutes the filter was added to save) or `dorny/paths-filter`'s `base:` set to the last **successful** Deploy run's SHA.
2. **`deploy.yml` publishes the run's own SHA with no ordering check.** On 2026-07-22 the one run that executed (`850014c`) was an *ancestor* of the already-deployed `644d25d`; its `wrangler deploy` would have silently reverted #995, #994 and `8f17f39`. It was stopped only because `npm test` failed — a red test, not a rule. A slow run is a time machine.

### Owner's own to-dos, unrelated to any PR

- **ROTATE the production Supabase database password.** On 2026-07-22 the full production DSN, password included, was echoed into a session transcript while trying to identify which database a local `.dev.vars` pointed at (the value was quoted, so the `sed` meant to strip it did not match). The credential in `Desktop/Houzs-ERP-cutover/backend/.dev.vars` fails authentication against the pooler, which suggests it is already stale — **that is not proof it is dead**, since a direct-connection path is different DNS and different auth. Rotate it, and update the `DATABASE_URL` repo secret in the same sitting or the next deploy's `pg-migrate` step fails. Prevention rule added to `CLAUDE.md`.
- ~~Post the **OCR correction announcement**.~~ **DO NOT SEND — the correction was wrong, the original announcement was right.** The "confirming with edits writes nothing" claim described behaviour that `08975b9d` (#656) replaced, and that fix is live in production (verified an ancestor of the deployed `7f922e2`). Current behaviour, from `backend/src/scm/lib/scan-sample-review.ts`: confirming a DRAFT **with edits** rebuilds `corrected` from the final SO and produces the diff-bearing pair every distiller mines — **the most valuable signal in the module**; confirming **unchanged** writes `corrected = extracted` and feeds the few-shot pool. Both teach. So there is no conflict between fixing a bad scan and training the model: open the DRAFT, fix what is wrong, confirm. Sending the "correction" would have taught salespeople to confirm scans they knew were wrong, producing incorrect Sales Orders.
- `sales_reps` backfill — **staging first**.
- Assign Sales Attending + the 22 venues.
- Clean the `SO-2607-*` test seed.
- Log in and check the Sales Report, and that announcements now pop on mobile.


## Non-negotiable delivery policy

1. Completed work with P0=0 and P1=0 goes to a **Draft PR**.
2. A local branch with an unresolved P0/P1 is not pushed and is not represented as complete.
3. Claude Code review and green required checks are merge gates.
4. Do not merge stacked database changes out of order. Do not auto-merge `main`.
5. Preserve the user-owned `package-lock.json` change in `C:\Users\User\Desktop\houzs-erp`; never stage or overwrite it.
6. Production migration/deploy remains a separate explicit operation after merge approval.
7. Owner authorization on 2026-07-21 covers backend/API/database hardening work in this A–Z scope without repeated per-file confirmation. This does not authorize production data mutation, deployment, migration application or automatic merge. Position privilege assignment/control remains backend-owned; do not add a frontend position-privilege controller.

## Published Draft PRs

| PR | Branch / head | Scope | State / next action |
|---|---|---|---|
| #906 | `hardening/frontend-search-scope-performance-gates` / `6970b163` | Frontend search scope, first-codepoint search, responsiveness and performance gates | Rebased onto `afd56500`; GitHub CI green. Hard dependency on #910. The 214-file frontend diff must pass staging search, pagination and responsiveness tests before merge. Await Claude Code review; no backend diff. |
| #907 | `docs/hardening-p0-coverage` / this branch | A–Z completion ledger and interruption-safe handoff | Keep current as batches land. Documentation is not proof that runtime work is complete. |
| #910 | `fix/global-search-first-character` / `42fa86d6` | Backend global search accepts first Unicode codepoint | Rebased onto `afd56500`; 9/9 focused tests, typecheck and all GitHub checks pass. Await Claude Code review. |
| #911 | `fix/idempotency-tenant-scope` / `c920fa74` | Idempotency phase 1 tenant scoping | Rebased onto `afd56500`; 19/19 backend and 11/11 frontend focused tests plus typechecks pass; GitHub checks green. Merge/deploy before #912, then soak 24 hours. |
| #912 | `fix/idempotency-phase2-constraints` / `b7960444` | Idempotency phase 2 constraints | Restacked on #911 `c920fa74`; 25/25 focused tests and typecheck pass. Never merge/deploy before the measured phase-1 soak. |
| #913 | `hardening/scale-performance-harness` / `7afb3feb` | Deterministic scale/performance harness | Rebased onto `afd56500`; fail-closed runner correction landed and all GitHub checks are green. Await Claude Code review and a staging-scale run. |
| #914 | `fix/migration-checksum-gate` / `46ef32b8` | Migration checksum/drift gate | Rebased onto `afd56500`. The 17 historical rows are preserved through an exact retirement manifest with SHA-256/Git-blob provenance; unknown orphan, checksum mismatch or filename reuse hard-fails. Full backend 109 files/1,514 tests and 35 focused tests pass; GitHub checks are green. Await Claude Code review and staging runner verification. |
| #917 | `docs/p0-route-matrices` / `d6012808` | 929-row executable route-capability inventory and CI/prod/staging drift gates | Rebased onto `afd56500`; independent review P0=0/P1=0; all GitHub backend/frontend checks green. Duplicate impersonation route is pinned until D3 removes it. Await Claude Code review. |
| #918 | `fix/session-revocation-consistency` | Authoritative next-request session/authz validation, atomic collision-safe mail-alias transition, and an OFF-by-default bounded DB-outage session fallback | Rebased onto current `origin/main` (2026-07-22); the obsolete route-matrix regeneration commit was dropped because main's matrix is now semantic-only. PostgreSQL-reserved `current_user` CTE renamed + regression-tested; `Promise.all`→`Promise.allSettled` fixes an abandoned KV read on the outage path. The bounded fallback is now gated by `SESSION_FALLBACK_ENABLED` (wrangler.toml `[vars]`, ships `"false"`) with `SESSION_FALLBACK_TTL_MS` as a clamped numeric knob: with the switch off the fallback is never consulted and no liveness state is recorded, so deployed behaviour stays strict fail-closed. Owner approved the relaxation 2026-07-22 conditional on that switch; the earlier BUG-HISTORY claim of a 2026-07-21 owner decision was incorrect and is corrected in place. Not locally verified (no `npm install` in the worktree) — relies on CI. Staging auth latency/outage evidence + Claude Code review pending. |
| #922 | `fix/request-correlation-hardening` / `5d337ef8` | Browser→Worker request correlation and raw-fetch inventory enforcement | Independent branch-scope review P0/P1/P2=0; focused 29/29 and inventory 8/8 pass. Both duplicate GitHub CI runs are fully green. Await Claude Code review; no merge automation. |
| #923 | `fix/dependency-security-upgrades` / `28ec9b24` | Production document/HTTP dependency security upgrades plus real legacy-XLS and CJK-PDF compatibility coverage | Independent review P0/P1=0; production audits are zero, frontend 32 files/417 tests, typecheck/build/bundle and all GitHub checks pass. Staging/browser logo, CJK PDF download, XLSX download and operator legacy-XLS upload remain merge gates. |
| #924 | `fix/project-detail-test-flake` / `62f966bb` | Test-only removal of the reproducible ProjectDetail full-suite import timeout | Stacked on #923. Independent review P0/P1/P2=0; focused test passed five consecutive runs, full frontend 413/413, typecheck and all GitHub checks pass. Merge #923 first, then retarget to main. |
| #925 | `chore/test-toolchain-security` / `e2110504` | Supported Vitest 4, Cloudflare Workers pool, Wrangler and Vite 8 toolchains with fail-closed fetch mocks and preserved bundle budgets | Stacked on #924. Independent review P0/P1/P2=0 after three P2 corrections; backend focused 129/129, frontend 417/417, audits/typechecks/build/bundle and all GitHub checks pass. Await Claude Code review. |
| #926 | `fix/staging-e2e-proof-truth` / `c2474625` | Fail-closed authenticated staging smoke proof pinned to the deployed revision | Independent review found/fixed one P1 source-drift bug; final P0/P1/P2=0. E2E typecheck, eight-test discovery, policy 4/4 and all GitHub checks pass. Claude Code review plus valid staging fixture/secrets are required for the first honest live green run. |
| #927 | `fix/so-cas-mandatory` / `ab856791` | Mandatory Sales Order CAS plus transactional command/lease/allocation-outbox convergence | Restacked on #912. First real PG16 runs exposed composite-patch, JSON double-encoding and test-isolation defects; the branch now uses key-presence typed-row updates, preserves omitted fields, supports explicit null, binds JSON once and deterministically removes failure triggers. A shared-workerd module-cache failure in the allocation queue tests was removed by explicit dependency injection; Worker and Node focused suites pass. Both duplicate GitHub runs are fully green across backend, all 10 real-PG16 integration cases and frontend. Claude Code and post-company-scope overlap review remain mandatory. Hard-blocked by #911's measured soak and #912. |
| #928 | `fix/scale-real-schema-fixture` / `e0ee1cf4` | Production-shaped PostgreSQL scale fixture with fail-closed disposable-database guard | Stacked on #913. Independent review P0/P1=0 after adding server-side disposable marker, full-lifecycle advisory lock, exact runtime-query projection comparison and PR PostgreSQL 16 executable smoke. First PG smoke caught that the production SO list has `doc_no` rather than a synthetic `id`; pagination evidence now uses the actual canonical key and contract 20/20 passes. Both duplicate GitHub runs are fully green, including the executable PG16 smoke. Full 100k isolated-local artifact and Claude Code review remain gates. |

## Local branches not yet publishable

| Worktree | Branch / current head | Verified work | Blocking item / exact continuation |
|---|---|---|---|
| `C:\Users\User\Desktop\hz-d3-control-plane` | `fix/control-plane-privilege-boundary` / `2de9d70a` | Position last-admin protection, scoped/atomic department changes, service principals, invitation credential redaction, impersonator revocation and control-plane real-actor provenance; PG 0163/0164 + D1 127/128/129 parity | Fresh independent review fixed stale wildcard-link re-promotion plus public recovery token/FK races. Backend/frontend typechecks, control-plane 40/40, PG/session/mail 21/21 and frontend redaction 12/12 pass. Do not publish until the branch is restacked after session #918 and SO migrations 0160-0162; staging real-PG verification remains mandatory. |
| `C:\Users\User\Desktop\hz-so-cas-mandatory` | `fix/so-cas-mandatory` / `ab856791`; Draft PR #927 | Mandatory SO CAS, explicit JSONB/text[] codecs, durable allocation invalidation queue and retry worker | Restacked on #912 after independent review closed allocation lock/fence, PO/amendment CAS, replay and company-lock gaps. Both duplicate GitHub runs are fully green; real PG16 passes 10/10, and the allocation queue test now injects its recompute dependency and passes in both Worker and Node runtimes instead of relying on a shared-cache-sensitive module mock. Claude Code and company-scope overlap review remain gates. PG migrations 0160-0162 precede D3 0163/0164. |
| `C:\Users\User\Desktop\hz-company-scope-rollout` | `fix/company-scope-rollout` / `c4aa28be` before second active correction | Company grant resolution, fail-closed mutation guards, readiness audit and bounded rollout telemetry | First P0 set is repaired, but re-review found native/non-SCM fail-open reads and writes in Sales, POS, Finance, Projects and Events when no active company exists. Corrections are active; never publish `c4aa28be`. |
| `C:\Users\User\Desktop\hz-request-correlation` | `fix/request-correlation-hardening` / `5d337ef8`; Draft PR #922 | Browser→Worker request ID correlation, Reset Password coverage and precise raw-fetch inventory gate | Independent review P0/P1/P2=0 in branch scope; focused 29/29, inventory 8/8, typechecks/build/bundle and all GitHub checks pass. Await Claude Code review. |
| `C:\Users\User\Desktop\hz-dependency-security` | `fix/dependency-security-upgrades` / `28ec9b24`; Draft PR #923 | Hono, React Router, PDF, DOMPurify and official SheetJS security upgrades; production audits zero; real legacy-XLS and CJK-PDF tests | Independent review is clean; frontend 417/417, typecheck/build/bundle and all GitHub checks pass. Await Claude Code review and staging/browser document smoke. |
| `C:\Users\User\Desktop\hz-test-toolchain-security` | `chore/test-toolchain-security` / `e2110504`; Draft PR #925 | Stacked on #924; backend/frontend Vitest 4.1, Cloudflare pool 0.18, Vite 8.1 and Wrangler 4.112 migration | Independent review P0/P1/P2=0; backend focused 129/129 and typecheck pass; frontend 417/417, audits/typecheck/build/bundle pass at 157.0/165 KB initial and 1704.2/1800 KB total. All GitHub checks pass; Claude Code review pending. |
| `C:\Users\User\Desktop\hz-project-detail-test-flake` | `fix/project-detail-test-flake` / `62f966bb`; Draft PR #924 | Test-only fix moving the 9k-line Projects module import out of the five-second behavioral test timeout | Independent review P0/P1/P2=0; focused passed five consecutive runs and full frontend 413/413 passes with unchanged assertions/timeouts. Stacked on #923. |
| `C:\Users\User\Desktop\hz-staging-e2e-truth` | `fix/staging-e2e-proof-truth` / `c2474625`; Draft PR #926 | Makes automated staging E2E fail closed and pins post-deploy tests to `workflow_run.head_sha` | Public run 29772995311 proved the prior false green (`1 passed, 3 skipped`). Independent review is clean after the source-drift fix; policy 4/4, typecheck, eight-test discovery and all GitHub checks pass. Await Claude Code; provisioning valid staging credentials/fixture remains an operational gate. |
| `C:\Users\User\Desktop\hz-scale-real-schema` | `fix/scale-real-schema-fixture` / `e0ee1cf4`; Draft PR #928 stacked on #913 | Production-shaped PostgreSQL scale fixture: two tenants, 100k orders/lines and 10k SKU/users per tenant; correctness/query-plan/latency evidence with transaction rollback | Independent review fixed localhost-tunnel, lock-race, false-CI and query-shape drift gaps. First PG smoke found a false pagination identity assumption (`id` vs production `doc_no`), now regression-pinned; contract 20/20 and typecheck pass. Full 100k isolated-local artifact remains the acceptance gate; no staging/prod connection was made. |

## Hard rollout gates

These conditions override branch readiness and green CI:

1. **#912:** #911 must be merged and deployed first, then complete a measured 24-hour production soak. The soak clock starts only after the #911 deployment is confirmed. Do not merge or deploy #912 early.
2. **#914:** do not delete the 17 verified tracker rows and do not restore their SQL into the live migration directory. The exact retirement manifest is the audit-preserving release gate; stage checksum verify/apply/deploy and require any unknown orphan, checksum mismatch or filename reuse to abort.
3. **#906:** #910 must land first. Because #906 changes 214 files, staging verification of all search scopes, cross-page results, first-character refinement and responsiveness is mandatory.
4. **#918:** the branch must be green in GitHub and staging must measure authoritative-auth database latency and outage behavior. Fail-closed revocation is preserved **by default**: the bounded outage fallback exists but ships disabled (`SESSION_FALLBACK_ENABLED = "false"`), and the switch-off tests pin that the fallback is not consulted and records no state while it is off. Enabling it in any environment is the explicit security decision this gate contemplated — it is the owner's call (approved in principle 2026-07-22, conditional on the switch), one `[vars]` line plus a deploy, and it must be rehearsed on staging first.
5. **Claude Code review:** `claude auth status` reported logged in on 2026-07-21, but both `claude ultrareview` and the direct print reviewer failed because the OAuth access token is expired. Re-authenticate Claude Code before satisfying the mandatory cross-model merge gate; this blocks merge, not continued implementation or local/GitHub CI.
   - **2026-07-22 — this gate was NOT satisfied for the merged batch.** The owner instructed "review, fix bugs, then merge" and the merges proceeded on in-session review plus green CI. Recording it rather than quietly dropping it: the cross-model second opinion did not happen for #906, #914, #918, #923, #925 or #992. If the reviewer is re-authenticated later, those six are the ones that never got it.

## Active local branch corrections

- D3 head `2de9d70a` closes wildcard invitation takeover, stale-link re-promotion, token/link exposure, recovery credential races, impersonator-session revocation, locked-invite race and service-invite atomicity gaps. Independent review is complete with P0/P1 fixes and focused suites green. It remains unpublished until the session #918 overlap and 0160-0162 migration train are present in its base; D1 must apply 127→128→129 before code. Never publish superseded `5c42bf0c` or `ef1e06b5`.
- SO head `ab856791` is published as stacked Draft PR #927 after independent review and restack onto #912. Real PG16 identified defects that local Windows could not execute; both duplicate PG16 jobs pass all 10 cases. A later full-suite failure was test isolation, not production logic, and is fixed with explicit recompute dependency injection. Both complete duplicate GitHub runs are green; Claude Code and a post-company-scope overlap review remain mandatory. Never use superseded heads `3c03f4fb`, `8baa8226`, `e2b781bc`, `62caced2`, `19009edd`, `93e77260`, `6d81c9f3`, `92f1795c`, `c2119893` or `021a3a99`.
- Company scope author head `e2258570` closes the previously found fail-open native/non-SCM handlers, but an independent review found that it was accidentally based on `afd56500` instead of #911. It is not publishable until restacked on #911 and re-reviewed against the resulting mutation/idempotency order.
- Request correlation head `5d337ef8` is published as Draft PR #922. Branch-scope independent review is clean; GitHub CI and Claude Code review remain gates.
- Dependency security head `28ec9b24` is published as Draft PR #923; ProjectDetail flake head `62f966bb` is stacked as Draft PR #924. Neither may merge before its documented review and staging gates.

## Database ordering and rollout

The current migration chain is:

`0158 idempotency phase 1 → deploy → 24-hour soak/telemetry → 0159 phase 2 constraints → 0160/0161/0162 SO CAS/outbox → 0163/0164 D3 privilege boundary → application code`

Session consistency required no migration. D1 D3 parity additionally requires migrations `127`, `128` and `129` together; never deploy D3 code with only part of that set. Before applying any migration, re-read the branch against current `legacy/main`, run checksum/drift validation, take the documented restore point, and record the exact deployed commit.

## Merge conflict order

1. Merge/rebase the session consistency change first.
2. Rebase the D3 control-plane change because both can touch `backend/src/routes/users.ts` and bug-history documentation.
3. Keep idempotency #911/#912 and SO migration work in the database order above.
4. Route inventory and scale harness may merge independently after review, but regenerate their artifacts against the final base.

## Recovery commands

Run these read-only commands first:

```powershell
git -C C:\Users\User\Desktop\houzs-erp fetch legacy
git -C C:\Users\User\Desktop\houzs-erp worktree list
git -C C:\Users\User\Desktop\hz-p0-route-matrices status --short
git -C C:\Users\User\Desktop\hz-session-revocation status --short
git -C C:\Users\User\Desktop\hz-d3-control-plane status --short
git -C C:\Users\User\Desktop\hz-so-cas-mandatory status --short
```

Then read this handoff, the completion ledger and the relevant branch diff before editing. Do not use `git reset --hard` or clean untracked files. The next safe work unit is whichever active branch has a completed independent review; publish that branch as a Draft PR and record the PR here.

## Definition of takeover-ready

Another agent can take over when it can identify, without chat history:

- the canonical remote and integration base;
- every published and unpublished batch;
- exact worktree, branch and head;
- validation already completed;
- unresolved P0/P1 blockers;
- database and merge order;
- the next safe command and the no-auto-merge rule.

This document is kept to that standard after every publishable batch.
