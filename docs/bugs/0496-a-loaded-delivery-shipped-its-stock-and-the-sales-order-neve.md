## A LOADED delivery shipped its stock and the Sales Order never heard [high]

<!-- area: Delivery, DO, returns -->

**白话.** DO 从「已装车」（LOADED）升到「已发出」（DISPATCHED 等）时，库存照常
扣、客户照常算已收货——但通知 SO「你被交付了」的那一步只认「从 DRAFT 升上来」这
一种情况。走过 LOADED 的单：货出了、SO 停在原状态、MRP 继续替这批已上路的货下采
购单。8-17 那次「已经出货了为什么 MRP 还叫我下单」就是这一类。

**Symptom.** Found in the 2026-08-21 full-flow source audit while verifying the
#2557 LOADED sweep: the coverage engines were all moved onto
`doCountsAsDelivered`, but the ship-time hook in the status PATCH still read
`if (prevStatus === 'DRAFT')`. Any DO that passes through LOADED before
dispatch ships without `syncSoDeliveredFromDo` ever running — the SO stays at
CONFIRMED/READY_TO_SHIP with its lines PENDING, and `SO_DONE` never sees it,
so MRP keeps planning the same goods. (LOADED→DELIVERED was covered by the
separate `toStatus === 'DELIVERED'` sync; the gap was LOADED→DISPATCHED /
IN_TRANSIT / SIGNED / INVOICED.)

**Root cause (traced).** `backend/src/scm/routes/delivery-orders-mfg.ts`,
status PATCH shipped-entry branch: the inventory OUT fires on entry to any
`SHIPPED_STATES` member from EITHER pre-ship status (the transition guard and
`DO_PRESHIP_STATUSES` both say DRAFT and LOADED are the pre-ship pair), but
the SO-sync beside it was gated on the DRAFT literal only. The two halves of
one event — "stock left" and "tell the SO" — keyed on different predicates.

**Fix.** The sync gate now reads `DO_PRESHIP_STATUSES.has(prevStatus)` — the
same shared set (`shared/do-shipped-states.ts` `DO_PRESHIP_STATES`) the
deduction path keys on. `backend/tests/doStatusShipSyncPreship.test.ts` slices
the shipped-entry branch (bounded at the deduction call and the customer-email
comment) and pins: the sync is gated on the shared set, no `prevStatus ===
'DRAFT'` literal remains in the branch, and `DO_PRESHIP_STATUSES` is built
from `DO_PRESHIP_STATES` rather than hand-typed. Proved RED on the unfixed
tree (the literal-gate assertion fails there), GREEN after.

**Ref.** fix/do-loaded-preship-leak, 2026-08-21.
