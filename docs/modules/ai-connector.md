# AI Connector (MCP)

Staff ask Claude / ChatGPT / any remote-MCP app about the ERP with their OWN login. Read-only.

## Address
- Connector URL: `https://erp.houzscentury.com/api/mcp` (2990: `https://erp.2990shome.com/api/mcp`).
- Discovery: `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server` at the site root (Pages functions forward them to the Worker with `X-Forwarded-Host`; the Worker believes only company hosts — `routes/mcp.ts publicOrigin`).

## Rules
- Read-only by construction: a tool call re-enters the app in-process as a GET. `middleware/auth.ts` accepts an `hzmcp_` token ONLY with the per-isolate `x-houzs-mcp-inner` header and ONLY for GET/HEAD; a token used directly against `/api/*` gets 403.
- Own permissions: the inner call runs as the real user (`getUserById`), so every route's own permission, page access and company scope decide. `erp_get` takes `company` (HOUZS / 2990).
- Never readable: sign-in, TOTP, PIN, private mail, sync, public portals, the connector itself (`services/mcp-access.ts MCP_BLOCKED_PREFIXES`). Credential-shaped fields are stripped from every reply.
- Money fields by the ERP's own cohorts (`services/mcp-access.ts redactMoney`): margin / profit / any cost key only for `isFinanceViewer`; product / line unit cost also for `isProductCostViewer` (Purchasing). Unknown caller → all stripped. Added after the 2026-11-25 leak check found unitCostSen / costPriceSen / contractor_cost / fin_total_cost / cost_notes reaching a Sales Executive through the ERP's replies.
- Who may connect: holders of `ai_connector.manage` (Owner via `*`) always; everyone else after approval (`mcp_access`). Staff request on System > AI Connector; admins get a bell notice.
- Tokens: access 24 h, refresh 90 d (rotating), SHA-256 hashes only (`mcp_tokens`). Remove / Disconnect revokes at once.
- Every lookup is logged (`mcp_calls`) and shown on the AI Connector page.

## Tools
- Quick answers first (one call, a summary of a few thousand characters): `sales_summary` reads the Sales Report's Sales Order stage (`/api/scm/reports/fair-report?stage=so`) for the window and the same days one period earlier, plus top models and the trend from `/api/scm/sales-analysis`; `delivery_summary` reads `/api/scm/logistic-overview` the same way. Both take `period` (YYYY-MM / YYYY-Qn / YYYY, ending today at the latest) or `from`/`to`, and `company`. Only the window's own read must succeed; the comparison and the Sales Analysis are extras.
- `search` / `fetch` are the pair ChatGPT requires: `search` wraps `/api/search` into `{results:[{id,title,url}]}` with id `<hit type>:<id>`; `fetch` opens the record at its detail endpoint (`services/mcp-quick.ts FETCH_KINDS`). A receipt or product hit has no single record to open; its link is the answer.
- Every read (quick answers, search, fetch, `erp_get`) goes through `readValue` in `routes/mcp.ts`: the in-process GET as the person, then the credential strip. No quick answer runs its own SQL.
- `erp_get` takes `fields` (keep only those keys, any depth); replies are cut at `MAX_RESULT_CHARS` (30,000).
- `prompts/list` + `prompts/get` offer three ready-made questions (`PROMPTS`).
- One token check per lookup: the door (`app.post("/")`) verifies the token and `rememberVerified` keeps that identity for 15 s per isolate; `middleware/auth.ts` reuses it for that tool call's inner GETs (`recallVerified`) instead of resolving the token again. A new request is always checked at the door.
- Leak check (admin): runs every parameter-free GET as one approved staff account and lists which money / people field names reach them. Names only, never values. Its token is revoked when the page finishes.

## Files
- Backend: `routes/mcp.ts`, `routes/mcpAdmin.ts`, `services/mcp-store.ts`, `services/mcp-access.ts`, `services/mcp-inner.ts`, `services/mcp-quick.ts` (pure summaries, search / fetch shaping, prompts; tests `mcp-quick.test.ts`); migration `20261125T2200_mcp_connector.sql`.
- Frontend: `pages/AiConnector.tsx` (System > AI Connector; standalone on the phone shell), `pages/AiConnect.tsx` (the "Allow?" screen, rendered by `auth/AuthGate.tsx`), `functions/.well-known/*`.
