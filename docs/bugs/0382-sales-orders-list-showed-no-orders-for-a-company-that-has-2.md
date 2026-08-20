## Sales Orders list showed "no orders" for a company that has 2,726 of them — `?status=all` filtered on a status no order carries, and a page past the end 500'd [high]

> **DISPUTED — read the other three before acting on this one.** This day's empty
> Sales Orders list has FOUR incompatible root causes recorded in this file, and two
> of them cite `backend/scripts/check-so-list-empty.mjs` for OPPOSITE conclusions about
> the PostgREST layer. Nothing here is retracted — it is not reconciled. See *One empty
> Sales Orders list, four incompatible root causes in this file* at the top of this file.


<!-- area: Sales orders + pricing -->

**白话.** 8 月 18 号那批把钱的栏位 `_centi` 全改名 `_sen` 的改动上线后，销售订单列表
整页空白、写着「暂无销售订单」，可是 HOUZS 明明有 2,726 张单。真正的错误被前端吞掉了，
只有网路层看得到一个 500。查下去：数据、单子、那张 view 全都好好的 —— 是「查询」本身把
2,726 张单全滤光了，两个各自独立的毛病。

**Symptom.** `GET /api/scm/mfg-sales-orders?page=1&pageSize=50` → HTTP 500
`{ error:'load_failed', reason:'Requested range not satisfiable' }`; the grid
rendered it as "No sales orders yet" (a C15 masking — no console error). Same for
`&status=all`; `?page=0` returned a 200 with an empty array.

**Root cause (traced, not guessed — proven with a read-only `workflow_dispatch`
probe against prod, `backend/scripts/check-so-list-empty.mjs`).** The probe proved
the data and the view are intact and RULED OUT the view/scope theories: HOUZS
`company_id=1` base=2726 / view=2726, 2990=108/108, and `service_role` (the app's
own role via `getSupabaseService`) reads all 2,726 *through* the recreated
`mfg_sales_orders_with_payment_totals` view — so 0305's view DROP/CREATE, its
grants and the base table's policy-less RLS were not the cause; no company has 0
rows; salesperson_id is null on only 4 of 2,726. The live statuses are
CONFIRMED / READY_TO_SHIP / DELIVERED / CANCELLED / DRAFT — there is no status
`all`. Two real defects zeroed the query:
1. The handler applied the raw `status` param as `q.eq('status', status)`, so
   `?status=all` filtered to rows whose status is the literal string `'all'` → 0
   rows (probe: `WHERE company_id=1 AND status='all'` → 0). The frontend list
   hooks omit the param for the All tab, but bookmarks/shared links and the Mail
   Center views send `?status=all`.
2. With `count:'exact'`, a page whose offset is at/beyond the count makes
   PostgREST answer PGRST103 / 416 "Requested range not satisfiable" instead of an
   empty 200; the handler turned that into a 500, which the grid then masked.

**Fix.** New `backend/src/scm/lib/so-list-filters.ts`. `effectiveStatusFilter`
maps `all` / `ALL` / `''` → no status filter (OTHER and every real status pass
through), wired into the legacy path, the paginated page query and the money-KPI
closure. `isRangeNotSatisfiable` lets the paginated read return an EMPTY PAGE (200)
with the true count instead of a 500 for any past-the-end request (empty status
tab, no-match search, last page + 1). Unit test `so-list-filters.test.ts` pins
both. Backend typecheck 0; swallowed-reads at ceiling.

**Ref.** fix/so-list-empty, 2026-08-19.
