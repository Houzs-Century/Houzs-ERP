## An invoiced delivery order still let the salesperson be changed [low]

**Symptom.** After the 2026-09-14 lock (`docs/bugs/0882-a-delivery-order-stayed-editable-after-its-sales-invoice-and.md`),
a delivery order with a live Sales Invoice or Delivery Return still let its
salesperson be changed, on the desktop edit form, the phone edit sheet and the
server PATCH.

**Root cause (traced).** Deliberate, and a question rather than a defect at the
time: `backend/src/scm/shared/do-header-lock.ts` (and its byte-identical frontend
copy) listed `salesperson_id` and `agent` in `DO_HEADER_OPEN_COLS`, because the
2026-09-14 ruling did not name the salesperson and a 2026-08-17 ruling says a
delivered order can be handed to a replacement salesperson. Put to the owner the
same day, he answered 「下游开了 上游就locked了啊」 — the next document locks the
whole header, salesperson included.

**Fix.** `salesperson_id` and `agent` move from `DO_HEADER_OPEN_COLS` to
`DO_HEADER_LOCKED_FIELDS` in both copies, so the server refuses the change and
both screens disable the field. The two screen tests that pinned the old ruling
(`MobileDoHeaderEdit.test.tsx`, `DeliveryOrderNewV2.headerLock.test.tsx`) now
assert the salesperson keys are NOT sent on a locked DO; against the unchanged
lock file they fail, and they pass on this change. `doHeaderLockPartition` still
proves every PATCH column is classified. Guide: `docs/modules/delivery-order.md` §6.

**Ref.** fix/do-lock-salesperson, 2026-09-14.
