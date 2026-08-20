## Eight routes were deleted as dead code; their caller is the 2990 POS, in a repo this one cannot see [high]

<!-- area: Sales orders + pricing -->

**白话.** 8 月 18 号清掉了十个「没有画面在用」的接口。问题是：用它们的画面不在这个
仓库里 —— 是 2990 的 POS（销售用的平板），它自从 7 月 21 号切换之后就一直打这台
服务器。在这个仓库里搜「谁在用」当然搜不到，但它其实一直在跑。结果就是平板拿不到
商品目录、拿不到布料加价、拿不到运费。现在把八个有人用的接口放回去，并在每个档案
最上面写清楚「用的人在另一个仓库」，避免再被当成死代码删掉。

**Symptom.** After the 2026-08-18 deploy, the 2990 POS (pos.2990shome.com) gets
404 on its catalogue read and seven other endpoints. `GET /pos-pools/mfg-catalog`
is the POS's entire product-catalogue seam, so the tablet has no catalogue at
all; fabric-tier surcharges, delivery fees, quick picks, free gifts, the cart
sync and the Sales Analysis page fail with it.

**Root cause (traced).** #2422 removed ten route files on the finding that no
screen in THIS repo mounts them. The finding was correct and the conclusion did
not follow. Since the 2026-07-21 cutover the POS builds against
`erp.houzscentury.com/api/scm` (`VITE_BACKEND_TARGET=houzs`), and its
`authedFetch` resolves every path against that base. Neither repo compiles
against the other, so a repo-wide "find usages" here returns nothing while the
route serves live tablet traffic — the same blindness that produced the
`internal_expected_dd` -> `processing_date` incident on 2026-08-13, where a
rename shipped on the stated belief that no client sent the old key, and the POS
did. The guards (`scm.use(...)`) were left in place when the mounts went, so the
requests passed the area guard and fell through to 404 rather than 403.

**Fix.** Restore the eight routes that have POS call sites, re-mount them next to
the guards that were never removed, restore `posPoolsCatalog.test.ts`, and put an
EXTERNAL CLIENT banner at the top of each file naming the consumer repo and its
call sites, so the next dead-code sweep has the evidence in front of it.
`maintenance-push` and `payment-audit-log` have NO POS caller and stay deleted.
`sales-analysis.ts` is restored against the post-#2438 world: its five DB columns
and its wire fields move `_centi` -> `_sen`, which is a breaking wire change for
the POS, so the POS reads both spellings (2990's `dev_branch`) and that side must
deploy FIRST.

**Options for the durable fix (owner's call — this PR only stops the bleeding).**
1. *A contract test in this repo* that pins the POS-facing path list, so deleting
   a mount fails CI here. Cheapest, and it lives where the deletion happens.
2. *A smoke probe against pos.2990shome.com* in the deploy workflow. Catches
   more (renames as well as deletions), but couples this deploy to another
   system's uptime.
3. *Publish the POS's API contract into this repo* (a checked-in path+key list
   generated from the POS build). Strongest, and the only one that would also
   have caught the `processing_date` rename — but it needs someone to own
   regenerating it.

**Ref.** fix/restore-pos-routes, 2026-08-19. Reverses part of #2422.
