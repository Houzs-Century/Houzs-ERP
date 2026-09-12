## The delivery order never showed the money already taken on its order [medium]

**Symptom.** Open a delivery order and there is nothing about payment anywhere
on the page — not on the desktop screen, not on the phone. The sales invoice
made from the same sales order shows a "Collected on HC-SO-…" panel; the
delivery order between them shows nothing, so anyone working from the delivery
paperwork cannot tell whether a deposit was already banked.

Owner's ruling, 2026-09-12: 「付款记录，SO 的付款要带去 DO 跟 SI」.

**Root cause (traced).** Not a broken rule — a screen that was never built, on
top of a backend that was.

`scm.delivery_order_payments` exists, and `routes/delivery-orders-mfg.ts` serves
a full ledger over it: `GET /:id/payments` (5160), `POST /:id/payments` (5216),
`DELETE /:id/payments/:paymentId` (5258), salesperson-scoped through the parent
delivery order. The frontend hooks exist too —
`useDeliveryOrderPayments` / `useAddDeliveryOrderPayment` /
`useDeleteDeliveryOrderPayment` in `vendor/scm/lib/delivery-order-queries.ts`,
whose own header says *"The DO Create + Detail screens render the same Houzs
PaymentsTable"*.

That sentence is FALSE, and measured: `useAddDeliveryOrderPayment` and
`useDeleteDeliveryOrderPayment` have **zero call sites** in `frontend/src`, and
`DeliveryOrderDetailV2.tsx` contained no occurrence of the word "payment" at
all. So the table is a built, wired, unused feature and the comment describing
it was never true.

**Fix.** The delivery order now shows what the ORDER has collected — every
receipt, the total, and which document took it — on the desktop detail page and
on the phone, from the sales order's own ledger through the hook the invoice
screen already uses.

**CARRY MEANS SHOW, NOT RE-ENTER, and that is the judgement in this entry.** The
delivery order's own POST endpoint is deliberately left unwired. A deposit banked
against the order and then keyed a second time against the delivery order is the
same money counted twice, and the order remains the one place it is taken. If
recording ON the delivery is ever wanted, it is a business decision with a real
consequence (double counting against the sales order's outstanding) and it is
the owner's to make, not a drive-by.

The figure is computed by `vendor/scm/lib/collected-on-order.ts` rather than
inline, because a second implementation of a money rule is how the order screen
and the delivery screen start disagreeing quietly.

`error` is a REQUIRED prop on the card, not an optional one: a failed read whose
`data` becomes `[]` renders as "nothing collected", which would tell the office
to chase money that is already in the drawer. Same rule, same week, as
`docs/bugs/0848-a-change-log-that-could-not-load-said-no-history-yet.md`.

**Still true and NOT fixed here.** The comment in
`delivery-order-queries.ts` describing a DO Create screen that renders the
PaymentsTable is left as it is only because this PR does not touch that file;
the unused POST/DELETE pair is recorded above so the next reader knows it is
unused by choice rather than by oversight.

**Ref.** feat/do-payments-v2, 2026-09-13.
