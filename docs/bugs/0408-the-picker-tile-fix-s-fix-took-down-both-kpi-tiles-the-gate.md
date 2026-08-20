## The picker-tile fix's fix took down BOTH KPI tiles — the gate handed the user where the permissions go [high]

<!-- area: Sales orders + pricing -->

**白话.** 昨晚修「选销售、卡片数字不跟」的第二版,今早一开就两张卡片一起「加载失败」。
原因:权限检查的函数要的是**权限清单**,我塞给它的是**整个用户**。它拿到用户就调用
清单才有的方法,当场炸掉,整个接口 500,两张卡片共用这一个请求,所以一起红。编译器
本来会拦住这个错 —— 是我自己用 `as never` 把它的嘴捂住的。这次把检查抽成一个可以
**真正跑起来**的函数,测试直接用真实的用户形状调用它;前两版都是"检查源代码里有没有
这行字"的测试,字都在,功能都是死的。

**Symptom.** After #2501's deploy, GET /pos/sales-stats 500s whenever a
salesperson is picked; ONE query feeds both KPI tiles, so Showroom and Personal
both render "Couldn't load". Reported with a screenshot within the hour — the
second same-day report against this tile.

**Root cause (traced).** `hasPermission(granted, required)` takes a permissions
COLLECTION (array or Set). #2501 passed it the session USER:
`hasPermission(caller as never, …)` → `(user as ReadonlySet).has(…)` →
`user.has is not a function`, thrown before any response. The `as never` cast
is what let it compile — it silenced precisely the type error that was
describing the bug. And the wiring test pinned the SOURCE TEXT of the call, so
it stayed green while the endpoint threw: the second consecutive version of
this gate to die in a way a textual pin cannot see (#2501's own entry records
the first).

**Fix.** The gate is now `canTargetSalesperson(caller, wantSalesperson)` —
EXPORTED and PURE, reading `caller.permissions_set ?? caller.permissions ?? []`
and feeding isDirectorUser only the two fields it declares. The route calls it
with one widening cast that still checks every property read (no `as never`
anywhere). The test EXECUTES it: director / flat key / `*` / plain-sales /
no-session / '' / 'all', plus a must-not-throw on the exact shape that 500'd.
The remaining textual pins only keep the guard clauses from being edited out.

**Ref.** fix/sales-stats-gate-perms, 2026-08-20. Corrects #2501, which corrected
#2477. Same reporter all three times.
