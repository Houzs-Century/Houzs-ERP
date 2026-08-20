## The salesperson picker's tile fix shipped double-broken — wrong gate context, wrong lookup key [medium]

<!-- area: Sales orders + pricing -->

**白话.** 昨天修「选了销售、上面的卡片不跟着换」，修完当天就被报告:名字换了,数字
还是自己的。查出来两个错叠在一起。第一,权限检查用的是 SCM 那边的助手,它认「总监」
要靠一个只有 SCM 中间件才会放好的东西,这条 /api/pos 路上根本没有 —— 所以**销售总监**
(这个选择器就是给他用的人)永远过不了检查。第二,查人用的是**名字**,而平板送来的
是**编号** —— 就算过了检查也永远查不到人,回落到自己。两个错的表现一模一样:静静地
回落,不报错。现在检查直接用本路上真实的用户,查人按编号来(带格式护栏),名字留作
手打的后备。

**Symptom.** Picking a salesperson on the My-orders board changes the Personal
tile's NAME but not its numbers — still the caller's own figures. Exactly the
defect the first fix (#2477) claimed to close, reported again within hours of
its deploy, with a screenshot.

**Root cause (traced).** Two independent faults, same silent fallback:

1. **The gate never opened for the person it exists for.** `canViewAllSales(c)`
   grants via the flat key OR the director position — but the director arm reads
   `houzsUser`, which only `scm/middleware/auth.ts` stashes. `/api/pos` runs the
   main `auth` middleware, which never sets it, so for a Sales Director the arm
   was dead on this route. `mayTarget` false → fallback to caller.
2. **Even an open gate looked up the wrong key.** The POS picker sends the staff
   **id** (`<option value={s.id}>`); the lookup matched `staff.name`. Every
   lookup missed → `target` null → fallback to caller.

Both faults produce the identical symptom — the deliberate fail-safe fallback —
which is also why one fix hid the other. And the wiring test pinned the gate's
NAME (`canViewAllSales`), not what it resolves against on THIS route's context;
it passed while the gate was dead.

**Fix.** On `/api/pos` the `user` context IS the real Houzs caller, so the gate
runs directly off it: `hasPermission(user, 'scm.so.view_all') ||
isDirectorUser(user)`. The lookup matches by **id** when the param is
uuid-shaped — guarded, because a malformed value on a uuid column is a 22P02
500, not a miss (the pin-login note in this file says so) — with name kept as
the non-uuid arm for hand-typed use. Unknown / unauthorised still falls back to
the caller, never to "no filter". The source pins now assert the gate's inputs
and the lookup key, not just a helper's name.

**Ref.** fix/sales-stats-target-by-id, 2026-08-19. Corrects #2477, found by YH.
