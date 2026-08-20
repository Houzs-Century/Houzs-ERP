## Migrated data is not identical to AutoCount: three field-level import defects a per-line check found and every aggregate check missed [high]

**Symptom** - the owner, 2026-08-11: *"怎么可以这样的 我们的数据居然是 migrate 的
那就应该全部一模一样 migrate"*, on being shown that `HC-PO-009633` reads "ordered
1, received 2" on both of its `HOK-1005 (Q)` lines. AutoCount does not permit an
over-receipt; its own `PODTL.TransferedQty` says 1 and 1.

**Why nothing caught it** - every verification the cutover had was AGGREGATE:
document counts (2,710 = 2,710), document numbers (262 exact, 0 different),
balances (2,696 of 2,708), the SO->PO->GR chain (427 agree, 0 disagree), stock
status. All of them passed, because an aggregate can only see the sum and the
sum was right. The defect lived one level down, in a per-line FIELD.

**Root cause (traced, not guessed)** - `backend/scripts/check-migration-fidelity.mjs`
against production + the live AED_HOUZS book (run **31458747829**, read-only)
compared 15,295 migrated lines field by field and traced three defects to the
line of code that writes the field:

1. **`purchase_order_items.received_qty` came from a document-level aggregate.**
   `export-received-pos-live.py` built its `GrQty` column as
   `SUM(GRDTL.Qty)` over `(DocNo, ItemCode)`, and
   `import-ac-so-linked-pos.mjs` wrote `recv = l.GrQty` straight into the line.
   Every same-code line on one purchase order was handed the whole document's
   receipt. **65 PO lines, 73 excess units, 29 purchase orders** - and **65
   migrated GRN lines** inherit it, because `create-migrated-documents.mjs`
   builds a GRN line from `received_qty`.

2. **`import-ac-outstanding-po.mjs` reads a column that does not exist.** It
   writes `deliv: l.DelivDate` in three places while the export column is
   `DeliveryDate`, so the value is `undefined` and the line lands with no
   delivery date. `import-ac-so-linked-pos.mjs` spells it correctly, which is
   why only part of the estate is affected. **101 PO lines ERP-null against a
   real AutoCount date, and 46 purchase orders then show no expected delivery**,
   because the header date is derived as the earliest line date.

3. **An AutoCount quantity of 0 becomes 1 in the ERP.** Both importers write
   `Math.round(num(l.Qty)) || 1`; JavaScript's `||` treats `0` as absent, so a
   deliberately zero-quantity AutoCount line is silently ordered once. **5
   lines**, and the money follows it onto 2 PO line totals AutoCount puts at 0.

**Fix** - none yet, deliberately. This entry records the DETECTION; the check is
read-only and the repair is a separate, owner-approved change. What shipped is
the thing that will not let it happen silently again: a field-by-field,
per-line comparison with a printed field map (72 fields, tagged COMPARED /
DERIVED / DECLARED / NOT-CHECKED), findings grouped BY FIELD so one systematic
import bug is one finding, and a stated join coverage so rows it cannot pair are
counted rather than dropped.

**Lesson** - an aggregate check cannot find a per-line defect, and every check
this cutover had was an aggregate. When the acceptance criterion is "identical",
the comparison has to be at the grain the data is stored at. The first run of
the check itself under-reported for the same reason: an exact-code match claimed
one sofa compartment and orphaned its siblings, hiding 14 of the 65 lines, until
the join was made to claim a sofa build as a group.

**Ref** - PR #1981, 2026-08-11; runs 31457523779 / 31458441463 / 31458747829.
