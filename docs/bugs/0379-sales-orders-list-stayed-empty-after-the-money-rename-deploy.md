## Sales Orders list stayed EMPTY after the money-rename deploy — hosted PostgREST kept serving the recreated views stale [high]

> **DISPUTED — read the other three before acting on this one.** This day's empty
> Sales Orders list has FOUR incompatible root causes recorded in this file, and two
> of them cite `backend/scripts/check-so-list-empty.mjs` for OPPOSITE conclusions about
> the PostgREST layer. Nothing here is retracted — it is not reconciled. See *One empty
> Sales Orders list, four incompatible root causes in this file* at the top of this file.


<!-- area: Sales orders + pricing -->

**白话.** 8 月 18 号那批把钱的栏位改名的改动上线后，销售订单列表整天都是空的，HOUZS
明明有 2,726 张单。查清楚了：单子、数据、数据库那张 view 全都好好的 —— 是「对外的那层
读取服务」（PostgREST）在改名之后一直用旧的状态在跑，没有跟着刷新。要人手叫它重新刷新才
会好；单靠改代码不会好。

**Symptom.** `GET /api/scm/mfg-sales-orders?page=1&pageSize=50` (NO status param)
returns HTTP 500 `{error:'load_failed', reason:'Requested range not satisfiable'}`
LIVE, and did not self-heal across the day. The grid masks it as "No sales orders
yet".

**Root cause (traced with two read-only probes; app-layer confirmed by
elimination).** The SCM routes read through HOSTED Supabase PostgREST
(`getSupabaseService` = supabase-js -> `SUPABASE_URL`, `db.schema='scm'`,
service_role), NOT direct pg. `backend/scripts/check-so-list-empty.mjs` proved,
against prod: direct pg returns 2726 for `company_id=1` through
`scm.mfg_sales_orders_with_payment_totals` (view faithful, base=2726/view=2726),
`service_role` reads all 2726 through it, grants/RLS fine. So the 0 is emitted by
the PostgREST layer, the only thing between pg (2726) and the app (0). The batch's
`0305` DROP/CREATE'd 11 views + a matview (applied 2026-08-18 16:27:59Z). The
`pgrst_ddl_watch`/`pgrst_drop_watch` event triggers exist and are ENABLED, so
PostgREST's schema MODEL was told to reload — yet PostgREST 14.5's `authenticator`
connection pool is 44 days old (oldest `backend_start` 2026-07-05), long predating
0305, and it kept serving the recreated views from stale state a model-reload does
not clear. The exact PostgREST count-0 micro-mechanism is UNKNOWN — hosted
PostgREST is not reachable from CI (no `SUPABASE_SERVICE_ROLE_KEY` in any Actions
scope), so it must be confirmed by the live app.

**Fix.** Immediate restore: force PostgREST to refresh —
`backend/scripts/reload-postgrest-schema.mjs` + `reload-postgrest-schema.yml`
(gated; default plan). `NOTIFY pgrst 'reload schema'`+'reload config'; escalation
`recycle=true` terminates PostgREST's stale connections so it reconnects fresh.
Code hardening that keeps ANY count-0 from surfacing as a masked 500 shipped
separately (fix/so-list-empty: `effectiveStatusFilter` + `isRangeNotSatisfiable`).
Durable prevention is an owner decision (see below) — a view-recreate that leaves
PostgREST stale must trigger a reload/recycle in the deploy, or avoid DROP/CREATE
of exposed views.

**Ref.** fix/so-list-restore-pgrest, 2026-08-19.
