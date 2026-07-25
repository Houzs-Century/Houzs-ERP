# Agent Platform Buildout — status + build-ready specs

_Snapshot of the "bring Houzs's agent platform to parity with Hookka + build the trainable PO agent" effort. Written 2026-07-25. Branch `feat/production-po-agent` (worktree `houzs-work-worktrees/po-agent`). This doc exists so the detailed build specs survive a context compaction — execute from here._

## The premise (verified against both repos)

Houzs's agent framework was ported FROM Hookka (see `services/agent-console.ts` header, owner OK 2026-07-13) and then generalized. Houzs is **ahead** of Hookka on 7 of 10 platform capabilities (generic `registerAgent`, generic config-rule whitelist, stale-run reaper, executable `governance.ts` matrix, finer kill-scopes, decision/outcome ledgers, per-company scoping, a deeper procurement learner). **"Copy Hookka wholesale" would REGRESS us.** Only three real gaps:

1. **Teach-in-chat** — DONE (task #27).
2. **Stored 3-position autonomy dial** — spec ready (task #31, below).
3. **Assistant tool-loop** (the owner's "search / 查找" capability) — spec pending (task #32).

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
| #32 assistant tool-loop | design agent running | add spec when it returns |
| #33 PO agent 4 phases | queued | extend `services/agents/procurement-agent.ts` |
| #34 orchestrator / GCOA + A2A | queued | `operating-spec §2/§9.3` |

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

### #32 — Assistant tool-loop (the "search / 查找" foundation)
This is the codebase's FIRST Anthropic tool-use integration — `askAgentBrain` is single-shot (`agent-brain.ts:44-86`, no `tools`/`stop_reason` handling; grep found zero `tool_use` anywhere).
- `backend/src/services/agent-brain.ts` (EDIT): export `ANTHROPIC_URL`/`ANTHROPIC_VERSION`/`AGENT_BRAIN_MODEL` (`claude-sonnet-4-6`); add `askAgentBrainWithTools(...)` — multi-turn loop: send `tools`, grow `messages[]`, while `stop_reason==="tool_use"` append the assistant turn + a user turn of `tool_result` blocks, cap `maxTurns=5`, force a final prose answer, keep `usageSink` + `anthropicFetchWithRetry` (copy from `scan-so.ts:113`). Best-effort/no-throw preserved.
- NEW `backend/src/services/assistant-tools.ts`: `TOOL_DEFS` (Anthropic `input_schema`), `buildToolsForScope(scope)` (capability + owner gate — an ungated tool is never in the array), `dispatchReadTool(ctx,name,input)` (governed read → company/sales scope → **`redactFacts` on the result before it becomes a `tool_result`**).
- `backend/src/services/assistant.ts` (EDIT): loop replaces the gather+single-shot answer (`:226-258`); keep `keywordRoute`+brief-gather as the no-key/failure fallback; `ANSWER_SYSTEM` grounding becomes the loop system prompt; stays read-only.
- `backend/src/routes/assistant.ts` (EDIT): supply SCM scope context + execute owner-gated writes.
- **Tool catalog** (each wraps an EXISTING governed read): `search_erp` (wrap `routes/search.ts:101` — company-scoped, metadata-only), `get_sales_order`/`get_order_items`/`trace_order`/`list_sales_orders` (SO reads, `scopeToCompany`+`salesDocOutOfScope`), `get_stock_item`/`get_stock_availability` (pass explicit `companyId`), `get_delivery_promise`, `get_customer_360` (composite), `get_receivables` (capability-gated), `get_agent_brief` (today's 6 briefs as a tool — keeps grounding).
- **Owner-only tools** (`scope.wildcard`): `agent_overview` (read `listAgentControls`+`monthLlmUsage`); `teach_agent`/`agent_control` via **propose-in-loop / dispose-in-route** (the loop emits the call, `routes/assistant.ts` does the `recordTeaching`/`setAgentControl` write + `audit` — keeps `services/assistant.ts` read-only).
- **Scope wiring — Option A (recommended, safest):** each read tool does an in-worker `fetch` to the app's OWN endpoint carrying the caller's bearer, so every existing gate (`scmAreaGuard`, `scopeToCompany`, finance-field stripping) runs verbatim — the tool cannot see more than the user's own UI. Option B (give the chat route the SCM middleware chain + call exported primitives) is leaner but needs read-only cores factored out of the inline SO handlers.
- **DO-NOT-REGRESS (critical):** `redactFacts` on EVERY tool result (a tool_result enters the context window like a brief); capability gate BEFORE offering a tool, not just answering; `canUseAssistant` stays the fail-closed door; **company scope on every tool result** — the service-role client BYPASSES RLS (`db/supabase.ts:66-80`), and the receivables reads currently span ALL companies (`collection-agent.ts:135-143`) — FIX before exposing; **NO model-authored SQL** (no statement guard exists; defer `run_select_query`, or make it a parameterised named-query allowlist with server-injected company scope); `MARGIN_KEYS` does NOT match bare `cost`/`price`/AR-balance — gate those tools on finance, don't rely on the redaction regex; no invented facts (empty tool result → "I don't have that").
- Tests mirror `assistant-teach.test.ts` (turn cap, tool_result shape, redaction-on-output, owner-gate refusal, no-key fallback).

## Verification done
- #27: `backend` — `vitest run` (14 pass) + `tsc --noEmit` clean.
- #28 desktop: `frontend` — `tsc --noEmit` clean + `npm run build` clean (8.4s). Live click-test needs a logged-in session (owner's) — the app shell only mounts post-auth.

## Not yet committed
All #27 + #28-desktop changes are in the worktree, unpushed. Owner to OK the commit/PR. Migrations for #29/#31: take the number at MERGE time (re-list `migrations-pg`), never reserve — `pg-migrate` breaks on duplicate numbers.
