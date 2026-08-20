## One empty Sales Orders list, four incompatible root causes in this file — recorded as unresolved, not reconciled [high]

<!-- area: Sales orders + pricing -->

**白话.** 同一件事——8 月 18 号销售订单列表空白、HOUZS 明明有 2,726 张单——这个档案里
现在有四个不同的原因，互相打架。最要命的是：两条说那支检查脚本「证明」问题出在 Supabase
对外那层（PostgREST），第三条说同一支脚本「已经排除」了那个可能。同一个工具，相反的结论。
这里不假装知道哪个对。**下次列表再空，四条一起读完再动手**，不要照碰到的第一条就去重启
Supabase——那可能是在修一个根本不存在的毛病。

**Symptom (shared by all four).** 2026-08-18: the Sales Orders list rendered
"No sales orders yet" for a company holding 2,726 real orders. The frontend
masked the underlying failure, so the console was clean.

**The four accounts, and what each rests on.**

| Blames | Evidence it cites |
|---|---|
| Hosted PostgREST serving the recreated view stale after 0305's DROP+CREATE; a Supabase project restart recovered it | `backend/scripts/check-so-list-empty.mjs`: direct pg 2,726 vs hosted PostgREST 0 |
| `?status=all` filtering on a status no order carries, plus a page past the end 500'ing | the SAME script, which it says **RULED OUT** the view and PostgREST theories: `service_role` read all 2,726 *through* the recreated view |
| Hosted PostgREST serving the recreated views stale (second entry, same mechanism as the first) | the same script again, read as proving the 0 is emitted by the PostgREST layer |
| The auth bridge running twice, permissions resolving empty | #2461's commit and `backend/tests/scmAuthBridgeIdempotent.test.ts` |

**The contradiction, stated plainly.** Two entries cite
`check-so-list-empty.mjs` as PROVING the PostgREST layer emitted the zero. A
third cites the same script as RULING THAT OUT. Both readings cannot be right
about the same run.

**What is NOT claimed here.** Which of the four is correct; whether more than one
fault was live in an overlapping window (the timestamps allow it — #2461 puts the
start at 16:00Z, and 0305 applied at 16:27:59Z, twenty-eight minutes later); or
what actually ended the outage — a Supabase restart and #2461's merge are both
recorded as the recovery.

**Why it is written as an open contradiction.** CLAUDE.md: *a contradiction is a
finding — STOP, do not bridge it.* A COE was drafted (#2453) that resolved it by
assertion and got both the duration and the cause wrong; it was closed on
2026-08-20 rather than left to be believed. Marking three entries "superseded"
would have been the same mistake in smaller handwriting — there is no evidence
they are wrong, only evidence they disagree.

**What would settle it.** A replay of `check-so-list-empty.mjs` is not enough,
because it cannot reach 2026-08-18's state. The decidable half is the ORDER:
Cloudflare request logs for `/mfg-sales-orders` across 16:00Z–16:28Z would show
whether the zero predates 0305's view rebuild. If it does, the PostgREST theory
cannot be the ORIGINAL cause whatever else it explains.

**Ref.** `chore/one-symptom-four-causes`, 2026-08-20. Closes out #2453 (closed
unmerged). Related: `docs/so-list-postgrest-stale-coe.md`.
