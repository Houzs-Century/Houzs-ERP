## Converting a Sales Order on the PHONE shipped the goods on the spot [critical]

<!-- area: Delivery, DO, returns -->

**白话.** 手机上把销售单转成送货单，货就直接出了 —— 库存立刻扣、销售单直接变成
「已送达」、客户还收到邮件。中间没有任何复核，也没有撤销。桌面版不是这样：桌面只
是个选行的画面，选完跳到新增送货单表单，那边有「存为草稿」的开关。同一个精灵里的
收货 (GRN) 那一支早就写了 `asDraft: true`，还留了注解说不要自动过账库存 —— 送货单
这一支单纯漏掉了。改法：送货单也送 `asDraft: true`，落成草稿，由人确认后才出货。

**Symptom.** `MobileConvertWizard` with `target="do"` posted
`POST /delivery-orders-mfg/from-sos` with `{ picks }` and nothing else. One tap
on a phone — commonly in a customer's driveway — and the stock was out, the
Sales Order was advanced to delivered, and the customer delivery email was sent.
There was no review step between picking the lines and the goods leaving the
building, and no undo: reversing it means cancelling the DO, which is the path
whose own reversal defect is recorded two entries below (DO-2607-005).

**Root cause (traced).** `from-sos` is born SHIPPED unless the caller opts out.
In `createDoFromSoLinesHandler`
(`backend/src/scm/routes/delivery-orders-mfg.ts`):

    status: (body.asDraft === true) ? 'DRAFT' : 'DISPATCHED',

and the same flag gates the entire write half —
`if (body.asDraft !== true) { deductInventoryForDo(...);
syncSoDeliveredFromDo(...); maybeSendDeliveryOrderEmail(...) }`. So OMITTING the
field is not "leave it to the server", it is an affirmative "ship it now". The
mobile DO arm omitted it.

This was never a form-factor decision, and the proof is in the same file: the
wizard's GRN arm deliberately does NOT use the auto-posting `/grns/from-pos`
endpoint, and posts `asDraft: true` to the generic create instead, with a
comment reasoning explicitly about not auto-posting stock and about the operator
posting from the receipt. Desktop never had the shortcut at all —
`DeliveryOrderFromSo.tsx` is only a line picker that navigates into
`DeliveryOrderNewV2.tsx`, which carries a "Save as draft" toggle and sends
`asDraft`. Three of the four surfaces agreed; the mobile DO arm was the outlier.

**Fix.** The DO arm sends `asDraft: true`, mirroring the GRN arm in the same
file: the phone CREATES the document, a human CONFIRMS it, and that confirm
(`PATCH /:id/status`) is the single stock-writing chokepoint. The button label
follows the behaviour — "Create draft Delivery Order", the wording the GRN arm
already uses — because a CTA promising a Delivery Order while parking one is the
same misstatement pointed the other way. The short-stock pre-flight is
deliberately left running on the draft: it is not gated on `asDraft` server-side,
and it also resolves the incoming-PO commitments, so the "Ship anyway?" decision
is still taken once, by the operator who picked the lines.

Pinned by `frontend/src/mobile/mobileConvertWizardDraft.test.tsx`, whose fake
server is that ternary in miniature and counts stock movements rather than the
flag. Verified RED on the unfixed tree (`expected 'DISPATCHED' to be 'DRAFT'`).

**Surface change** — the mobile SO→DO convert now lands a DRAFT and the CTA says
so; `docs/modules/delivery-order.md` updated in the same PR.

**Ref.** fix/stock-movement-parity, 2026-08-20.
