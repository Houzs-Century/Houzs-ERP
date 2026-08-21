## A second identical delivery pressed into the stale GRN form vanished as a replay [high]

<!-- area: Purchase orders + GRN + PI -->

**白话.** GrnNew 每次挂载只铸一把幂等钥匙，成功后页面不跳转、行也不清空——这
是有意的设计（防双击重复入库）。但它有一个静默分支：同规格第二批货到了，操作员
在还开着的旧表单上直接再按 Create——请求内容逐字节相同，中间件把第一张 GRN 的
201 原样重放，对话框却写着「created / Received & posted」。**第二批没有建单、
没有入库**，PO 还显示只收了第一批，货在地上账上没有。修法＝页面自己识别重放
（同一挂载同一钥匙只可能铸出一个 id，返回相同 id 即重放），对话框改口明说
「没有写入任何新单据」，并指路 picker 开真正的新收货单。

**Symptom.** Found in the 2026-08-21 full-flow source audit (item B1). The
in-file ruling ("Accepted, not overlooked") covered the accidental re-press —
replay is the correct answer there — and noted the dialog "names the FIRST
GRN's number", but a number alone cannot tell "created now" from "answered
again", which is exactly the information the second-batch operator needed.

**Root cause (traced).** `middleware/idempotency.ts` replays a stored 201
verbatim when the request hash matches, marking it only with an
`Idempotent-Replay` response header — and `authedFetch` surfaces no headers,
so `GrnNew.tsx`'s success path could not distinguish the two outcomes and
rendered the same "created" dialog for both.

**Fix.** `GrnNew.tsx`: a mount-scoped `lastCreatedIdRef` — one mount + one key
can only ever mint one id, so the same id answered twice IS the replay. The
replay branch still runs the post half (idempotent, and it is the recovery
path when the first submit's post failed), then shows a dialog that says the
receipt "was already created", that no second GRN or stock movement was
written, and that a genuinely new batch starts from Transfer from Purchase
Order. `frontend/src/pages/scm-v2/grn-new-replay.test.ts` pins the detector,
the dialog copy, and the detect→post→dialog order; RED on the unfixed tree
(none of the pinned strings exist there), GREEN here.

**Ref.** fix/grn-replay-lost-receipt, 2026-08-21.
