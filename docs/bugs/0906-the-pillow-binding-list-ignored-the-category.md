## The pillow binding list ignored the category [medium]

<!-- area: Purchase orders + GRN + PI -->

**Symptom.** Owner, 2026-09-14, on the Products page filtered to Sofa Accessory
(SB02, BC05-MF, BC05, BC04-MF, BC04, AR02, AR01, SQUARE PILLOW, LONG PILLOW):
「这些sku全部都要处理」. Every SKU in the category must be allocated to its own
sales-order line. The rule must follow the category, not a list of SKUs.

**Root cause (traced).** The binding rule came from two places at once.
`HARD_BOUND_GROUPS` (#3857) binds the `fabric_accessory` group. #3854 also added
`CUSTOM_ACCESSORY_CODES = {SQUARE PILLOW, LONG PILLOW}`, and `isHardBoundLine`
checked it before the group (`scm/lib/so-stock-allocation.ts`). Two things
followed from the code list:
- a pillow moved back to Accessory with the #3861 swap still bound by name;
- company 2's SQUARE PILLOW and LONG PILLOW, which are `ACCESSORY` there, were
  bound in the stored allocator's dedication pass, which is not company-gated.

Company 2 had 0 live pillow lines on 2026-09-14, so nothing was mis-stated yet.
The code list was redundant for company 1 once #3864 moved the lines. Production,
read-only, 2026-09-14: all 248 company-1 SO lines and 85 PO lines of the nine SKUs
carry `fabric_accessory`. No `SQUARE PILLOW RDM` exists in company 1's product
master. The random pillows (AMN-SOFA PILLOW, SOFA PILLOW (FOC)) are `ACCESSORY`.

**Fix.** The code list is removed. `isHardBoundLine` binds by group only, and the
group is stamped from the SKU's product-master category on every write (docs/bugs/0514).
The five `.mjs` copies of the predicate now carry `fabric_accessory` instead of
the codes. `probe-custom-pillow-binding.mjs` reads its population from the
category.

Tests, proved RED on the unfixed tree (3 failed):
- `so-stock-allocation.custom-accessory.test.ts`: a pillow in `accessory` pools,
  and no code list is exported;
- `mrp.test.ts`: a pillow in ACCESSORY pools on MRP.

Green on the fix:
- the nine SKUs are bound as `fabric_accessory`;
- SB02 / AR01 / BC05-MF are bound on MRP;
- `po-convert-line.sofa-accessory.test.ts`: the colour reaches the PO line for all
  nine SKUs. This test was already green before the fix, because the path is
  group-driven.

**Not automatic, said plainly.** Moving an EXISTING Accessory SKU into the
category moves the product only. Its open lines keep `accessory` and pool until a
data run moves them, as #3864 did.

**Ref.** fix/sofa-accessory-hard-binding, 2026-09-14.
