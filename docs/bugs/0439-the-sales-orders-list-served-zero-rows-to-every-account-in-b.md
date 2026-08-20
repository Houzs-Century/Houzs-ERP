## The Sales Orders list served ZERO rows to every account in both companies — the auth bridge ran twice and permissions came back empty [high]

<!-- area: Sales orders + pricing -->

**白话.** 8 月 18 号傍晚起，销售订单列表对两家公司的每一个帐号都是空的，连老板的全权
帐号也一样，一直到隔天早上 11 点多才好——整整 11 个钟头，而且是上班时间。原因不在单据，
单据一直都在：同一个网址 `/mfg-sales-orders` 被挂了两次，负责「认人」的那段程式就跑了
两遍。它本来是一次性的翻译——把真正的使用者收起来，再把身份换成系统帐号；跑第二遍时，
它把系统帐号当成使用者去读，结果读出一个空的身份，权限全没了。系统没有报错，只是安静
地判定「你什么都不能看」，列表就滤到 0 张。

**Symptom.** From 2026-08-18 16:00Z until 2026-08-19 03:12:56Z (11h13m, ending
11:12 MYT — during working hours), `GET /api/scm/mfg-sales-orders` returned zero
rows for **every** account in **both** companies, the owner's `*` wildcard
included. Nothing threw and nothing appeared in the console; the grid drew an
empty list.

**Root cause.** Recorded from #2461's commit message and the test it ships, not
re-derived here. Two routers are mounted at the same `/mfg-sales-orders` prefix
in `backend/src/scm/index.ts` — the deferred list-enrichment router added
2026-08-18, then the main SO router — and each declares its own
`use('*', supabaseAuth)`. Hono runs the first mount's middleware, matches no
handler for the list path, falls through to the second mount, and runs the auth
bridge a SECOND time. The bridge is a one-way translation: it stashes the real
Houzs caller on `houzsUser`, then REPLACES `user` with the pinned `scm.staff`
system uuid. On the second pass it read that pinned uuid as if it were the Houzs
caller, so `Number("00000000-0000-4000-8000-000000000001")` gave `NaN` and
`houzsUser` came back with no id and no permissions. `canViewAllSales` went
false for everyone and `resolveSalesScopeIds` fail-closed to the match-nothing
staff uuid, so every list read went out as
`salesperson_id=in.(00000000-0000-0000-0000-000000000000)`.

**Fix.** Make the bridge idempotent: if `user` is already the pinned staff uuid
the translation has already run and a second pass has nothing left to do. Fixed
there rather than by un-double-mounting the prefix, because "no prefix is ever
mounted twice" is not something a route file can promise. Test:
`backend/tests/scmAuthBridgeIdempotent.test.ts` — one, two and three passes.

**Why this entry exists now, four days late.** It did not have one. `grep -c
"auth bridge" BUG-HISTORY.md` returned **0** and `scmAuthBridgeIdempotent`
returned **0** on 2026-08-20, while three OTHER entries for the same day's
symptom were present. The fix that carries a test was the one missing from the
ledger. See the entry directly below.

**Ref.** #2461 (`f6bb1345`, merged 2026-08-19T03:12:56Z); logged
`chore/one-symptom-four-causes`, 2026-08-20.
