# Deploy verify (#3977, #3982) + PMS venue truth — 2026-09-15

Read-only investigation. No DB writes, no code edits, no merges.

---

## TASK 1 — Are #3977 and #3982 actually live in production?

### PR #3977 — SO consecutive-save lock fix (backend + frontend) — **PROVEN LIVE**

- Merge commit: `086d929d99bd26aaf79520aba8670e5fe216d0b6`, merged 2026-09-15 13:42:40Z.
- Deploy run: **id `34976768973`**, event=push, head=`086d929d`, conclusion=**success**.
- Jobs: `backend` = **success**, `frontend` = **success** (also all 5 backend-test shards success; `notify-failed-release` skipped as expected).
- Verdict: shipped. Both halves deployed.

### PR #3982 — Fair field shows the saved venue, not "Others" (frontend-only) — **PROVEN LIVE (via the next deploy)**

- Merge commit: `b9aea5cd3f6d04f22e11102fe72604f76f3552d6`, merged 2026-09-15 13:43:41Z.
- Its OWN deploy run (**id `34976881820`**, head=`b9aea5cd`) was **cancelled** — superseded by the concurrency group when later merges pushed newer commits seconds later. So #3982 did NOT ship on its own run.
- It shipped on the **next successful deploy**: run **id `34977524431`** (PR #3980, head `296d0cb862`), conclusion=success, `frontend` job = **success**, at 13:49:34Z.
- Ancestry proof: `git compare b9aea5cd...296d0cb8` = **status ahead, behind_by 0** — i.e. `296d0cb8` contains `b9aea5cd`. The Deploy workflow builds and deploys the checked-out HEAD (full frontend artifact), so deploying `296d0cb8` deployed #3982's `SalesOrderNew.tsx` change. Every later push-deploy (up to #3989 at 14:26:55Z, success) also contains it.
- Verdict: live. Its dedicated run was cancelled, but the change reached production on the immediately-following successful frontend deploy 6 minutes later.

**Both PRs are in production.** (#3977 on its own run; #3982 on the #3980 run.)

---

## TASK 2 — "If I pick a salesperson on a project, does that salesperson's venue attach, and do all their SOs get it?"

### 白话文答案（先讲结论）

老板的想法**方向对，但主角搞反了，而且不是「永远」**。

1. **决定场地的是「项目」，不是「业务员本人」。** 在 PMS 把一个业务员设为某个项目的 Sales Attending / PIC，系统不是把「这个业务员的场地」贴上去，而是把**那个项目的场地**（`projects.venue`）自动带到他开的销售单上。

2. **只在项目的展期内有效，不是他所有的单。** 只有当销售单的**日期落在该项目的开始~结束日期之间**（结束日含当天）才会自动带。项目结束后开的单，就不再带这个场地了。同一个业务员如果同时挂在几个项目上，系统按「最近开始、期间最短、id 最小」挑一个。

3. **这是「预设值」，不是「锁死」。** 自动带上去只是默认，操作员可以改；一旦有人手动选/打了场地，系统标记为 MANUAL，之后任何自动重算都不会再覆盖它。

4. **业务员「本人的场地」是另一条、优先级更前的路。** 每个业务员的资料上有一个 home venue（`scm.staff.venue_id`）和/或挂在某个陈列室下（showroom parking）。开单时如果业务员有 home venue，会先用它；PMS 项目场地只有在前面都没填出场地时才补上。

5. **如果什么都对不上，场地就是空白** —— 系统绝不乱猜一个，因为场地关系到展会 P&L 和佣金，猜错等于把利润算到别人头上。空白是诚实的，猜错不是。

**所以：** 「挑业务员到项目 → 那个业务员的场地自动贴上 → 他所有单都拿到」——不完全对。正确说法是：**项目的场地，会在项目展期内，自动作为默认值带到相关业务员开的单上，可改，过期即止。** 业务员自己的 home venue / 陈列室场地是另外两条来源。

### 证据（代码路径，放最后）

**新单表单（前端）** `frontend/src/pages/scm-v2/SalesOrderNew.tsx`
- `resolvedVenueId = selectedStaff?.venueId ?? currentStaff?.venueId`（~L1024）——被选业务员的 **home venue**（`staff.venue_id`）。
- `autoVenue` 来自 `GET /mfg-sales-orders/active-venue`（~L1069-1088），一进页面就抓一次，**不带 salesperson 参数、不带日期**，所以它算的是**登入者（开单人）本人**、用**今天（MYT）**的绑定。
- 显示优先级 `effectiveVenueName`（~L1042）：`fairPick.venue`（由 /active-venue 的 PMS/陈列室绑定 seed）→ `pickedVenueId ?? resolvedVenueId`（home venue 兜底）。都只在「还没人手动选」时才自动填。

**/active-venue 处理器（后端）** `backend/src/scm/routes/mfg-so-fairs.ts:242`
- 用登入者 `houzsUser.id` + soDate（默认今天 MYT），调 `resolveVenueBinding(...)`，再把场地名对到 `project_venues` 的 master id。**不读 `staff.venue_id`。**

**绑定规则（后端，唯一真源）** `backend/src/scm/lib/venue-binding.ts`
- `resolveVenueBinding` 顺序：**① PMS**——该人是 PIC 或 Sales Attending 的项目，且 SO 日期落在 `start_date..end_date`（含末日）区间内 → 取 `projects.venue`；同期多个时 tie-break：最近 start → 最短期间 → 最小 id。**② Showroom**——`staff.showroom_warehouse_id` → `warehouses.venue_name`。**③ NOTHING（null）**。无 company 默认、无「列表第一个」、无 `?? ''`。
- `canAutoResolveVenue`：source=`MANUAL` 时禁止自动重算覆盖。

**建单落库（后端）** `backend/src/scm/routes/mfg-sales-orders.ts`
- `venueIdToStamp` 优先级（~L3324-3344，migration 0086 / Loo 2026-06-06「venue follows the SELECTED salesperson」）：① `body.venueId` → ② **被选业务员的 `staff.venue_id`** → ③ 开单人自己的 `staff.venue_id`（POS 角色）。
- `resolvedVenueName`（~L3351-3366）：① `body.venue` 文本（标 MANUAL）→ ② 从 `venueIdToStamp` 解出的 home venue → ③ `bindVenueOnCreate`（= 上面的 PMS/陈列室规则，用**开单人** userId + 被选业务员 staffId + soDate）**只在前两者都空时才补**。

注意一个细节：建单时 PMS 那半用的是**开单人**（`houzsUser.id`）挂的项目，陈列室那半用**被选业务员**的 staffId。所以「代下单」时，项目场地跟着开单人走，home/陈列室跟着被选业务员走。

标签：TASK 1 全部 **PROVEN**；TASK 2 结论与优先级 **PROVEN**（源码逐行追出，未跑生产查询——生产上具体某业务员当下解出什么场地属 UNKNOWN，本次未查库）。
