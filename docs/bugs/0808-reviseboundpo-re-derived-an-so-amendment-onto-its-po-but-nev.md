## reviseBoundPo re-derived an SO amendment onto its PO but never wrote the SKU, so a spec swap kept the old item_code [medium]

<!-- area: Purchase orders + GRN + PI -->

**Symptom.** A Sales Order was amended to swap two lines' orientation
(9028-2A LHF->RHF, 9028-1A RHF->LHF). After the bound PO (HC-PO-2609-049,
already revised to `_R2`) was re-derived, it kept showing — and PRINTING — the
OLD SKUs: the SO->PO drift banner ("SO now orders 9028-2A(RHF) … this PO still
has 9028-2A(LHF)") never cleared, and the PO PDF / supplier email still carried
the old codes. The sofa orientation cell on the PO PDF is derived from
`item_code`, so the supplier would build the wrong hand.

**Root cause (traced).** `reviseBoundPo` (the SO-amendment -> bound-PO apply
engine, `backend/src/scm/lib/so-revision.ts`) re-derives each surviving PO line
in place — qty / unit_price / variants / description2 / delivery / warehouse /
photos — but its UPDATE object never included `item_code` (nor `material_name`).
It computed the new SKU (`itemCode`) purely to anchor the supplier-cost lookup
(`deriveMfgPoUnitCost`) and then dropped it. The drift detector compares the PO
line's `item_code` against the source SO line's live `item_code`, so a code that
is never written back drifts forever; the `revision` bump that produced `_R2`
wrote every field except the one that drifted. Verified against the update block
on `main`: `item_code` was absent from it. (There is no test asserting the SKU is
preserved — the current behaviour was an omission, not a contract.)

**Fix.** Write `item_code` and its identity pair `material_name` back on the
in-place re-derive. `item_code` = the revised SO `item_code`, falling back to the
existing code when the SO line carries none (guarded with `|| trim` so it never
blanks). `material_name` follows the SO description like the convert / ADD paths,
then the existing name, then the code — never downgraded to a bare SKU. Cost was
already re-derived on the new SKU, so no pricing change. New tests in
`so-revision.reviseBoundPo.test.ts` pin it — a SKU swap syncs code+name and
re-prices; a null SO description keeps the existing name. Proved RED against the
unfixed engine (the swap test asserts `item_code === 'BF-1-RHF'`, which fails
before the UPDATE carries it). The sibling PO-amendment engine
(`po-revision.ts applyPoAmendment`) already writes `item_code` on a SPEC change —
the two amendment engines had silently disagreed on whether a SKU can move.

**Ref.** fix/reviseboundpo-syncs-sku, 2026-09-11.
