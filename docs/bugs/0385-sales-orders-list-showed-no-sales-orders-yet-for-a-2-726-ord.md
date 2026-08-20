## Sales Orders list showed "No sales orders yet" for a 2,726-order company — hosted PostgREST served a recreated view STALE [high]

> **DISPUTED — read the other three before acting on this one.** This day's empty
> Sales Orders list has FOUR incompatible root causes recorded in this file, and two
> of them cite `backend/scripts/check-so-list-empty.mjs` for OPPOSITE conclusions about
> the PostgREST layer. Nothing here is retracted — it is not reconciled. See *One empty
> Sales Orders list, four incompatible root causes in this file* at the top of this file.


<!-- area: Sales orders + pricing -->

**白话.** 8 月 18 号凌晨（约 00:23 大马时间）改钱的字段（_centi 改 _sen）那次上线之后，销售单列表变成「还没有销售单」——其实那家公司有 2,726 张单。因为是半夜没人看到，整整挂了一天没人报。真正的原因不在我们的单据，单据一直都在；是 Supabase 那台负责对外的服务（PostgREST）在视图被重建之后，还在用旧的连线回答「0 张」。重启一次 Supabase 项目就好了。已经在上线脚本加了提醒：以后哪次上线重建了视图，日志会大声叫人去检查列表、必要时回收连线。

**Symptom.** After the 2026-08-18 money-rename deploy (~16:23–16:27 UTC = ~00:23 MYT), `GET /api/scm/mfg-sales-orders` returned empty; the SO list rendered "No sales orders yet" for company 1 (2,726 real orders). Off-hours, so unreported for ~a day. On the wire it was HTTP 500 "Requested range not satisfiable" (PostgREST count===0), but the frontend swallowed it and drew an empty list (C15 mask), so the console was clean.

**Root cause (traced).** Migration 0305 (`0305_money_centi_to_sen.sql`, #2438/#2441) renamed every `_centi` money column to `_sen`; a column rename forces DROP+CREATE of dependent views, so 0305 DROP+CREATE'd 11 scm views incl `mfg_sales_orders_with_payment_totals`. The list handler reads that view via HOSTED Supabase PostgREST (`getSupabaseService`), not direct pg. `check-so-list-empty.mjs` proved it: direct pg = 2,726 through the same recreated view, hosted PostgREST = 0. PostgREST's `pgrst_ddl_watch` fired and its schema MODEL reloaded, but its 44-day-old authenticator connection pool (oldest backend_start 2026-07-05) kept serving the recreated relation stale — a model reload does not clear the pool.

**Fix.** A full Supabase project restart recycled PostgREST's connection state and the list returned to 2,726 (confirmed on the ENDPOINT body — in-Worker probe read count=2726, then the real endpoint returned 121 KB of orders; NOT from the UI, which held a stale react-query snapshot). Gated recycle workflow shipped as #2450 (`reload-postgrest-schema.yml`). This closeout removes the two temporary `/api/scm/_diag` probe routes (#2457/#2460), writes `docs/so-list-postgrest-stale-coe.md`, and adds durable prevention: prefer `CREATE OR REPLACE VIEW` for additive changes (option A), and a conditional NON-mutating deploy WARNING in `pg-migrate.mjs` that fires only when the applied batch DROP/CREATE'd a view, naming the recycle escalation (`reload-postgrest-schema.yml` recycle=true). The auto-recycle-in-deploy path was left as the existing manual gated workflow + a P-7 runbook rule in `scm-view-trap-coe.md`, because an unconditional recycle on every deploy is its own risk.

**Ref.** This PR (chore/so-incident-closeout), 2026-08-19. See `docs/so-list-postgrest-stale-coe.md` and `backend/docs/scm-view-trap-coe.md` P-7.
