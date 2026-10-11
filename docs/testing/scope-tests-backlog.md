# Cross-company scope tests — regression backlog

Owner directive 2026-07-22 ("从 backend 断绝掉") produced a 20-endpoint
scope-tighten sweep across PR #1010, #1013, #1015, #1020, #1025. Each
endpoint has a landmine of the same shape: a future refactor drops the
`.eq('company_id', ...)` predicate or replaces `scopeToCompany(q, c)` with
a raw `sb.from('x')`, the leak re-opens, and nothing catches it until a
Scarlett-shaped incident.

The existing `companyWriteScope.test.ts` / `companyScopeMastersConfig.test.ts`
pattern is right: bare Hono app + FakeQuery + assert BOTH directions
(cross-company caller gets 404, same-company caller still succeeds — 404s
that mutated would pass a status-only assertion).

## Missing tests (per PR)

### PR #1010 — DP-regions module + ASSR reads

| Endpoint | Behaviour to lock in |
|---|---|
| `GET /api/scm/delivery-planning-regions/states` | widened via `scopeToAllowedCompanies`; caller with allowed=[1] sees only company-1 mappings |
| `GET /api/scm/delivery-planning-regions/states/:key` | same |
| `PATCH /api/scm/delivery-planning-regions/:id` | A + B's id → 404 `not_found_in_company` (row unchanged); A + A's id → 200 |
| `DELETE /api/scm/delivery-planning-regions/:id` | same; in-use precheck scoped so a mapping in B doesn't leak via the 409 |
| `PUT /api/scm/delivery-planning-regions/states/:key` | DELETE branch scoped — a company A caller cannot wipe company B's mapping for the same state_key + country |
| `GET /api/assr/creditors/search` | 2990-only caller → skips HOUZS creditors (raw D1, `assrCompanySql`) |
| `POST /api/assr/resync-so/:docNo` read-back | scoped read-back after upsert |

### PR #1013 — `/staff`

| Endpoint | Behaviour |
|---|---|
| `GET /api/scm/staff` (default) | scoped to caller's active company (Team-grant rule); inactive rows included |
| `GET /api/scm/staff?scope=all` | requires `users.manage`; anyone else → 403 |
| `GET /api/scm/staff/by-ids?ids=...` | returns only requested ids, no scope filter, capped at 200 |

### PR #1015 — 13 blind-id writes + smalls

| File | Endpoint | Behaviour |
|---|---|---|
| `routes/sales.ts` | POST /entries/:id/submit / unsubmit / void, DELETE /entries/:id | scoped by companyId at both SELECT + UPDATE |
| `scm/routes/stock-takes.ts` | DELETE /:id + PATCH /:id/lines | requireActiveCompanyId + scopeToCompanyId |
| `scm/routes/delivery-fees.ts` | PUT + DELETE /special/:id | same |
| `scm/routes/dp-orders.ts` | PATCH /:id + POST /:id/cancel + POST /:id/schedule | same |
| `scm/routes/dp-orders.ts` | GET / cold-start | `scopeToAllowedCompanies` fail-CLOSED |
| `routes/projects.ts` | POST /finance/brand-rates | cascade only touches active-company projects |
| `routes/projects.ts` | PATCH /:id/finance | PIC pre-check scoped by activeCompanySql |
| `scm/routes/categories.ts` | POST 409 duplicate preflight | scoped so other-company id existence doesn't leak |
| `scm/routes/accounting.ts` | POST /post/si/:invoiceNumber + /post/pi/:invoiceNumber | leak-guard SELECT scoped by active company |

### PR #1020 — Service Case rules

| Rule | Test |
|---|---|
| SVC-* lines filtered | seed a SO with SVC-DELIVERY; `GET /api/assr/lookup-items/:docNo` result excludes it |
| items=[] accepted | `POST /api/assr` with `items: []` returns 201 |
| duplicate-open-case guard | seed OPEN case with item X; `POST /api/assr` with same doc_no + X → 409 `duplicate_open_case` + `existing:[…]` |

### PR #1025 — /finance/pnl cost scoping

| Test |
|---|
| Company A caller: /pnl `project_cost` bucket excludes company-B project_finance_lines rows |
| Company A caller: /pnl `service_cost` bucket excludes company-B assr_cases rows |
| Single-company Houzs (no companies master): behaviour unchanged — every row counts |
| INSERT via `createLedgerLine`: new row's `company_id` = parent project's `company_id` |
| INSERT via `recomputeAutoCostLines`: same |

## What's blocking

Most of these endpoints define their handlers inline (`router.patch('/:id',
async (c) => {...})`) rather than as exported named functions. The existing
harness pattern imports the handler and mounts it on a bare Hono app; inline
handlers can't be imported. Two ways forward:

1. **Refactor each handler to an exported named function.** ~5 lines per
   endpoint. Enables the existing FakeQuery harness pattern verbatim. Best
   long-term but multiplies the diff.

2. **Router-level integration tests.** Import the whole router, mount on a
   bare Hono app with fake middleware injecting `supabase` + `companyId`.
   No handler refactor needed. Middleware auth still bypassed (same as the
   current harness). Slightly larger per-test setup but no code churn.

Path (2) is the pragmatic choice for closing the backlog quickly. Path (1)
is the right long-term shape; do it opportunistically when a handler is
touched for another reason.

## Priority order

If picking one to do first: **PR #1013 `/staff` + PR #1020 duplicate case
guard**. Both are P0 owner-sighting bugs (Scarlett saw HOUZS staff, office
+ sales opened parallel cases). Regression there is the most visible.

Then the CRITICAL / HIGH scope endpoints from PR #1010 + #1015 in priority
order (money-adjacent first: delivery-fees, projects/finance, accounting/post
before dp-orders / stock-takes / categories).

MEDIUM tier last.
