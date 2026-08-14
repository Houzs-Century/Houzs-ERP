> **ARCHIVED 2026-08-13.** The cutover it plans **flipped 2026-07-21** — `HOUZS_OWNS_2990 = "true"` in `backend/wrangler.toml`. Outcome and the items still open are in `docs/2990-cutover/HANDOFF.md`. Kept for history; do not follow it as a current instruction.

# 2990 → Houzs cutover: fully replace the 2990 backend

**Goal (owner, 2026-07-13):** the 2990 POS talks **entirely** to the Houzs merged
backend so the **2990 `apps/api` backend can be retired**. Not a partial SO mirror
— a complete replacement. A one-way SO mirror alone leaves the 2990 backend alive
forever (the POS reads ~27 things from it), so it must all move to Houzs.

**Hard constraints:**
- The POS keeps running on 2990 the whole time. Nothing here touches the live POS
  until the tested, reversible cutover flip (P5). Parallel-run / strangler.
- We do **not** edit `apps/pos` from the Houzs side — POS-side changes (P4) are
  owned by the POS team; this plan builds the Houzs surface they point at.
- All DB migrations are **plpgsql-safe** (pg-migrate splits on `/;\s*\n/`, so every
  internal `;` in a function body carries a trailing `-- $` — see mig 0066/0099).

## The two-channel dependency (critical)

The POS reaches 2990 via **two** channels, both must move to Houzs:
1. `fetch(${VITE_API_URL}/...)` → 2990 `apps/api` (the endpoint table below).
2. **Direct `supabase.from(...)` + Supabase Auth + Realtime** → the 2990 Supabase
   project directly (~15 catalog tables, auth, realtime). Houzs is a *different*
   Supabase (`anogrigyjbduyzclzjgn`) with data under the `scm` schema reached only
   via the backend service-role. So the direct-Supabase layer must become
   `/api/scm` calls (POS-side work, P4) — this is larger than the fetch endpoints.

## Phases

| Phase | What | Owner | Status |
|---|---|---|---|
| **P1** Auth bridge | `/api/pos` PIN+session login on Houzs; PIN store/RPC migration; POS staff → Houzs users + company_2 | Houzs | **PR #381 (code green; validate mig on staging → prod)** |
| **P2** Build missing endpoints | the 8 bucket-C endpoints | Houzs | open — claimable |
| **P3** Adapt differing endpoints | the 3 bucket-B + verify /venues, GET /:docNo/items | Houzs | open — claimable |
| **P4** POS-side rewire | point POS at Houzs, new login, direct-Supabase→endpoints, slip client, `X-Company-Id: 2` | **POS team** | open |
| **P5** Staging test + flip | POS ⇄ Houzs staging full-flow green → flip prod → retire 2990 backend | Houzs + owner | open |

## Endpoint buckets (from the mapping audit)

**(A) Already served by Houzs scm — drop-in (code-only; needs 2990 data present + company_2 wiring):** ~20 groups —
`/products`, `/mfg-products`, `/maintenance-config`(+compartments), `/product-models`, `/pwp-rules`, `/pwp-codes`, `/sofa-combos`, `/sofa-quick-picks`, `/special-addons`, `/delivery-fees`, `/fabric-tier-addon`(+`/fabric-library/:id/tier`), `/model-free-gifts`, `/fabric-tracking`, `/so-dropdown-options`, `/localities`, `/state-warehouse-mappings`, `/inventory/warehouses`, `/so-settings`, and the whole `/mfg-sales-orders` SO family.

**(B) Served but contract DIFFERS — adapt (P3):**
- `/slips` — Houzs replaced presigned-R2-PUT with a worker-proxy `POST /slips/:session/upload`; the POS `slip.ts` client must be rewritten (P4) and the Houzs contract confirmed.
- `/pos/sales-staff` — shape differs from `/staff`; served here by P1's `/api/pos/sales-staff`.
- `GET /mfg-sales-orders/:docNo/items` — verify a dedicated items GET exists (POS calls it directly; only POST/PATCH/DELETE were seen).
- `/venues` — UNKNOWN: no `/venues` mount found in `scm/index.ts`; confirm whether folded into `/so-dropdown-options` or MISSING.

**(C) MISSING in Houzs — build (P2):** each is a port of the 2990 `apps/api/src/routes/*` route to Houzs `backend/src/scm/routes/*` style, company_id=2 scoped:
- `/pos-cart` (GET/PUT) — cross-device cart snapshot (`pos_carts` table).
- `/quotes` (GET/POST/PATCH/DELETE) — saved quotes (`quotes` table).
- `/personal-quick-picks` (GET/POST/DELETE) — per-device quick picks.
- `/sales-analysis` (GET + PUT /targets) — sales-analysis aggregation dashboard.
- `/pos/sales-stats` — DONE in P1 (`/api/pos/sales-stats`), verify parity.
- POS-auth trio `/pos/pin-login`, `/pos/my-pin`(→`set-pin`), `/pos/verify-pin` — DONE in P1.
- `/pos/backend-sso` — OBSOLETE at cutover (Backend retired). Drop.

**(D) AUTH:** 2990 = Supabase JWT; Houzs = custom session token (`sessions` table, integer user id). Incompatible. P1 builds the Houzs-session PIN login; P4 rewires the POS to use it + provisions POS staff as Houzs users with `user_companies(company_id=2)`.

## Highest-risk items (verify hardest)
1. **`POST /mfg-sales-orders` (SO create)** — server-side price recompute must match the POS's `@2990s/shared` pricing exactly, or every order 400s on drift; it also stamps `salesperson_id` + `company_id` (must be 2). Data + pricing + auth converge here.
2. **PIN/session login (P1)** — the counter login front door; if wrong, no salesperson can log in.
3. **`/slips`** — silent failure: `/slips/init` still exists but returns a different shape; slip attach breaks until the POS client is rewritten.

## References
- Mapping audit + AUTH deep-dive: this repo's PR that added this doc (see the PR body / the session that produced it).
- Port-from source (2990): `wenwei4046/2990s` → `apps/api/src/routes/*` (server) and `apps/pos/src` (client contracts).
- Houzs targets: `backend/src/scm/routes/*`, mount map `backend/src/scm/index.ts`; auth `backend/src/services/auth.ts` (`createSession`/`verifyPassword`) + `backend/src/middleware/auth.ts` (`auth`) + `backend/src/middleware/companyContext.ts`.
- Staff↔user mapping: mig `0066_scm_staff_user_sync.sql` (`scm.staff.id = md5('houzs-user:'||users.id)::uuid`, link col `scm.staff.user_id`).
- P1 code: mig `0099_pos_auth.sql`, `backend/src/routes/pos.ts` (PR #381).

## Gotchas
- **company_id NOT NULL** on ~120 scm tables — every INSERT must stamp it (helpers in `scm/lib/companyScope.ts`: `activeCompanyId`, `scopeToCompany`, `stampCompany`). Missing stamp → 500.
- **Doc-no prefix**: imported 2990 docs are `2990-`-prefixed under company 2 (`companyDocPrefix`). New POS-originated docs must match so they don't collide/duplicate.
- **pg-migrate** applies migrations-pg on EVERY prod deploy; a broken migration blocks ALL deploys. Validate plpgsql on staging first.
- **Migration numbers**: main has duplicate numbers (0091–0095 doubled from parallel PRs; pg-migrate keys on filename so it runs). Pick a number above the current max to avoid confusion.
