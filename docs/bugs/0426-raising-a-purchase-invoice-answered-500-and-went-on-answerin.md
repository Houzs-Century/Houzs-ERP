## Raising a Purchase Invoice answered 500, and went on answering it [high]

<!-- area: Purchase orders + GRN + PI -->

**白话.** 老板从 Goods Receipt 开 Purchase Invoice,`POST /purchase-invoices` 回 500,
屏幕只写「系统出问题了」。真正卡住人的不是那第一次失败,是**之后再按 Save 也一样**:这个
画面从打开到关闭只用一把 Idempotency-Key,而中间层会把**任何**回应存起来 —— 包括 500 ——
同样的内容再送一次就把那个 500 原封不动还给你,后端根本没跑。改了内容再送,变成 409
「这把钥匙用过了」。唯一的出路是整页重开,单据全部重打。GRN 那边 2026-08-17 已经修过这
个死路,PI 这边没有。现在:凡是「什么都没写」的拒绝,都会把钥匙放掉,改好再按就能存;单据
一旦真的存进去了,后面就算出事也一定回 201,不会骗人说没存。顺带把讯息修好 —— 服务器本来
就写了给人看的句子,是前端挑错了字段、又把整句丢掉。

**Symptom.** Owner, production, 2026-08-19, walking SO → PO → GRN → PI on the
receipt behind `HC-PO-2608-002` (three sofa modules, all at unit price 0.00 —
the chain descends from an all-FOC order). `POST /api/scm/purchase-invoices` →
**500**, screen shows only *"The system hit a problem. Please try again — if it
keeps happening, let IT know."* It kept happening. Two sibling signals in the
same console: `/api/scm/grns` → 409 and the `new?grnId=…&fromPicks=1` page load
→ 504.

**Root cause (traced, and the first theory refuted by test).** The 500 is not a
crash. `POST /` has fifteen exits and every 5xx among them is a deliberate
fail-closed refusal; the zero-price theory was tested directly and is wrong —
`purchaseInvoiceZeroPriceCreate.test.ts` drives the real handler on that exact
document and gets 201, because the arithmetic is guarded where it is done
(`landed-allocation.ts` states the no-op guarantee for a zero pool and the
divide-by-zero fallback for a zero basis; `recost.ts` reads 0 as "no price
known" rather than dividing by it).

What made ONE refusal permanent is the idempotency claim. `PurchaseInvoiceNew`
mints one `Idempotency-Key` per page mount (`lib/idempotency.ts`
`useIdempotencyKey`), `middleware/idempotency.ts:363-373` persists **every**
terminal response "not only 2xx", and `:289-296` replays it for the identical
payload — so the first refusal is frozen against that key, the handler is never
reached again, and a corrected payload gets `idempotency_key_reused`
(`:167`) instead. Only a page reload escapes, and it throws away the invoice.
`grns.ts` closed exactly this on 2026-08-17 (`lib/no-write-refusal.ts` carries
the trace); `purchase-invoices.ts` contained `refuseWithoutWriting` zero times,
so the step after the receipt kept the dead end the receipt lost.

The screen said nothing for a second, independent reason.
`humanApiError` preferred `reason` over `message` and then dropped it: `reason`
on these bodies is the driver's own text, which its hygiene filter is right to
refuse — so the operator's sentence sitting beside it was never even read. And
sixteen refusals across the tree staple the driver's words onto the END of the
operator sentence (`…Please try again (column … does not exist).`), which made
the whole sentence unsayable, not just the bracket.

**Fix.** Three, and the first two had to ship together. (1) Every refusal
`POST /` can emit now answers through `refuseWithoutWriting`, which releases the
claim — the twelve pre-write exits unconditionally, and the three past the first
write only on a rollback whose delete error came back null, because releasing a
claim wrongly costs a duplicate payable while keeping one costs a retype.
(2) Once the invoice is committed the answer is 201 whatever happens after: the
five best-effort side-effects are wrapped, so a throw above one of their catches
can no longer tell an operator that a saved invoice failed — which, with (1) in
place, is the one shape that could produce a second payable. (3) `humanApiError`
tries `message` before `reason` and, when a sentence fails only because of a
trailing bracket, drops the bracket instead of the sentence; `insert_failed` /
`items_insert_failed` / `load_failed` gained the sentence they never had.

**The other two signals, named rather than fixed here.** The `/grns` **409** is a
legitimate refusal — almost certainly `zero_cost_receipt`, the guard that
refuses receiving at RM 0 an item bought at a real price before. Its message is
**202 characters** and `humanApiError` drops a server sentence at 200, so the
operator got the generic 409 line and not the two remedies the body carries.
Measured, not inferred; the message is one word from fitting. The **504** on the
`new?grnId=` page load is a gateway timeout on the SPA document request, outside
this handler and not reproduced.

**Ref.** this PR, 2026-08-20. Reproduced first, then fixed:
`backend/tests/purchaseInvoiceCreateRefusalDeadEnd.test.ts` (the replayed 500
and the corrected-payload 409, through the real middleware and the real router),
`backend/src/scm/routes/purchaseInvoiceCommittedNeverFails.test.ts` (500 before
the wrap, 201 after), `frontend/.../authed-fetch.message-beats-reason.test.ts`.
Completeness gate: `backend/tests/piCreatePreWriteRefusalsReleaseKey.test.ts`,
the PI sibling of `grnPreWriteRefusalsReleaseKey.test.ts` — it lists all twelve
missed exits when run against the pre-fix router.
