## HC-PO-006690 supplier picked HOOKKA but the line's NB- item belongs to NICOLLO [low]

**Symptom.** AutoCount write-back refused the PO: *"ERP item code 'DIVAN
ONLY-(Q)' maps to 4 AutoCount items and none belongs to supplier 400-H003"*.
The PO sat in the outbox as skipped/ItemCodeError and could not sync.

**Root cause (traced).** The PO's header carried `400-H003 HOOKKA`, but the ERP
product `DIVAN ONLY-(Q)` resolves to NB-prefixed AutoCount items, which are
NICOLLO's SKUs. Traced against the committed account-book snapshot
(`backend/scripts/data/ac-fidelity-po-headers.json.gz` +
`ac-fidelity-po-lines.json.gz`): 3,349 historical purchases carrying any NB-
item were raised on `400-N002 NICOLLO`, and HOOKKA's catalogue has never held
a DIVAN ONLY of any suffix. The composer's own verdict — "no ItemCode belongs
to 400-H003" — is the same finding through the map. So it is the header that
is wrong, not the line: the operator picked HOOKKA when they meant NICOLLO.

**Fix.** One-shot repair
`backend/scripts/repair-po-006690-supplier.mjs` + its workflow, which changes
`scm.purchase_orders.supplier_id` for this one PO from HOOKKA's UUID to
NICOLLO's UUID (`code = '400-N002'`, `company_id = 1`). Dispatched dry-run
first (the script's default), then apply with `MODE=apply
CONFIRM=REPAIR-HC-PO-006690`. Verification re-reads the row on a fresh
connection and asserts `supplier_code = '400-N002'`.

The alternative — adding `supplier_material_bindings` row so `400-H003` nominally
sells `NB-DIVAN ONLY (Q)` — was refused: it would let a wrong write into a
licensed account book that has never held a DIVAN ONLY under HOOKKA, and would
silently do the same for every future DIVAN ONLY raised on HOOKKA.

**Ref.** `fix/hc-po-006690-supplier`, 2026-09-10.
