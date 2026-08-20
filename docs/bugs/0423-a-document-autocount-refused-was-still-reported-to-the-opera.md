## A document AutoCount refused was still reported to the operator as saved [high]

<!-- area: AutoCount sync + write-back -->

**白话.** 开单按下 Save,画面显示成功,五分钟后单据在 AutoCount 队列里被拒,没人知道。
拒绝的理由其实在按 Save 的那一刻就已经算出来了 —— 就在同一个请求里 —— 只是被丢掉,
只写进一张要特别权限才看得到的队列记录。现在两件事:(1) 销售单确认时,"有没有业务员"
改成问写回程式自己的那一条问题,所以 "Unassigned" 这种占位文字当场被挡下来,不再等到
队列里才死;(2) 其余拒绝理由(供应商没有 AutoCount 编码、料号对到两个 AutoCount 品项
而这张采购单的供应商一个都不属于)不挡单,但存档后当场用白话讲清楚"这张单还没进帐",
并且讲下一步找谁。不挡的理由是:那些要改的是主档资料,开单的人自己改不了 —— 挡住只会
停工又怪错人。

**Symptom.** Owner 2026-08-19: "开单的时候就挡住 AutoCount 一定会拒绝的形状,不要
等到五分钟后在队列里默默失败". Five documents sat refused in `scm.autocount_outbox`.
In every case the operator had been shown a successful save.

**Root cause (traced, PROVEN by reading origin/main @839fcaed0).** Two defects,
one shape.

1. **The refusal was computed and thrown away.** `enqueueSoCreate`
(`backend/src/scm/lib/autocount-outbox.ts:599`) composes the ENTIRE AutoCount
payload — item codes, locations, agent, sales location — and is `await`ed inside
the create request at `routes/mfg-sales-orders.ts:5557`, three lines before
`return c.json({ docNo }, 201)`. Every refusal is thrown right there, caught at
`:652`, filed as a `skipped` row by `noteReadFailure` (`:552`) — and the enqueue
returned a bare `false`. The row is real, but `scm.autocount_outbox` is behind
`scm.autocount.read` (`scm/index.ts:433`), which no salesperson or buyer holds.
Same shape on all three `enqueuePoCreate` anchors.

2. **The confirm gate and the composer disagreed about "has a salesperson".**
`so-confirm-gate.ts:101` asked `blank(salespersonId) && blank(agent)` — any
non-blank `agent` text satisfied it. `resolveAcAgent`
(`services/autocount-writeback.ts:666`) only trusts `agent` through `AGENT_MAP`
and otherwise falls back to the salesperson's name. MEASURED: for
`agent = "Unassigned"` with no `salesperson_id`, the gate returns `[]` and the
composer returns `null` → `MissingAgentError` → skipped row → 201. "Unassigned"
is HC-SO-2607-008's own value — the order the gate was created for on
2026-08-08, walking straight through it.

**Which of the five recorded causes are still live.** Four are closed by earlier
work and were verified, not assumed: the stock location (`so-location-gate.ts`,
PR #2112), the agent stamp (PR #2148), the conversion `DebtorCode` (PR #2341),
the transfer `CreditorCode` (PR #2345). ONE is reachable by a document raised
today, on the PURCHASE side only — measured against the compiled cutover map:
117 ambiguous ERP codes, 117 refuse under a creditor that owns none of their
candidates, 0 refuse when no supplier is named. A sales order names no supplier;
a purchase order always does. A CORRECTION to an earlier reading: the residual
"transfer-shaped PO to a code-less supplier" hole is NOT open —
`composeCreatePo` is called unconditionally at `autocount-outbox.ts:729`, before
the transfer/create branch, so `MissingCreditorError` fires for both shapes. The
AutoCount refusal is dead; the SILENCE was not.

**Fix.** `backend/src/scm/lib/ac-preflight.ts` — one home for the operator's
sentence and for the block-or-warn decision, re-deriving nothing: the verdict is
`resolveAcAgent` or the composer's own thrown refusal class.
- BLOCK, before the insert: `acAgentProblem` replaces the gate's third opinion,
  so the gate and the composer cannot disagree again. Zero new reads — both
  paths already select `salesperson_id, agent`. Newly refused set: orders with
  NO salesperson link whose `agent` is not an AutoCount agent. A rep hired since
  the cutover still passes (`resolveAcAgent` step 3 trusts any real staff name).
- WARN, after the save: `enqueueSoCreate` / `enqueuePoCreate` return
  `{ queued, problems }` instead of a bare boolean, and the create routes return
  `acNotSent` on the response. Never a 422 — the document is committed by then,
  and every remaining remedy is master data the operator does not own.
- `frontend/src/vendor/scm/lib/ac-not-sent.ts` reads the key and owns the title;
  the sentences travel verbatim. Wired on desktop SO create and all three PO
  anchors.

**Proof it is not vacuous.** Reverting the gate to `blank && blank` fails 3 of
17 `ac-preflight.test.ts` (the two bad shapes and the gate-vs-composer
agreement) with all 14 controls still green; reverting `enqueuePoCreate` to
discard `noteReadFailure`'s answer fails 2 of 106 in `autocount-outbox.test.ts`.
Controls assert a good document is never refused and never warned: a linked
salesperson, a mapped agent, an unambiguous line, a supplier with a code, the
flag OFF, and a cutover-imported document all stay silent.

**Not touched.** The five stuck documents and the two permanently unsendable
rows are the owner's decision; nothing was re-queued or repaired.

**Ref.** this PR, 2026-08-19.
