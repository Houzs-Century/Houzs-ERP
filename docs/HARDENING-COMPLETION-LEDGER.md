# HOUZS ERP Hardening — A–Z Completion Ledger

Baseline: `hello-houzs/Houzs-ERP@f4807a0a`  
Policy: a batch being merged does **not** complete a workstream. An item is `DONE` only when its acceptance evidence, test/trace, commit and completion date are recorded here.

Status: `DONE` = fully accepted; `PARTIAL` = useful foundation exists but acceptance is incomplete; `OPEN` = not implemented; `STALE` = the old prescription is unsafe/outdated and must use the replacement acceptance below.

Change classes: `FE` frontend-only; `INFRA` CI/deploy/testing; `AUDIT` read-only; `BE★` backend/API/database/migration/permission; `HYBRID★` mixed frontend/backend. The owner granted implementation approval for the complete A–Z hardening scope on 2026-07-21, so repeated per-file approval is not required. Production data mutation, deployment, applying migrations and merging remain separate gated operations.

## Execution order

`B00 truth/gates → B01 search UX → B02 frontend performance → B03★ server list/search → B04★ write reliability → B05★ concurrency/CAS → B06★ authorization/company scope → B07 CI/deploy/observability → B08★ snapshots/state machines → B09★ inventory/manufacturing lifecycle`

## Phase 0 — truth and gates

| ID | Status | Class | Batch | Completion acceptance |
|---|---|---|---|---|
| HZ-P0-01 Performance baseline | PARTIAL | INFRA | B00 | Repeatable traces for 8 heavy pages + mobile: cold/warm interaction, keystroke→paint, API p95, long tasks, DOM and bytes, with fixed scale and before numbers. |
| HZ-P0-02 Current coverage matrix | PARTIAL | AUDIT | B00 | Route×capability, list×search mode, table×mutation, localStorage key and snapshot-source matrix; each has file:line, owner, state and last verified hash. |
| HZ-P0-03 Minimum observability | PARTIAL | HYBRID★ | B07 | Frontend route/API/save/long-task/network metrics plus backend rows/bytes/role-safe fields; one no-PII “user reports slow → correlated trace” drill. |
| HZ-P0-04 Scale dataset | OPEN | INFRA | B00 | Rebuildable non-production dataset matching production PG: 100k order/line and 10k SKU/user scale, with hard prod-connect guard. D1 only where compatibility is still supported. |
| HZ-P0-05 Version foundation | STALE | AUDIT→BE★ | B05★ | Replace blanket version columns with table×write×API×caller classification. CAS only for collaboratively mutable rows; existing SO CAS becomes mandatory with two-writer 409 tests. |

## WS-A — frontend performance

| ID | Status | Class | Batch | Completion acceptance |
|---|---|---|---|---|
| HZ-A-01 List rendering | PARTIAL | FE | B02 | Inventory existing windowing first; only measured DOM/long-task offenders get fixed. Mobile cards, grouped/expanded/editor paths, print/export completeness and a11y are explicitly tested. |
| HZ-A-02 Stable row props | PARTIAL | FE | B02 | Profiler evidence on actual hotspots; single-row edits rerender only the changed row/summary, with render-count regression tests. |
| HZ-A-03 localStorage truth | PARTIAL | AUDIT→HYBRID★ | B02 | Every key classified auth/UI/cache/draft/business truth; zero business records exist only in browser; cache isolated by user+company+build with size cap; no >50ms hot-path sync write. |
| HZ-A-04 Search responsiveness | PARTIAL | FE | B01 | Every server search: first-key feedback, A cannot masquerade as A1, clear/reset consistency, stale actions blocked, keystroke within one frame. |
| HZ-A-05 Calendar/aggregate hotspots | PARTIAL | HYBRID★ | B02 | Only trace-proven hotspots changed; Service Cases/Projects calendars and Dashboard have no >200ms long task. Backend aggregation is separately approved. |

## WS-B — search and list contracts

| ID | Status | Class | Batch | Completion acceptance |
|---|---|---|---|---|
| HZ-B-01 Full server search | PARTIAL | BE★ | B03★ | Field/ranking/index matrix; exact→prefix→contains ordering, match reason, stable cursor/page, company/record scope, SO line items; 100k p95 ≤500ms. One-character policy follows query-plan evidence. |
| HZ-B-02 Shared search contract | PARTIAL | FE/HYBRID★ | B01/B03★ | Shared contract covers q/filter/sort/page, URL, cancellation/generation, loading/empty/error/offline/conflict, Searching/clear/keyboard. Desktop/mobile may use different components. |
| HZ-B-03 Surface rollout | PARTIAL | HYBRID★ | B01/B03★ | Every major list labelled `SERVER_ALL`, `CLIENT_ALL`, `CLIENT_CAPPED` or `NONE`; cross-page search, page reset and stale-race tests pass. |

## WS-C — write correctness

| ID | Status | Class | Batch | Completion acceptance |
|---|---|---|---|---|
| HZ-C-01 Mutation UX/contract | PARTIAL | HYBRID★ | B04★ | Critical writes check HTTP failure; rollback/retain draft/retry; explicit Saving/Saved/Failed/Outdated. Payments have durable pending/outbox design. |
| HZ-C-02 CAS rollout | PARTIAL | BE★ | B05★ | Risk-ordered rollout: mandatory SO header then payments/events/SKU/settings/high-contention SCM; expectedVersion + 409 + preserved input; no CAS on append-only/derived tables. |
| HZ-C-03 Idempotency + UNIQUE | PARTIAL | BE★ | B04★ | Mutation inventory records key/scope/TTL/replay/DB backstop. Retried payment/order/receipt/issue/import writes exactly once. |
| HZ-C-04 Document numbering | PARTIAL | BE★ | B04★ | Every document family uses transactional DB-safe allocation + UNIQUE; no client/app max+1; concurrency test has zero collisions. |
| HZ-C-05 Multi-step atomicity | PARTIAL | BE★ | B04★ | Header+lines+payments, cascade/reparent and inventory reversal inventory; transaction/RPC or outbox/saga; failure injection leaves no half-save/ghost stock. |
| HZ-C-06 Snapshot drift | PARTIAL | AUDIT→BE★ | B08★ | Field×source×copy×cascade×audit×test matrix distinguishes legal history snapshots from mirrors that must update. |
| HZ-C-07 State machines | PARTIAL | BE★ | B08★ | Legal transitions/guards/side effects/reversals per document; normal PATCH cannot change state; completed/cancelled records reject ordinary edit; illegal-transition tests. |
| HZ-C-08 Audit before/after | PARTIAL | BE★ | B04/B06★ | Route×mutation coverage; actor only from session; redacted before/after; alert/DLQ/replay policy; explicit fail-closed list for high-risk writes. |

## WS-D — authorization and tenancy

| ID | Status | Class | Batch | Completion acceptance |
|---|---|---|---|---|
| HZ-D-01 Capability default-deny | PARTIAL | AUDIT→BE★ | B06★ | 100% route×method×capability×scope matrix; no mutating login-only route; undeclared new route fails CI; public-token exceptions listed. |
| HZ-D-02 Record/company scope | PARTIAL | BE★ | B06★ | Grants backfilled/validated, global vs per-company classified, legacy fail-open removed in stages, service-role reads/writes/search/aggregates scoped, cross-company leak tests zero. |
| HZ-D-03 Privilege/position | PARTIAL | BE★ | B06★ | Position stays on owner-approved backend path; ordinary UI/API cannot grant it; target/cannot-grant-above-self/self-peer/high-role deletion guards; actor session-only. |
| HZ-D-04 Permission matrix tests | PARTIAL | INFRA+BE★ | B06/B07 | Generated role/position×endpoint×method×company/record fixtures; 401/403/404/200 negative-first tests required; undeclared route fails CI. |
| HZ-D-05 Enumeration safety | PARTIAL | BE★ | B06★ | Unified external 401/403/404 shape; existence cannot be probed; no permission key/SQL/PII; search metadata scoped first. |
| HZ-D-06 Session revocation | PARTIAL | BE maintenance | Gate | Preserve server session + user status/expiry checks and immediate disable/delete/logout regression; invalidate changed authz identity immediately; alias/mailbox transition must be atomic and collision-safe. |

## WS-E — infrastructure and deployment

| ID | Status | Class | Batch | Completion acceptance |
|---|---|---|---|---|
| HZ-E-01 DB architecture parity | STALE | AUDIT/INFRA★ | B00/B07 | Document production PG truth and D1 compatibility/test/fallback boundary; parity only for supported contracts; remove obsolete blanket dual-schema claims. |
| HZ-E-02 Migration gate | PARTIAL | INFRA | B07 | Staging/prod apply only unapplied migrations with checksum/drift check; failure blocks; paused-DB flow resolved; restore/rollback runbook drilled. |
| HZ-E-03 Required CI | PARTIAL | INFRA | B07 | PR requires backend+frontend typecheck/test/build and a stable core e2e subset; flaky tests quarantined with owner/SLA; backend diffs require matrix tests. |
| HZ-E-04 SW/redeploy safety | PARTIAL | FE+INFRA | B07 | Old shell/new chunks, offline→online, forced refresh and version mismatch automated; no white screen/stale chunk; rollback/cache purge runbook. |
| HZ-E-05 Smoke/canary | PARTIAL | INFRA | B07 | Post-deploy safe-tenant read/write smoke, error rate/p95/console canary; failure blocks promotion or triggers explicit rollback/alert. |
| HZ-E-06 Telemetry correlation | PARTIAL | INFRA+HYBRID★ | B07 | Request-id client→worker→DB/error/audit; route/time/user-safe lookup; sampling/retention/PII rules; real incident drill. |

## WS-F — tests and regression gates

| ID | Status | Class | Batch | Completion acceptance |
|---|---|---|---|---|
| HZ-F-01 API integration | PARTIAL | INFRA+BE★ | Per batch | Risk-driven auth/scope/search/page/CAS/idempotency/malformed/atomic-failure coverage recorded in route matrix. |
| HZ-F-02 Frontend data hooks | PARTIAL | FE | B01/B04 | Rollback, placeholder stale, A→A1, cancellation/generation, offline, duplicate click and conflict input preservation tests; Mobile Mail stale append covered. |
| HZ-F-03 Performance budgets | PARTIAL | INFRA | B02/B07 | Stable CI budgets for mounted DOM/window rows, bundle/request bytes and repeatable API/long-task lab; no flaky shared-CI wall-clock assertion. |
| HZ-F-04 Core e2e | PARTIAL | INFRA | B07 | Login→SO search/create/edit/save/refresh; delivery/return/payment; company isolation; field/mobile; rebuildable fixtures; stable subset required. |
| HZ-F-05 Regression rule | PARTIAL | INFRA | B07 | Bug fix links test or written waiver; BUG-HISTORY maps test ID; high-risk untested diffs cannot merge. |

## WS-G — inventory and manufacturing future-proofing

| ID | Status | Class | Batch | Completion acceptance |
|---|---|---|---|---|
| HZ-G-01 Ledger/lifecycle unification | STALE | AUDIT→BE★ | B09★ | Inventory existing movements/reservations/returns/consignment/reversals first; define one movement taxonomy with idempotency/reversalOf/effectiveAt/company/document; balance projection rebuilds/reconciles; posted rows immutable; then BOM revision pinning, cycle detection, partial completion and backdate/timezone. Never create a second parallel ledger. |

## Evidence log

| Date | Batch | Evidence | Result |
|---|---|---|---|
| 2026-07-20 | B01 first frontend batch | `bdd0ebb8`; frontend typecheck/build; 32 files / 408 tests | Awaiting real Claude Code review before merge. Backend diff: 0. |
| 2026-07-20 | B01 search-consistency batch | `8e6b1161`; typecheck/build; 34 files / 413 tests | Independent review: P0=0, P1=0. Awaiting Claude Code review before merge. Backend diff: 0. |
| 2026-07-20 | B01 search scope/cancellation/windowing | `92a0949c`; 39 files / 430 tests; build + bundle | Server-vs-loaded scope rendered; A→A1 cancellation reaches network/retry; 10k tail tests. Backend diff: 0. |
| 2026-07-20 | B07 frontend release gates | `48171872`; CI source/build/bundle/SW/E2E discovery; exact-build deploy smoke | Frontend release consistency is executable. Merge still requires owner confirmation because existing deploy workflows may redeploy unchanged backend. Backend code/schema diff: 0. |
| 2026-07-20 | B02 frontend hot paths/cache isolation | `e9a0c858`; 42 files / 447 tests; build 2,475 modules; initial 160.3/165.0 KB gzip; total 1,781.0/1,800.0 KB gzip; SW + smoke pass | Independent review P0=0/P1=0. Idle snapshot, tenant/session isolation, DataTable resize lifecycle, Projects Calendar memo/RAF/date boundaries and 10k structural tests. Backend diff: 0. |
| 2026-07-20 | B02 mobile list/route/browser gate | `7f8c0013`; 42 files / 485 tests; build 2,475 modules; initial 160.4/165.0 KB gzip; total 1,781.4/1,800.0 KB gzip; SW + smoke; Chromium 5/5 | DataTable/DataGrid/mobile variable-height 10k geometry, A→A1 pending presentation, query-aware mobile route permissions and all 31 aliases. Independent review P0=0/P2=0; deploy-workflow integration remains owner-approval pending. Backend code/schema/runtime diff: 0. |
| 2026-07-20 | B07 executable route contracts | `9e8c0da9`; 131 executable routes (123 staff + 7 public + `/roles` redirect); 71 desktop nav nodes, 37 mobile destinations and all 31 aliases; focused 142/142 + typecheck | Desktop/public/mobile manifests, query/hash-preserving aliases, malformed-URI handling and known desktop-only mobile destinations are drift-tested. Independent review P0=0/P1=0. Backend code/schema/runtime diff: 0. |
| 2026-07-20 | B02 browser identity/storage isolation | `817a98f8`; targeted review suites 104/104 and final root rerun 101/101; typecheck | Auth/company identity, query snapshots, mail drafts, SCM handoffs and table/grid layouts are scoped or quarantined; corrupt/expired/wrong-scope state fails closed. Independent review P0=0/P1=0. Backend code/schema/runtime diff: 0. |
| 2026-07-20 | B01/B02 preference isolation + capped-search follow-up | `35a12831`; 61 files / 596 tests; build 2,488 modules; initial 162.4/165.0 KB gzip; total 1,786.0/1,800.0 KB gzip; SW + smoke; Chromium 5/5; final focused notification test 8/8 + typecheck | Identity-scoped UI preferences replace ownerless keys across Projects, Service Cases, Team, Settings, Sidebar, mail, launcher and notifications; cross-tab changes including storage clear synchronize and corrupt values reset safely. Client-capped SCM surfaces disclose their exact 300/500/1,000-row search boundary without implying all-page coverage. Independent review P0=0/P1=0/P2=0. Backend code/schema/runtime diff: 0. |
| 2026-07-20 | B01/B02 async list + bulk follow-up | `54b804be`; 63 files / 611 tests; typecheck + build; initial 162.5/165.0 KB gzip; total 1,788.3/1,800.0 KB gzip; SW + smoke | Project Chat retries and isolates request generations; Inventory hides stale term/category placeholders and discloses the lot-row cap; remaining desktop/mobile search boundaries are executable; Team bulk requests are concurrency-bounded and re-entry guarded; mobile language survives storage failure and cross-tab changes. Independent review P0=0/P1=0/P2=0. Backend code/schema/runtime diff: 0. |
| 2026-07-20 | B01/B02 payment retry + browser recovery close-out | `bcbeebc1`, `d6837d06`; baseline 66 files / 650 tests plus recovery-contract 4/4 and isolated timeout rerun 32/32; typecheck + build 2,490 modules; initial 162.9/165.0 KB gzip; total 1,792.5/1,800.0 KB gzip; largest chunk 429.5/600 KB; emitted SW + focused-test gate + exact-build smoke 2/2 | SO/SI payments are durably staged before send, isolated per user/company/document/intent and expire before backend idempotency retention; created-document retries cannot duplicate documents, trap empty intents or accept misleading non-payment edits. Mail/storage/RouteFallback recovery is bounded and tested. Independent review P0=0/P1=0. Backend code/schema/runtime and workflow diff: 0. |
| 2026-07-20 | Active backend/infra batches | Draft PRs `#910`–`#914`; unpublished route matrix `36b932ac`, session `ab9c0039`, D3 `28229982`, SO CAS `92167619` | Exact review blockers, migration order, worktrees and continuation commands are maintained in `archive/HARDENING-EXECUTION-HANDOFF.md` (archived 2026-08-13 — that batch merged; this ledger is the live status). Nothing with an unresolved P0/P1 is marked complete. |

## Mandatory close-out rules

1. Every row needs owner, commit/PR, evidence, completion date and verified baseline hash before `DONE`.
2. `STALE` means use the replacement acceptance above; the superseded wording is not an implementation ticket.
3. The 2026-07-21 owner authorization covers `BE★` and backend portions of `HYBRID★` within this ledger. Every backend batch must still record exact files/contracts, reason, impact, migration/rollback and tests in its PR; production data mutation/deployment/migration application/merge remains separately gated. Position privilege assignment and control stays backend-owned.
4. Existing correct infrastructure is maintained, not rebuilt. A batch may close while its workstream remains open.
5. Claude Code review is a merge gate. Authentication failure pauses merge, not frontend/infra implementation.
