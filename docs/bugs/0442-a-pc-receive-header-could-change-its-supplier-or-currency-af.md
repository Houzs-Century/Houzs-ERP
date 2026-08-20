## A PC Receive header could change its supplier or currency after a PC Return existed, with no guard at all [low]

<!-- area: Purchase orders + GRN + PI -->

**白话.** 寄售收货单（PC Receive）跟 GRN 一样，开了寄售退货之后还能改供应商和货币，系统
完全没挡。这是收货单那个漏洞的寄售版。

**Symptom.** `PATCH /purchase-consignment-receives/:id` (the header edit) had **no
downstream-child guard** — the same shape as the GRN header hole. A PC Receive that
already had a PC Return could change its `supplier_id` / `currency`, diverging from
the return costed against it, with no error. (Its sibling PCO and CN had a
whole-doc lock; only PC Receive was open.)

**Root cause (traced).** `purchaseConsignmentReceives.patch('/:id')` built its
`updates` and wrote them with no `pcReceiveHasDownstream` call (the cancel and
line-CRUD handlers have one). Mirrors the GRN header hole.

**Fix.** Field-level inherited lock (owner 2026-08-20, §8 GAP-1): `supplier_id` /
`currency` freeze once `pcReceiveHasDownstream` is true (409
`pc_receive_identity_locked`); received date / delivery-note ref / notes stay
editable. Uses the shared `changedLockedCols` + `identityLockedRefusal`
(`shared/header-inherited-lock.ts`). Test in `consignmentHeaderFieldLocks.test.ts`.
Shipped alongside the PCO + CN whole->field split in the same PR.

**Ref.** refactor/txn-consignment-locks, 2026-08-20.
