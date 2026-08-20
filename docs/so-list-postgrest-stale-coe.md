# Houzs ERP — Sales Orders list empty (hosted PostgREST served a recreated view stale) COE

**Date:** 2026-08-18 (resolved 2026-08-19)
**Status:** RESOLVED. Root cause traced to a hosted-PostgREST stale-pool condition after a view DROP+CREATE; cleared by a full Supabase project restart, verified live (list returns all 2,726 orders). Diagnostic routes removed; durable prevention below.

---

## 1. Incident — what staff would have seen

The Sales Orders list — the main screen the sales floor opens — showed
**"No sales orders yet"** for a company that has **2,726 orders** in the book.
An empty list, not an error dialog: the page looked like the company had never
sold anything.

It deployed at roughly **16:23–16:27 UTC on 2026-08-18**, which is **~00:23
MYT** — the middle of the night in Malaysia. Nobody was on the floor, so
**nobody reported it**, and it sat empty until it was found and traced the next
day. The off-hours timing is why a full-company outage of the primary sales
screen went a day without a ticket.

---

## 2. Root cause (traced, not guessed)

**Migration 0305 (`0305_money_centi_to_sen.sql`, PRs #2438 + #2441)** — the
one-shot rename of every SCM money column from `_centi` to `_sen` — could not be
a `CREATE OR REPLACE`: renaming a column that views select forces a
**DROP + CREATE** of every dependent view. 0305 `DROP VIEW`s and recreates
**11 scm views** (verified: `grep -c '^DROP VIEW' 0305_money_centi_to_sen.sql`
= 11), including `scm.mfg_sales_orders_with_payment_totals`, plus the
`mv_ar_aging` matview.

The SO list handler (`GET /api/scm/mfg-sales-orders`) reads that view through
**hosted Supabase PostgREST** (`getSupabaseService` → `db.schema='scm'`), NOT
through direct pg. After 0305's recreate, hosted PostgREST kept serving
`mfg_sales_orders_with_payment_totals` **as 0 rows** — a PostgREST
`count(*) === 0` symptom that surfaced on the wire as **HTTP 500 "Requested
range not satisfiable" (416-class)**.

**The tool that proved it** was `backend/scripts/check-so-list-empty.mjs`
(read-only, `secrets.DATABASE_URL`): **direct pg returned 2,726** for
`company_id=1` through the very same recreated view, while **the app's own
PostgREST client returned count 0**. Same view, same key, two answers — so the
recreated view was faithful and the fault was in the hosted PostgREST layer, not
in the SQL.

Why the model-reload did not fix it: PostgREST's `pgrst_ddl_watch` trigger is
enabled and **did fire at 0305's commit**, so PostgREST reloaded its schema
*model*. But its **authenticator connection pool was 44 days old** (oldest
`backend_start` 2026-07-05, long before 0305) and it kept serving the recreated
view from **stale connection state that a model-reload does not clear**. A
recreated view is a new relation; the old pooled backends never re-planned
against it.

**Why staff saw "no orders" and not an error:** the frontend **SWALLOWED** the
500 and rendered the empty result as "No sales orders yet" — a **C15-class mask**
(a swallowed read that renders as empty). Nothing appeared in the browser
console; the only visible signal was the **network 500 / empty body**. A staff
member looking at the screen had no way to tell "empty" from "broken".

---

## 3. Fix

| PR / action | What | Effect |
|---|---|---|
| **#2450** | `reload-postgrest-schema.yml` + `backend/scripts/reload-postgrest-schema.mjs` — a gated, plan-by-default workflow that `NOTIFY pgrst,'reload schema'` and, on escalation (`recycle=true`), `pg_terminate_backend`s PostgREST's authenticator backends. `pg-migrate.mjs` also began signalling the NOTIFY on every deploy. | Gave operators a one-click recycle path and made the common "new column PostgREST hasn't noticed" case self-heal. **Did NOT, on its own, clear the stale pool for this incident** — see below. |
| **Supabase project restart** (owner action) | A full project restart recycled ALL of PostgREST's connection state — the escalation the workflow's `recycle=true` targets, done at the platform level. | **Cleared the stale pool.** The list returned to 2,726. |
| **#2457, #2460** | TEMPORARY read-only `/api/scm/_diag/so-list-probe` + `/so-list-scope` routes — served the exact list query and its scope resolution FROM INSIDE the Worker (which holds `SUPABASE_URL` + `SERVICE_ROLE_KEY`), returning count/keys but never row data. | The layer CI cannot reach (hosted PostgREST HTTP) became observable in ~minutes. Verified count=2726 in-Worker, then the real endpoint returned **121 KB of orders**. |
| **This PR** | Removes #2457/#2460 entirely (route file, mount, import, unguarded-prefix entry, reverts the `HEADER` export); writes this COE; adds the durable prevention in §6. | The diagnostic surface is gone; the lesson is durable. |

**Verification of the resolution.** The restart's effect was confirmed by the
**endpoint body**, not the UI: the in-Worker probe read count=2726, then the
real `GET /api/scm/mfg-sales-orders` returned 121 KB of order rows. The
propagation was NOT immediate — see Lesson 1.

---

## 4. What the audit RULED OUT (with evidence)

The empty list has many plausible causes that were each **refuted by
measurement**, not by reasoning:

- **View lost its grants on recreate.** This is the classic Houzs view failure
  (0189 → 0190 → 0191 took the SO list down for everyone with an empty ACL on a
  recreated view; `docs/scm-view-trap-coe.md`). **Refuted:** the view is a
  DEFINER view read by the **service_role** client, which has `BYPASSRLS`; the
  *sibling* views recreated in the same 0305 batch (AR-Aging and the other 10)
  **worked throughout**. A grant/RLS fault would have hit them too. Direct pg
  through the same view returned 2,726.
- **`security_invoker` / RLS policy on the view.** **Refuted:** same evidence —
  definer view, service_role bypasses RLS, siblings fine.
- **Salesperson / company scope zeroed the query.** The list filters by
  `company_id` and, for a non-view-all caller, by `salesperson_id`; a scope that
  resolved to "match nothing" would also empty it. **Refuted** by the scope
  probe (#2460): `canViewAllSales=true`, `activeCompanyId=1` resolved correctly,
  and the exact handler scope returned **2726** — the scope was never the zeroer.
- **Recreate dropped rows / a filtered column.** **Refuted:** `base == view`
  count for every company via `check-so-list-empty.mjs`; the view still exposed
  `company_id` and `salesperson_id`.
- **Connection-pool age / query cache on our side, stale react-query snapshot.**
  **Refuted:** direct pg on a fresh connection returned 2,726 every time; the
  divergence was strictly at the hosted-PostgREST HTTP layer.

The single fact that survived every refutation: **direct pg = 2,726, hosted
PostgREST = 0.** That is what named the layer.

---

## 5. Lessons

1. **The restart DID work — its propagation was just slow. Do not declare a fix
   failed from an immediate re-check, and confirm the ENDPOINT BODY, not the
   UI.** After the recycle/restart, an immediate re-check can still read stale
   while PostgREST reconnects and Cloudflare/react-query hold a snapshot. The UI
   especially can show a stale react-query cache long after the API is healthy.
   Confirm on the **response body** — `Content-Range` / actual rows returned by
   the endpoint — not on what the page draws.
2. **A swallowed 500 rendered as "empty" hides from the console — watch network
   status codes.** The C15 mask meant the console was clean while the screen
   lied. The signal lived in the **network tab's status code**, not in any
   thrown error. When a list is unexpectedly empty, read the status code before
   believing the emptiness.
3. **When a layer is unreachable from CI, an in-Worker diagnostic route cracks
   it fast — reach for that EARLY.** Hosted PostgREST's HTTP layer has no Actions
   secret and cannot be probed from CI; the Worker itself holds the key. A
   read-only, admin-gated route that runs the exact query from inside the Worker
   turned a day of infra theorising into a minutes-long observation. Build that
   FIRST when the failing layer is one only the Worker can see — do not chase
   grants/RLS/scope theories against a layer you cannot measure.
4. **`SUPABASE_URL` / `SERVICE_ROLE_KEY` are Worker secrets, not Actions
   secrets — this whole class is invisible to CI.** No CI job can reproduce a
   hosted-PostgREST behaviour, because the credential to reach it exists only as
   a `wrangler secret` on the Worker. Any bug that lives at that layer will be
   green in every pipeline. The only measurement paths are (a) direct pg with
   `DATABASE_URL` (which does NOT go through PostgREST, so it cannot see this
   class) and (b) the in-Worker route from Lesson 3.

---

## 6. Durable prevention — the class, the options, and what shipped

**The class:** a migration that DROP+CREATEs a view exposed via PostgREST can
leave hosted PostgREST serving that view **stale** — including as 0 rows — until
a restart or connection recycle. A `NOTIFY reload schema` fixes the *model* but
not a stale authenticator pool.

Per the owner's "a root cause is a request for OPTIONS" rule, the options:

- **(A) Prefer `CREATE OR REPLACE VIEW` over DROP+CREATE.** A `CREATE OR REPLACE`
  keeps the same relation OID and grants, and PostgREST is far less likely to
  serve it stale. `0306_gl_views_join_on_company.sql` already does exactly this
  (3 × `CREATE OR REPLACE VIEW`, 0 × `DROP VIEW`) and caused no incident.
  **Limitation:** `CREATE OR REPLACE` cannot rename or remove an output column,
  and cannot reorder columns — which is precisely why 0305 (a column rename) was
  FORCED into DROP+CREATE. So this option covers additive changes only; a rename
  or removal still has to DROP+CREATE.
- **(B) When DROP+CREATE is unavoidable, recycle PostgREST after the deploy.**
  The gated `reload-postgrest-schema.yml` (merged, #2450) does the connection
  recycle (`recycle=true` → `pg_terminate_backend` of the authenticator
  backends). This could be wired into `deploy.yml` to fire automatically — but
  **only** when the applied migration batch touched a view, never
  unconditionally.
  **Risk:** an unconditional PostgREST recycle on every deploy causes a brief
  per-request blip on every release and is explicitly not wanted. A *conditional*
  automatic recycle depends on reliably knowing which migrations THIS deploy
  applied and on `pg_terminate_backend` behaving cleanly every time — enough
  moving parts that an auto-recycle in the deploy path is a flakiness and
  blast-radius risk not worth taking for a rare event.

### What shipped in this PR (the low-risk half)

**A documented migration-checklist rule + a conditional, non-mutating deploy-time
WARNING.** Not an automatic recycle.

1. **Checklist rule (runbook).** Added to `docs/scm-view-trap-coe.md` §4 as
   **P-7**: when a migration DROP+CREATEs a PostgREST-exposed view, after the
   deploy applies it you MUST verify the affected list endpoints return rows, and
   if any is empty, run **Actions → "Reload PostgREST schema" → mode=apply,
   confirm=RELOAD-PGRST, recycle=true** (or restart the Supabase project). Prefer
   `CREATE OR REPLACE` (option A) whenever the change is additive so the whole
   step is avoided.
2. **Conditional deploy WARNING (`pg-migrate.mjs`).** After applying migrations
   the runner already signals `NOTIFY pgrst,'reload schema'` (which handles the
   common additive case). It now ALSO scans the batch it just applied and, when
   any applied file contains `CREATE/DROP … VIEW`, emits a prominent
   `::warning::` naming those migrations and telling the operator that the NOTIFY
   is **not** the all-clear for a DROP+CREATE — verify the live list and escalate
   to `recycle=true` if empty. This is:
   - **conditional** — fires only when the applied batch touched a view (detected
     over the applied files' SQL), so an ordinary release is silent;
   - **non-mutating** — a log warning, never a `pg_terminate_backend`, so it
     cannot destabilise a deploy or flake;
   - aimed squarely at the failure that made this a day-long outage: the deploy
     is no longer allowed to look clean when it just recreated a view — the
     follow-up check is named in the deploy log itself, even at 00:23 MYT.

**Why the deploy-hook auto-recycle was NOT wired in (option B, automatic).** The
auto-recycle path is the risky half — an unconditional recycle is forbidden, and
a conditional one is flaky enough (batch detection + `pg_terminate_backend`
reliability on every view-touching release) that it is left as the **existing
manual gated workflow** plus the runbook step above. The deploy tells you when
to reach for it; a human pulls the trigger.

---

## 7. Related files

- `backend/scripts/check-so-list-empty.mjs` — the read-only probe that proved
  direct pg = 2726 vs hosted PostgREST = 0
- `backend/scripts/reload-postgrest-schema.mjs` + `.github/workflows/reload-postgrest-schema.yml` — the gated NOTIFY + connection-recycle remedy (#2450)
- `backend/scripts/pg-migrate.mjs` — the deploy migration runner; carries the unconditional NOTIFY and now the conditional view-recreate WARNING
- `backend/src/db/migrations-pg/0305_money_centi_to_sen.sql` — the DROP+CREATE of 11 views that triggered the incident
- `backend/src/db/migrations-pg/0306_gl_views_join_on_company.sql` — the `CREATE OR REPLACE` counter-example (option A)
- `docs/scm-view-trap-coe.md` — the sibling COE for the view-column-freeze class; P-7 (this incident's runbook rule) lives there
- `backend/src/scm/routes/mfg-sales-orders.ts` — the SO list handler that reads the view
