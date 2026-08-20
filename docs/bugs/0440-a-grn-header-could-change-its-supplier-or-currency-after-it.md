## A GRN header could change its supplier or currency after it was invoiced, silently diverging from the Purchase Invoice billed against it [medium]

<!-- area: Purchase orders + GRN + PI -->

**白话.** 一张收货单（GRN）已经开了采购发票之后，还可以在收货单上改供应商或货币 —— 系统
完全没挡。发票是照着原本的供应商和货币开的，收货单一改，两张单就对不上了，而且没有任何提示。

**Symptom.** `PATCH /grns/:id` (the header edit) had **no downstream-child guard at
all** — unlike the PO header, whose `poHasDownstream` lock predates this. A GRN that
already had a Purchase Invoice or Purchase Return could have its `supplier_id`,
`currency`, `exchange_rate` or `allocation_method` changed, diverging from the
PI/PR that was billed and cost-allocated against those exact values, with no error.

**Root cause (traced).** `grns.patch('/:id')` carried a warehouse-relocation guard
and a foreign-rate guard but never called `grnHasDownstream` (the four other GRN
handlers — cancel, line add/edit/delete — do). So the header was field-open and
unguarded; the PO's field-level pattern (`po-identity-lock.ts`) had no GRN twin.

**Fix.** Added a field-level inherited-field lock (owner 2026-08-20, §8 GAP-1 of the
workflow-unification spec): once `grnHasDownstream` is true, the four costing/party
columns freeze (409 `grn_header_inherited_locked`); received date / delivery-note
ref / warehouse / notes stay editable. `grn-inherited-lock.ts`
(`grnHeaderInheritedChanges` + `GRN_HEADER_INHERITED_COLS`), wired before the
stock-relocation block so a locked edit writes nothing; the FE
`GoodsReceivedDetail.tsx` relaxes its previously over-strict whole-freeze to the
same field-level split. Test: `grnHeaderFieldLock.test.ts` (own-stage saves with a
PI present; supplier/currency change → 409, nothing written).

**Ref.** refactor/txn-field-lock-siblings, 2026-08-20.
