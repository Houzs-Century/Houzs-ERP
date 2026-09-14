## A service case created from an ERP sales order showed no PO in the PO No column [low]

<!-- area: Service cases (ASSR) -->

**Symptom.** Staff (Nc), 2026-09-14: "create service case no have PO no record
in the column". A new case opened on a sales order showed "—" under PO No on the
Service Cases list, although the order's lines had supplier purchase orders.

**Root cause (traced in source; production row counts NOT measured).** Two facts
meet in that column:

- `fetchScmSoContext` in `backend/src/services/assr.ts` — the ERP-first SO
  lookup every create now takes — returns `SOUDF_ToPONo: null`, and
  `createAssrCase` binds `context?.SOUDF_ToPONo ?? null` into `po_no`. Only the
  old AutoCount `getSingle` path could ever fill it. So on an ERP sales order
  `po_no` starts empty, always.
- `po_no` was never "the order's PO" in the first place. It is the case's OWN
  service purchase order: `POST /api/assr/:id/generate-po` refuses once it is
  set (409 `PO already exists`), and cost resolution reads it as the PO to price
  the repair from. Nothing in the case ever read the order's purchase orders.

So the column staff looked at answers a different question from the one they
asked, and the fact they wanted (which POs were raised for this order) had no
home on the case at all.

**Fix.** Not a write into `po_no` — that would block generate-po and misprice
costing. A read-only **Order PO**, merged by the list and detail reads the same
way `do_numbers` is: `services/assrOrderPos.ts` resolves, per case and inside
the case's own `company_id`, the purchase orders raised from its SO lines
through the existing SO -> PO walk `scm/lib/so-converted-po.ts` (now
`soConvertedPos`, which also returns the PO id, and takes a REQUIRED
`companyId: number | null` applied to all three reads). Shown as a list column
right after DO No, a linked line above the editable PO No on the case detail,
and a line above PO No on the phone. PO No itself is unchanged.

Pinned RED on the unfixed tree: `backend/src/services/assrOrderPos.test.ts`
(module absent), `backend/tests/assrOrderPosWiring.test.ts` (list + detail
returned no `order_pos` with the two call sites reverted),
`so-converted-po.test.ts` (company predicate: `[PO-1-A, PO-1-X, PO-2-B]` where
`[PO-2-B]` was expected), `frontend/src/components/AssrOrderPoLine.test.tsx`
(component absent; the three placement assertions red before the screens were
edited). Removing the company predicate turns 4 unit tests and both wiring
tests red.

**Ref.** feat/assr-case-shows-so-purchase-orders, 2026-09-14.
