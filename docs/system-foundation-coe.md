# Houzs ERP — System Foundation COE (Correction of Error)

**Date:** 2026-06-22
**Trigger:** Recurring intermittent "Failed to load / Something went wrong" 500s across the app (Project List, Calendar, search, page-access), worse the more staff online; owner reported the system feeling "foundationally fragile."
**Status:** Root cause fixed + deployed. Foundation audited across 5 dimensions. Remaining items tracked below.

---

## 1. Incident — what happened and why

Staff intermittently saw `500 {"error":"Something went wrong. Please try again."}` on whole pages. It was **not** random and **not** "everything is broken" — it was one architectural defect amplified by a slow database.

### Root cause (confirmed by `wrangler tail`, not guessed)
`middleware/db.ts` attached the per-request DB client by **mutating the shared, isolate-level `c.env` object**: `c.env.DB = d1Compat(...)`. Cloudflare Workers serves many requests **concurrently in one isolate**, all sharing that same `env` object, and `d1Compat` caches one postgres.js client per instance. So:

1. Request A (e.g. a presence heartbeat) hits a **cold Hyperdrive connection and hangs ~12s** (confirmed: `[db-retry] d1-compat first attempt timed out` + `[slow-query] 12030ms` in tail).
2. While A is suspended, request B's middleware runs and **overwrites the shared `c.env.DB`** with B's client.
3. A resumes and runs its next query on **B's client** — a socket opened in a different request's context → Workers rejects it:
   `Error: Cannot perform I/O on behalf of a different request ... (I/O type: Writable)` (caught live in tail on `GET /api/positions/:id/page-access`).
4. That error string matched **neither** the 503 (connection) **nor** the SQL classifier in `humanizeError`, so it fell through to the generic 500 message — exactly what staff saw. Intermittent (interleaving-dependent), every page, worse under load.

### Evidence
- `wrangler tail autocount-sync-api` captured both the 12s cold-start `[db-retry]` hangs and the live `[onError] Cannot perform I/O on behalf of a different request` 500.
- The same default Project List query ran **fine** directly against the DB (364 rows) — proving the SQL was healthy and the fault was connection-context, not the query.

---

## 2. Fixes shipped (2026-06-22)

| PR | What | Effect |
|----|------|--------|
| **#102** | `middleware/db.ts`: assign a **fresh per-request env** (`c.env = {...c.env, DB}`) instead of mutating the shared one — matches the already-correct `withPgDb()` cron path. + `isDeadConnError` also matches the cross-context I/O error so any residual is retried on a fresh client. | **Root cause eliminated.** The recurring 500 stops. Confirmed in tail: post-deploy traffic = all 200s, no `Cannot perform I/O`. |
| **#103** | **Transient-error self-heal end-to-end:** one shared `TRANSIENT_CONN_RE` (cold-start hang, pooler cap "too many clients"/"remaining connection slots", Connection terminated, ETIMEDOUT, fetch failed, socket hang up, cross-context I/O) used by BOTH the retry layer (`d1-compat isDeadConnError`) and the user-facing classifier (`index.ts humanizeError` → 503). Frontend (`frontend/src/api/client.ts`) now **retries idempotent GETs on HTTP 503** (it previously retried only network/abort errors and never any 5xx). + Two latent SQLite-on-Postgres crashes fixed (see §3 F1/F3). | Transient DB blips now **self-heal** (browser retries the 503) instead of surfacing as "Failed to load." Real bugs (SQL/4xx) still surface immediately. **Mutations were not retried when this shipped — that rule was later NARROWED, not kept.** Corrected 2026-08-13: a mutation IS retried today, but ONLY on a cold-pool 503 whose body matches `/briefly unavailable\|warming up\|try again in a moment/i` (`api/client.ts:329-331,476` and `vendor/scm/lib/authed-fetch.ts:269-274`), because that answer is produced BEFORE the handler runs, so no write occurred. Every other 5xx on a mutation is still surfaced, never replayed. The file is `api/client.ts`; a path `lib/client.ts` does not exist. |

---

## 3. Foundation audit — 5 dimensions

### A. Concurrency / shared isolate state — CLEAN (1 bug, fixed)
Full backend swept. The `middleware/db.ts` mutation was the **only** instance of per-request mutation of shared isolate state. Zero other `c.env.X =`/`env.X =` assignments, zero `globalThis` writes, zero module-scope mutable caches written during requests, zero cached I/O clients at module scope. `getSql()` builds per-request; `d1Compat` takes a factory; `withPgDb()` (cron) spreads correctly. **The codebase is otherwise disciplined about this.**

### B. SQLite-on-Postgres dialect — 2 latent crashes fixed, 2 tracked
The D1→Postgres cutover uses a `rewriteDialect()` shim that translates `datetime/date('now')`, `strftime`, `julianday`, `instr`, `char`, and `LIKE→ILIKE` — but **only inside `env.DB.prepare()` strings**, NOT Drizzle `` sql`` `` tagged-template fragments.
- **F1 (FIXED #103, HIGH):** `services/projects.ts` shifted checklist due dates with `date(?, due_offset_days||' days')` — Postgres has no 2-arg `date()` → threw on **every project start-date change**. Now `to_char((?::date + due_offset_days),'YYYY-MM-DD')`.
- **F3 (FIXED #103, MED):** `routes/projects.ts` (×2) raw Drizzle search fragments used `LIKE` (case-sensitive on PG, bypasses the ILIKE rewrite) → search missed case-mismatches. Now `ILIKE`.
- **F2 (TRACKED, latent):** ~40 ASSR/inbox/projects sites cast date-text columns `(col)::timestamptz`; an **empty string** `''::timestamptz` throws (SQLite returned NULL). Scanned **237 date-text columns → ZERO hold empty strings**, so it is latent, not live. Defensive fix when touched: `nullif(col,'')::timestamptz`.
- **F4 (TRACKED, low):** `strftime('%W')→IW` week-number semantics differ; CSAT trend bucket labels shift by up to a week. Cosmetic.

### C. Transient-error resilience — gaps fixed (#103)
Two classifiers (`humanizeError`, `isDeadConnError`) had drifted apart and the frontend never retried any 5xx. Unified into one `TRANSIENT_CONN_RE` + frontend 503 retry. See §2 #103.

### D. Infrastructure / config / frontend — mostly healthy; key items tracked
**Healthy (verified, do not churn):** migrate-before-deploy gap is **CLOSED** (`deploy.yml` runs `pg-migrate.mjs` before `wrangler deploy`); frontend has an error boundary + chunk self-heal + version banner + tolerant SW; secrets git-ignored; cron jobs bounded; `pg.ts max:1 + prepare:false` is the hard-won correct config.

| ID | Sev | Item | Plan |
|----|-----|------|------|
| C1 | **CRITICAL** | ~40 SCM list endpoints have no `.limit()` → silent 1000-row truncation. **Inventory balances show PARTIAL stock (looks like missing stock).** Also PO/GRN/PI/supplier lists. | **CLOSED, but NOT by the plan written here** (re-checked 2026-08-13). The plan said "add `.limit()`" and that alone does not work: a bare `.limit(50_000)` is still capped at PostgREST's 1000-row ceiling, so the row would have read as fixed while still truncating. The real fix is `paginateAll` (`scm/lib/paginate-all.ts`), which pages with `.range(from, to)`; 43 files use it, including the inventory analytics path the comment at `inventory.ts:1132-1135` explains. **Never cite `.limit()` as the remedy for this class.** |
| C2 | HIGH (perf) | SO-detail GET recomputes the **entire MRP book** every open (`mfg-sales-orders.ts` → `computeMrp`). Latency scales with the whole open book. | Backlog: scope `computeMrp` to the one SO's items/warehouses, or cache. |
| H1 | HIGH (latent) | `pg-migrate.mjs` splits SQL on `;\n` — works today, but the next migration with a `;\n` inside a `$$...$$` body splits mid-body, fails, and **blocks all prod deploys**. | **CLOSED** (re-checked 2026-08-13). `pg-migrate.mjs:18` imports `splitSqlStatements` from `scripts/lib/split-sql.mjs` — a scanner that knows dollar quotes of any tag, single-quoted literals, quoted identifiers and nestable block comments, with the old regex's semantics preserved outside them. Unit-tested in `tests/splitSql.test.ts`. It is why stored functions can live in the migration tree at all. |
| H2 | HIGH | Child line-item `.in('parent_id', ids)` reads uncapped → lines silently cap at 1000; `reports.ts` payment/staff `.in()` corrupts paid totals. | **CLOSED with C1, by `paginateAll`, not by `.limit(5000)`** — same reason as C1. |
| H3 | HIGH (perf) | Rate-card save loops every project of a brand × ~5-9 queries each → ~450 serial round-trips. | Backlog: batch with `WHERE project_id IN (...)`. |
| H4 | HIGH | No `statement_timeout` → a stuck pooler can hang the worker (the 2026-06-13 mode). | **Owner-aware decision** — touches the sensitive `pg.ts` config (the 2026-06-04 incident warns against connection caps). Recommend a generous server-side `statement_timeout` (e.g. 30s, well above real query times). NOT changed unilaterally. |
| M2 | MED | Duplicate migration number `0029` (two files). | Leave as-is (both already APPLIED; renaming an applied migration would re-run it). Renumber only NEW migrations from 0033+. |
| M3 | MED | ASSR CSV export loads up to 10k joined rows into the 128MB worker. | Backlog: stream/chunk to R2. |
| L1 | LOW | `pg.ts` comments say "6543 transaction pooler" but prod is on the **5432 session pooler** (60-conn SG-micro cap). `prepare:false` correct either way — stale docs only. | Backlog: fix comments. |
| L3 | LOW | Single error boundary; providers mounted outside the inner boundary (GlobalSearch/Notifications/etc.) fall through to the full-screen panel. | Backlog: wrap the provider/Layout chrome in its own boundary. |

### E. Data integrity (atomicity / money / column-casing)

**Column-casing — CLEAN.** No postgres.js `transform`/camelCase helper anywhere; both layers return snake_case; SCM consistently uses the safe dual-read `r.camelCase ?? r.snake_case`. The camelCase-driver bug in the memory note lives in the *sibling* HOOKKA/2990 projects, not here. No action.

**Money — audit flagged "cents truncated to integer columns" (M1-M3); VERIFIED REFUTED against the live DB.** The audit read `migrations-pg/0000_baseline.sql` (which demoted money columns to `integer`), but a later migration superseded it. Direct `information_schema` check on prod: `sales_entries.amount/deposit_amount`, `sales_entry_items.amount`, `sales_entry_payments.amount`, `project_finance.{rental,total_sales,contractor_cost}`, `project_finance_lines.amount`, `sales_reports.sales_amount` are **all `double precision`** — not integer. Evidence: 0 fractional rows lost, 0 header-vs-Σ(lines) mismatches (≥0.5). **Cents are preserved; no money corruption.** (Lesson: verify schema claims against the live DB, not migration files.) Tracked LOW only: M5 (float residue in `services/salesEntries.ts` line calc — add `round2`), M6 (`purchase-invoices.ts` multi-PI discount ±1 sen + a missing `Math.max(0,…)` clamp) — float-hygiene, not corruption.

**Atomicity — the one real remaining class (ROADMAP, not actively corrupting).** The SCM module is non-atomic by construction: each supabase-js `.from()` is a separate HTTP write, so a document create/post/cancel chains sequential writes (header → lines → rollup → inventory/GL) with NO enclosing transaction. A worker crash mid-chain leaves partial data. This is the same design as 2990's SCM and has been operating; the risk is low-frequency (only on a mid-write failure) but real. Highest-risk flows: SO create (voucher claim + header + payments + lines), SO cancel (deposit→credit), PO from-SOs, consignment-note dispatch (stock OUT), PC receive/return (stock IN/OUT), special-addons save (retire dropped codes). The `GET /reconcile` detector covers GRN/DO/PR/DR but NOT consignment / purchase-consignment / stock-transfer / stock-take. Core ERP is healthier — `.batch()` (a real `sql.begin()` transaction) is used at projects-reorder, users brand-set, ASSR reorder/profile-activate — but gaps remain: sales-entry edit (delete-then-reinsert payments/items), project create (header without its 1:1 `project_finance` row), ASSR createCase/transitionStage.
**Fix approach (roadmap):** wrap each multi-write flow in ONE Postgres function called via `.rpc()` (the atomic pattern already used at `scm/routes/products.ts:54` + `maintenance-config.ts:236`). Core: `.batch()` the sales-entry primitives + project create + ASSR (copy the working `assrPortal` profile-activate pattern). NOT a one-shot — sequence per-flow with verification, since each touches live documents.

**STATUS (2026-06-22 — the premise below has EXPIRED, read the next paragraph
first):** the SCM transactional layer is currently EMPTY (0 SOs / payments /
movements — verified live), so every atomicity gap is LATENT (nothing to corrupt
yet) and the routine crashes that would trigger a mid-write are fixed.

> **Corrected 2026-08-13. "Nothing to corrupt yet" is no longer true and it is
> the load-bearing half of this decision.** Later COEs in this directory work
> from live SCM documents and movements — `docs/unlinked-line-duplicate-coe.md`
> traces two DISPATCHED delivery orders and a double stock deduction,
> `docs/inventory-ledger-divergence-coe.md` a real movement-vs-lot divergence.
> The owner's choice of "detection safety-net over risky write-path rewrites"
> was made against an empty layer; it has not been re-taken against a populated
> one. **The current row counts cannot be settled from source — that needs a
> production read** — but the trade the owner accepted no longer has the
> property that made it cheap. Owner chose the **detection safety-net** over risky write-path rewrites of working-but-empty flows. **DONE + LIVE (PR #107):** `scm/lib/reconcile-ledger.ts` extends the ledger reconcile from GRN/DO/PR/DR to ALL stock-moving types (Stock Transfer `STOCK_TRANSFER` / Consignment Note `CS_DO` / Consignment Return `CS_DR` / PC Receive `PC_RECEIVE` / PC Return `PC_RETURN`; Stock Take excluded — a zero-variance take legitimately writes nothing; each matched on its PRIMARY movement label + header id, verified in code so a doc that moved stock is never false-flagged), surfaced at `GET /api/admin/health/ledger` (System Health, ok/warn + issueCount). So a silent partial-write becomes visible the moment real data flows. The atomic-write `.rpc()` rewrites remain the documented roadmap — to do per-flow with e2e + induced-rollback proof IF/when document volume + a real incident justify the rewrite risk (the consignment/PC flows are coupled to live FIFO costing: OUT → read costed → IN, a read-after-write that makes them delicate; do not rush).

---

## 4. The "slow" problem (distinct from the crashes)
The 12s cold-start hangs are **latency, not the crash** (now self-healing via retry). Root cure = upgrade Supabase compute off the **Micro** tier (Spend Cap off): Micro's slow backend spin-up + 60-conn cap is the ceiling. HOOKKA avoids cold-start only because its Hyperdrive points at the 6543 transaction pooler — **Houzs cannot copy that** (Hyperdrive→6543 = double-pooling, broke prod 3× per `project_houzs_ui_overhaul`). Every software mitigation HOOKKA lacks is already in place (keep-warm cron, frontend retry, d1-compat timeout, pool 40). **Compute upgrade is an owner billing decision.**

---

## 5. Operating principles (to keep the foundation solid while building)
1. **Never mutate shared isolate state per request.** Per-request data goes on a fresh object or Hono `c.set()` — never `c.env.X =` or a module-level mutable cache. (This was THE bug.)
2. **One source of truth for transient-error classification** (`TRANSIENT_CONN_RE`) — keep retry + user-facing classifier in sync.
3. **Idempotent GETs self-heal on 503; mutations retry ONE 503 and no other.**
   Corrected 2026-08-13 — this line said "mutations never auto-retry", which is
   the rule as it shipped in #103 and is not the rule today. A mutation IS
   replayed on the cold-pool 503 whose body matches
   `/briefly unavailable|warming up|try again in a moment/i`
   (`api/client.ts:328-331,476`, `vendor/scm/lib/authed-fetch.ts:265-274`),
   because the connection layer raises that answer BEFORE the handler runs, so
   nothing executed. Every other 5xx on a mutation is surfaced, never replayed.
   The test before adding anything to a retry set is "did this reach the
   server?" — see `docs/db-cold-start-503-coe.md` §7 lesson 2.
4. **All raw SQL is Postgres dialect.** Drizzle `` sql`` `` fragments bypass the rewrite shim — write `ILIKE`, no `strftime`/2-arg `date()`, guard `''::timestamptz`.
5. **Every list query is bounded.** supabase-js silently caps at 1000 — always `.limit()`/`.range()`.
6. **Migrate before deploy** (already enforced in CI). New migrations numbered from 0033+. The "keep `;` out of `$$` bodies" clause is retired — H1 shipped a dollar-quote-aware splitter (`scripts/lib/split-sql.mjs`), which is what lets a PL/pgSQL body live in the migration tree at all.
