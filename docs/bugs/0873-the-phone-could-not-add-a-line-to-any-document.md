## The phone could not add a line to any document [medium]

**Symptom.** On a phone, a purchase order, goods receipt, purchase invoice or sales
invoice offered no way to add a line. On a sales order the editor could add one,
but only after pressing Edit and under the retired spelling "+ Add Line Item" —
the exact unfindable-affordance shape `docs/bugs/0853-add-a-line-was-only-reachable-from-inside-edit-under-four-di.md`
fixed on desktop. Owner ruling 2026-09-12: 「电脑版本有的，手机版本都要有」.

**Root cause (traced).** Missing surface. Re-run against `origin/main` when this
entry was written:

```
$ git grep -n "ADD_LINE_LABEL" origin/main -- frontend/src/mobile
(no output, exit 1)
$ git show origin/main:frontend/src/mobile/MobileNewSO.tsx | grep -n "+ Add Line Item"
2557:                    <button className="addline" onClick={() => setLines((p) => [...p, newLine()])}>+ Add Line Item</button>
```

And a second, quieter half: the rule for "is this document still open for a new
line" existed ONLY as inline expressions inside the desktop editors —
`const isLocked = ...` in `PurchaseOrderDetail.tsx`, `GoodsReceivedDetail.tsx` and
`PurchaseInvoiceDetail.tsx`, and `siIsDraft` in `SalesInvoiceDetailV2.tsx`. A
phone copy of any of them would have been invisible to `check-shared-mirrors`.

**Fix.**

- `frontend/src/vendor/scm/lib/line-add-lock.ts` — the four lock rules, moved out
  of the desktop editors, which now call them. `lineAddLock.test.ts` pins the
  truth tables and scans the editors so an inline copy cannot grow back; it was
  RED (5 failing) before the editors were switched.
- `frontend/src/mobile/mobile-add-line.ts` + `MobileAddLine.tsx` — "Add line" in
  place under the line items on the phone detail (PO / GRN / PI / SI), gated by
  the per-document operate helper AND the shared lock rule, posting through the
  SAME vendored add-item hooks with the desktop add rows' bodies. Refusals stay
  inline and the row keeps what was typed.
- Sales order: `MobileSODetail.tsx` offers "+ Add line" beside Edit (same lock as
  Edit, plus `canWriteSo`), `MobileApp.tsx` carries the intent, and
  `MobileNewSO.tsx` opens a new line with the product picker already up. The
  editor's button now reads `ADD_LINE_LABEL`.
- `addLineHandoff.test.ts` extended to the phone — proved RED on the pre-change
  phone files (`expected ... to contain 'ADD_LINE_LABEL'`, and
  `expected ... to contain '<MobileAddLine'` with the component present but not
  mounted).

**A hole the test caught, not reading.** Before an unloaded header was guarded,
the phone offered "Add line" on a purchase invoice whose detail had not arrived:
the PI rule (CANCELLED, or anything paid) reads a missing status as OPEN, where
the PO / GRN / SI rules happen to read it as closed. The desktop never meets it
because it asks only once the invoice exists (`pi ? … : true`).
`mobile-add-line.test.ts` "offers nothing on a header that has not loaded" failed
with `pi: expected true to be false`; `mayAddLine` now refuses a header with no
status before asking any rule.

**Observed in a real 375px render** (local Vite harness; every `/api/` request
answered from fixtures — 0 passed through, 0 refused — because the dev proxy and
the vendored client both point at the production Worker): a POSTED goods receipt
showed "+ Add line"; picking an item and typing 12.50 sent one
`POST /api/scm/grns/g1/items` with `{ qty: 1, unitPriceSen: 1250, deliveryDate:
"2026-09-13", purchaseOrderItemId: null, ... }`, re-read the detail and closed the
row. The sales order editor opened with the picker up when handed the intent,
and did not when it was not.

**Found, not changed here.**
- `SalesInvoiceDetailV2.tsx` gates writing with a raw `pageAccess` check
  (`canWriteSi`), while the SI list and the phone use `canOperateSalesInvoices`,
  which also refuses the Sales cohort (owner 2026-07-17, Sales only looks). The
  phone follows the shared helper.
- The phone SO detail's footer shows Edit on a submitted order without
  `canWriteSo`; the new "+ Add line" there carries it.

**Ref.** feat/mobile-add-line, 2026-09-13.
