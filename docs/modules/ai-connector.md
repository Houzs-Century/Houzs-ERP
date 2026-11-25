# AI Connector (MCP)

Staff ask Claude / ChatGPT / any remote-MCP app about the ERP with their OWN login. Read-only.

## Address
- Connector URL: `https://erp.houzscentury.com/api/mcp` (2990: `https://erp.2990shome.com/api/mcp`).
- Discovery: `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server` at the site root (Pages functions forward them to the Worker with `X-Forwarded-Host`; the Worker believes only company hosts — `routes/mcp.ts publicOrigin`).

## Rules
- Read-only by construction: a tool call re-enters the app in-process as a GET. `middleware/auth.ts` accepts an `hzmcp_` token ONLY with the per-isolate `x-houzs-mcp-inner` header and ONLY for GET/HEAD; a token used directly against `/api/*` gets 403.
- Own permissions: the inner call runs as the real user (`getUserById`), so every route's own permission, page access and company scope decide. `erp_get` takes `company` (HOUZS / 2990).
- Never readable: sign-in, TOTP, PIN, private mail, sync, public portals, the connector itself (`services/mcp-access.ts MCP_BLOCKED_PREFIXES`). Credential-shaped fields are stripped from every reply.
- Who may connect: holders of `ai_connector.manage` (Owner via `*`) always; everyone else after approval (`mcp_access`). Staff request on System > AI Connector; admins get a bell notice.
- Tokens: access 24 h, refresh 90 d (rotating), SHA-256 hashes only (`mcp_tokens`). Remove / Disconnect revokes at once.
- Every lookup is logged (`mcp_calls`) and shown on the AI Connector page.
- Leak check (admin): runs every parameter-free GET as one approved staff account and lists which money / people field names reach them. Names only, never values. Its token is revoked when the page finishes.

## Files
- Backend: `routes/mcp.ts`, `routes/mcpAdmin.ts`, `services/mcp-store.ts`, `services/mcp-access.ts`, `services/mcp-inner.ts`; migration `20261125T1800_mcp_connector.sql`.
- Frontend: `pages/AiConnector.tsx` (System > AI Connector; standalone on the phone shell), `pages/AiConnect.tsx` (the "Allow?" screen, rendered by `auth/AuthGate.tsx`), `functions/.well-known/*`.
