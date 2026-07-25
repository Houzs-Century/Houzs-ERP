# Agent Platform Buildout — status + build-ready specs

_Snapshot of the "bring Houzs's agent platform to parity with Hookka + build the trainable PO agent" effort. Written 2026-07-25. Branch `feat/production-po-agent` (worktree `houzs-work-worktrees/po-agent`). This doc exists so the detailed build specs survive a context compaction — execute from here._

## The premise (verified against both repos)

Houzs's agent framework was ported FROM Hookka (see `services/agent-console.ts` header, owner OK 2026-07-13) and then generalized. Houzs is **ahead** of Hookka on 7 of 10 platform capabilities (generic `registerAgent`, generic config-rule whitelist, stale-run reaper, executable `governance.ts` matrix, finer kill-scopes, decision/outcome ledgers, per-company scoping, a deeper procurement learner). **"Copy Hookka wholesale" would REGRESS us.** Only three real gaps:

1. **Teach-in-chat** — DONE (task #27).
2. **Stored 3-position autonomy dial** — spec ready (task #31, below).
3. **Assistant tool-loop** (the owner's "search / 查找" capability) — DONE (task #32): `search_erp` on a reusable tool-use engine.

## Design decisions (locked with the owner)

- **A2A**: specialist agents communicate via **typed hand-offs** (`operating-spec §2`), never free-form. Facts (ETA, ready-date, stock) = deterministic cross-module **tool calls** (each domain exposes e.g. `procurement.estimateReadyDate`); decisions/actions (expedite, rush) = an A2A **request + approval gate**. Top-level **orchestrator = Group Chief Operating Agent (GCOA)**, already spec'd `operating-spec §9.3`. Not a mesh. (task #34)
- **Autonomy = a stored per-agent stage (1/2/3) with a per-agent CEILING.** `CS`, `COLLECTION`, `PROCUREMENT` are permanently capped at Stage 2 (never full-auto: external comms / ledger+dunning / supplier money). Big-ERP research + Hookka both confirm staged autonomy + human-in-loop is the industry norm.
- **PO agent's 4 business phases map onto the 3 autonomy stages**: P1 draft = S1; P2 request lead-time = S1 (+ lead-time buffer as an S2 CONFIG_TUNING param); P3 auto lead-time+date = S2 (DRAFT PO only); **P4 full-auto+send = S3, above the ceiling — deliberately unreachable** without an owner migration AND a new supplier-send path the two-gate design withholds.
- **Chat teaching teaches JUDGMENT** (`agent_feedback` notebook, injected into brains via `activeInstructions`); **MATH corrections go through config proposals** so deterministic engines stay deterministic.

## Status

| Task | State | Notes |
|---|---|---|
| #27 teach-in-chat backend | **DONE, verified** | 14 unit tests + backend typecheck clean; `operating-spec §2.1` added |
| #28 floating chat widget | **DONE, verified (desktop + mobile)** | frontend typecheck + `npm run build` clean |
| #29 chat history | **DONE, verified** (backend + history-list UI, desktop + mobile) | migration 0198 + `assistant-history.ts` + 3 endpoints + hook threading + list UI |
| #30 file upload (img/PDF) | **DONE, verified** | `vision-blocks.ts` + agent-brain contentBlocks + assistant file path + `/chat` multipart + attach UI both surfaces; video rejected |
| #31 autonomy dial | **DONE, verified** | migration 0199 (stage + max_stage) + `effectiveStage` + callers + `/gate` stage + `Agents.tsx` S1/S2/S3; 47 governance/teach tests pass |
| #32 assistant tool-loop | **DONE, verified** | `search_erp` tool + reusable `askAgentBrainWithTools` engine; 16 new unit tests, `agentGovernance`/`teach` 62 pass, typecheck clean; entity-read + owner-write tools deferred (§#32 below) |
| #33 PO agent (framework) | **DONE, verified** | mature engine + phases (via #31 dial) + lead-time delivery dates + buffer learning ALREADY existed; added `estimateReadyDate` A2A fact (9 tests, typecheck clean). Grouping/phase RULES are owner-trained via teach-in-chat (#27), not hardcoded (§#33 below) |
| #34 orchestrator / GCOA + A2A | queued | `operating-spec §2/§9.3`; wire `estimateReadyDate` as the first A2A tool |

### #27 teach-in-chat — DONE (files)
- NEW `backend/src/services/assistant-teach.ts` — `parseRouterDecision` (pure, tested), `recordTeaching`, `agentLabel`, `AGENT_LABELS`.
- `backend/src/services/assistant.ts` — router now classifies teach-vs-ask, returns a teach PROPOSAL (stays read-only).
- `backend/src/routes/assistant.ts` — owner-only (`scope.wildcard`) write via `recordTeaching` + `audit('agents.feedback_add')`; non-owner teach refused.
- Store+inject already existed: `addAgentFeedback` / `activeInstructions` (`agent-console.ts:840/909`), injected via `maybeAiFocus` (`agents/index.ts`).
- Test `backend/src/services/assistant-teach.test.ts` (14 cases). Families: `DELIVERY DOCUMENT CS COLLECTION PROCUREMENT PMS OF SI` (`agent-console.ts:21-40`); teach stores UPPERCASE family.

### #28 desktop widget — DONE (files)
- NEW `frontend/src/components/AssistantChat.tsx` — the shared chat body (stream+composer, `send()` → `POST /api/assistant/chat`). Used by page + panel + (next) mobile — one logic layer.
- NEW `frontend/src/components/AssistantPanelContext.tsx` — open/close state (`useAssistantPanel`).
- NEW `frontend/src/components/AssistantPanel.tsx` — floating, resizable (top-left corner drag, size persisted `houzs:assistant-panel-w/h`), bottom-right card, no scrim, Escape/close, `Maximize2` → full page. Body = `<AssistantChat/>`.
- `frontend/src/components/AssistantLauncher.tsx` — `onClick` rewired `navigate("/assistant")` → `toggle()` (panel).
- `frontend/src/pages/Assistant.tsx` — now a thin host around `<AssistantChat/>` (deep-link + "open full page" target).
- `frontend/src/App.tsx` — imports + `<AssistantPanelProvider>` wrapping `<AssistantLauncher/>` + `<AssistantPanel/>` at the overlay stack (~:360).
- **MOBILE PENDING (owner pairing rule — must ship together):** build `frontend/src/mobile/MobileAssistant.tsx` reusing `AssistantChat`; wire into `frontend/src/mobile/MobileApp.tsx` (add an `assistant` to the `Screen` union ~:70-101 + `destinationScreen`, OR a floating launcher via the `annPopup` precedent rendered in both returns ~:751 & ~:873), gated by `canUseAssistant(user)`; styles in `frontend/src/mobile/mobile.css` (mobile is plain CSS, NOT Tailwind). Mobile has ZERO assistant surface today.

## Build-ready specs

### #29 — Assistant chat history (MUST-BUILD; nothing exists)
Two `public`-schema tables, **0091 house style** (text PK = `crypto.randomUUID()`, TEXT ISO timestamps, integer 0/1, `user_id` as TEXT). Migration `backend/src/db/migrations-pg/NNNN_assistant_chat_history.sql` (number at MERGE time — re-list tree).
- `assistant_conversations(id text pk, user_id text, title text, message_count int default 0, created_at text, updated_at text, deleted_at text)` — idx `(user_id, updated_at DESC)`.
- `assistant_messages(id text pk, conversation_id text, user_id text, role text 'user'|'assistant', content text, agents text JSON, degraded int 0/1, created_at text)` — idx `(conversation_id, created_at)` + `(user_id, created_at)`.
- NEW `backend/src/services/assistant-history.ts`: `resolveOrCreateConversation`, `appendExchange` (2 inserts + bump), `listConversations`, `getConversationMessages` (null→404), `softDeleteConversation`. **Write from the ROUTE, keep `services/assistant.ts` read-only** (mirror the teach write).
- `backend/src/routes/assistant.ts`: `GET /conversations`, `GET /conversations/:id/messages`, `DELETE /conversations/:id` (soft), and modify `POST /chat` to take optional `conversationId` + append both turns (best-effort try/catch) + return `{...res, conversationId}`. Gate every route with `canUseAssistant`; scope by `user_id`; **404 not 403** on others'/deleted. Scope is per-USER (not per-company). Answers are already money-redacted at gather (`assistant.ts:251`), so stored history carries nothing the user couldn't see.
- Retention: sweep script + `workflow_dispatch` (keep newest ~100 conv/user, ~180-day box). NEW `docs/modules/assistant.md` (no guide exists yet).

### #30 — File upload (image + PDF; video rejected)
The app ALREADY has an image/PDF→Claude vision path in the scan-OCR routes; the assistant's `askAgentBrain` is **text-only** — that's the only gap. Model `claude-sonnet-4-6`, raw fetch, **no SDK, no new R2 bucket, no beta header**.
- `backend/src/services/agent-brain.ts` (~:33,:61): add optional `contentBlocks?: Array<Record<string,unknown>>`; when present, `content = [{type:'text',text:JSON.stringify(payload)}, ...contentBlocks]` else the current string. All existing callers untouched.
- NEW `backend/src/services/vision-blocks.ts`: `toBase64` + `buildFileBlock` + MIME allowlist — copy from `scm/routes/scan-payment.ts:79-88,:471-485`. Image block `{type:'image',source:{type:'base64',media_type,data}}`; PDF **native** `{type:'document',source:{type:'base64',media_type:'application/pdf',data}}`.
- `backend/src/routes/assistant.ts` (`POST /chat`): branch on `content-type` — accept `multipart/form-data` (`c.req.formData()`) with a `message` field + `file` parts; validate size+mime (`image/jpeg|png|webp`, `application/pdf`; **reject `video/*`** 400); build blocks; thread into `askAssistant` → `askAgentBrain` answer call.
- Frontend `frontend/src/pages/Assistant.tsx` (now via `AssistantChat.tsx`): add a file input (`accept="image/png,image/jpeg,image/webp,application/pdf"`) + chip; in `send()` build `FormData` when a file is attached (else keep JSON). `frontend/src/api/client.ts` already has `uploadFiles`/`uploadFile` (`:593-617`) — add a `postForm(path, form)` that also appends the text field.
- Caps: image ≤5MB, PDF ≤20MB & watch page count, ≤5 files (Anthropic per-image 5MB, request ≤32MB; base64 +33%). Reject bad files with a 400 BEFORE the model (askAgentBrain swallows errors → null).

### #31 — Stored 3-position autonomy dial + per-agent ceilings
- Migration `NNNN_agent_autonomy_stage.sql` (number at merge): `ALTER TABLE agent_controls ADD COLUMN IF NOT EXISTS stage integer NOT NULL DEFAULT 1` + `max_stage integer NOT NULL DEFAULT 2`; CHECKs `stage 1..3`, `max_stage 1..3`, `stage <= max_stage`; `UPDATE ... SET stage=2 WHERE auto_approve=1`; INSERT all 8 families with `max_stage=2` `ON CONFLICT DO UPDATE SET max_stage=EXCLUDED.max_stage` (sets ONLY max_stage). Keep `auto_approve` column for now.
- `backend/src/services/agent-console.ts`: add `effectiveStage(db, family): AutonomyStage` — reads `stage`+`max_stage`, clamps `min(stage, ceil)`, **fails CLOSED to 1**. Reimplement `isAutoApproveOn` as `effectiveStage>=2` (after the `paused` short-circuit). `setAgentControl` accepts `stage?`, clamps to `max_stage`, **never writes `max_stage`**.
- Replace hardcoded stage: `agent-scheduler.ts:306` `canSelfTuneConfig({stage: effectiveStage(...), ...})`; `agents/index.ts:307` gate on `effectiveStage("PROCUREMENT")>=2` and thread stage into `autoApproveReorderProposals` → `procurement-execute.ts:281` `stage: reqStage`.
- Console: `routes/agent-console.ts` `POST /gate` takes `{agent, stage}` (1..3, clamp to ceiling); GET status emits `stage`+`maxStage`. Frontend `Agents.tsx:462` → 3-segment S1/S2/S3, disable segments `> maxStage`.
- **Ceilings (permanent 2):** CS (external comms; name collides with the spec Communication agent), COLLECTION (ledger+dunning), PROCUREMENT (supplier money — DRAFT-gated). Eligible for a future S3: OF, DELIVERY, SI, PMS, DOCUMENT.
- **DO NOT REGRESS:** governance matrix stays the inner gate (`governance.ts` ordered stops: unknown-class → `isNeverAutonomous` → RED → stage<2 → AMBER → new-counterparty → over-limit); procurement two-gate (DRAFT-only + no-default `resolveAgentActorStaffId`); per-company `isScopeKilled` beats the dial; `effectiveStage` fails closed; pause/kill fail open (stop). Test fixtures in `backend/tests/agentGovernance.test.ts` pass explicit stages — leave as-is.

### #32 — Assistant tool-loop (the "search / 查找" foundation) — DONE (v1 shipped)
The codebase's FIRST Anthropic tool-use integration. **What shipped** on `feat/production-po-agent`:
- `backend/src/services/agent-brain.ts` — NEW `askAgentBrainWithTools(apiKey, {system, payload, tools, dispatch, maxTokens, maxTurns, usageSink})`: the reusable multi-turn engine. Grows `messages[]`, echoes each assistant turn + answers every `tool_use` with a `tool_result` in order, caps `maxTurns` (default 5) and **drops `tools` on the final turn so a tool-hungry model is forced to answer**. Best-effort/no-throw like the single-shot sibling (any failure → null → caller falls back). Engine is policy-DUMB: scope + redaction live entirely in `dispatch`. (No retry helper — best-effort + the single-shot fallback is the resilience; retry is a future nicety.)
- NEW `backend/src/services/assistant-tools.ts` — the ONE tool `search_erp` + `buildAssistantTools(scope)` (the gate where money-bearing tools slot in later — an ungated tool is never in the array) + `dispatchAssistantTool` (thin glue, never throws) + PURE `normalizeSearchQuery` (trim + 120-cap) and `shapeSearchResult` (records the "Search" trace + **`redactFacts` on every result**). `SEARCH_TOOL_GUIDANCE` is appended to the answer system prompt.
- `backend/src/routes/search.ts` — extracted `runGlobalSearch(c, env, raw): Promise<Hit[]>`; the HTTP route is now a thin wrapper. The tool calls this SAME reader → IDENTICAL company scoping. `companyScope.ts` blesses exactly this (`CompanyScopeCtx = { get }`, widened so a headless/agent caller scopes through one implementation instead of a leak-prone copy).
- `backend/src/services/assistant.ts` — the ANSWER step runs the TOOL-LOOP when the request carries `companyCtx`: the pre-gathered redacted briefs stay in the payload AND the model gets `search_erp`. On null it falls through to the proven single-shot answer. Router (teach-vs-ask gate) + `keywordRoute` + brief-gather UNCHANGED, so teaching + the no-key fallback still work. Read-only preserved.
- `backend/src/routes/assistant.ts` — passes `c` as `companyCtx` (structurally satisfies `CompanyScopeCtx`).
- Tests: `assistant-tools.test.ts` (10) + `agent-brain.test.ts` (6, fetch-mocked: handshake, usage accrual, forced-final-turn, best-effort null, dispatch-throw recovery). Backend typecheck clean; `assistant-tools agent-brain assistant-teach agentGovernance` = **62 pass**.

**Why v1 is `search_erp`-only (SAFE BY CONSTRUCTION):** it wraps the EXISTING global-search reader — company-scoped at source, match METADATA ONLY (doc number, title, date, link; no record bodies, no money) — and is exposed to a SUBSET of the users who already have the Cmd+K search box (`canUseAssistant` denies field crew + Sales). So the tool-loop adds ZERO disclosure surface, with `redactFacts` on top as defence in depth. The Workers test pool cannot `vi.mock` the reader, so the cap + redaction + trace are tested through the exported PURE helpers.

**DEFERRED to a follow-up (each needs its own field-level review before it is added to `buildAssistantTools`):** the richer entity-read tools — `get_sales_order`/`get_order_items`/`trace_order`/`list_sales_orders`, `get_stock_item`/`get_stock_availability`, `get_delivery_promise`, `get_customer_360`, `get_receivables` (capability-gated), `get_agent_brief` (the 6 briefs as an on-demand tool) — and the owner-only WRITE tools `teach_agent`/`agent_control` via **propose-in-loop / dispose-in-route** (the loop emits the call, `routes/assistant.ts` does the `recordTeaching`/`setAgentControl` + `audit`, keeping `services/assistant.ts` read-only). Scope wiring for those: **Option A (safest)** — each does an in-worker `fetch` to the app's OWN endpoint with the caller's bearer so every gate runs verbatim; Option B needs read-only cores factored out of the inline SO handlers.
- **DO-NOT-REGRESS (governs the deferred tools):** `redactFacts` on EVERY tool result; capability gate BEFORE offering a tool; `canUseAssistant` stays the fail-closed door; **company scope on every result** — the service-role client BYPASSES RLS (`db/supabase.ts:66-80`), and receivables reads currently span ALL companies (`collection-agent.ts:135-143`) — FIX before exposing; **NO model-authored SQL** (defer `run_select_query`, or make it a parameterised named-query allowlist with server-injected scope); `MARGIN_KEYS` does NOT match bare `cost`/`price`/AR-balance — gate those tools on finance, don't lean on the regex; empty tool result → "I don't have that", never an invented fact.

### #33 — PO / Procurement agent (framework) — DONE
**Key finding on surveying the engine:** the Procurement Agent is already MATURE — an MRP-driven reorder sweep with per-supplier proposals, a supplier-coverage readiness gate, capacity/overload detection, draft-aware netting, per-company scoping, and a self-tuning LEAD-TIME LEARNER (`learnSupplierBuffers`/`learnSeasonBuffers` → config proposals the owner approves). Most of what #33 was scoped to build ALREADY EXISTS; rebuilding it would REGRESS (the same lesson as "don't copy Hookka wholesale"). Mapped against the 4 phases:
- **P1 draft / P2 request lead-time / P3 auto lead-time+date / P4 full-auto+send** → the phase→autonomy mapping is delivered by the **#31 dial**: `effectiveStage("PROCUREMENT")` gates whether reorder proposals auto-approve, capped at Stage 2 so **P4 (auto-send) stays deliberately unreachable** (no supplier-send path + above the ceiling). Nothing to add.
- **Delivery date from lead time** → ALREADY built: `loadLeadBuffers` → `computeMrp` derives every `orderByDate` from the owner's base table + learned buffers (`scm/lib/lead-time.ts`).
- **Trainable buffers** → ALREADY built: the learner proposes supplier/season buffers; the owner approves them as config proposals.

**What #33 ADDED — the one genuine gap:** `estimateReadyDate`, the first typed **A2A fact** (owner: "CS ... ask procurement agent when the items can be ready" — CS must not read ETA from the DB itself). `services/agents/procurement-ready-date.ts`: pure `estimateReadyDate(base, buffers, asOf, items)` (inverse of MRP's order-by hint, reuses `resolveLeadDays`) + `estimateReadyDateForCompany(env, {items, asOfDate})` (company-scoped loader, refuses on unresolved company). `scm/lib/lead-time.ts` gained `addCalendarDays`. Deterministic, read-only, 9 tests. V1 = order-from-scratch lead date; netting on-hand stock / in-flight POs is a documented seam for #34.

**What is DELIBERATELY NOT built (owner-trained, not hardcoded):** the specific GROUPING and phase RULES — "split mattress onto its own PO", "combine sofa+bedframe per SO", per-agent phase tuning. The owner's standing direction is "你做完了 我才 prompt 每个 agent 的逻辑" — I build the framework, staff train the rules. The mechanism is live: teach-in-chat (#27) records a PROCUREMENT standing rule → `activeInstructions` injects it into the agent's brain. Hardcoding rules now would preempt exactly what they intend to train.

## Verification done
- #27: `backend` — `vitest run` (14 pass) + `tsc --noEmit` clean.
- #28 desktop: `frontend` — `tsc --noEmit` clean + `npm run build` clean (8.4s). Live click-test needs a logged-in session (owner's) — the app shell only mounts post-auth.

## Not yet committed
All #27 + #28-desktop changes are in the worktree, unpushed. Owner to OK the commit/PR. Migrations for #29/#31: take the number at MERGE time (re-list `migrations-pg`), never reserve — `pg-migrate` breaks on duplicate numbers.
