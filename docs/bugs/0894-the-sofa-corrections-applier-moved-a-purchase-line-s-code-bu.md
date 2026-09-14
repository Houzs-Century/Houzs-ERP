## The sofa corrections applier moved a purchase line's code but not its supplier code, and gave an added purchase piece none [high]

<!-- area: Purchase orders + GRN + PI -->

**白话.** 修正沙发组件（例如 2S 改成 1A(LHF)+1A(RHF)）的工具，改了我们自己的
item code，但**没有改工厂看的 Supplier Code**：原本那一行还写着 `2S`；新加出来的那
一行更糟，Supplier Code 是**空的**。工厂是照 Supplier Code 做货的。现在工具在同一个
transaction 里把 Supplier Code 跟着改好，新加的那一行也会从原本那一行抄过来再换成
对的组件。

**Symptom.** Found before it reached production, while applying the owner's
2026-09-14 ruling on HC-PO-010086 (「这个PO 是1A+1A」): the purchase line is
`8030-2S` with supplier code `HOK-5540 SOFA 2S`, and the build becomes
`1A(LHF)+1A(RHF)`. Read against the applier, the result would have been
`8030-1A(LHF)` still showing `HOK-5540 SOFA 2S`, and a new `8030-1A(RHF)` line
with no supplier code at all.

**Root cause (traced).** docs/bugs/0822 taught the applier to call
`alignPieceColumns` — but only inside `applyDownstreamDoc` (the downstream
receipt / delivery path). The MAIN sales-order / purchase-order path in
`apply-sofa-compartment-corrections.mjs` never called it:

- the purchase-line `UPDATE ... SET item_code, material_name, ...` moved no
  `supplier_sku`;
- the purchase-line `INSERT` for an added piece did not name `supplier_sku` in
  its column list, so the new row carried NULL;
- the carry from a corrected sales line onto its dedicated purchase line (and
  that line's receipt lines) moved `item_code` + `variants` only, leaving
  `supplier_sku` and `material_name` on the old piece.

The shown-vs-code sweep (`repair-sofa-line-shown-vs-code.mjs`) cannot clean up
after the INSERT: an empty column names no piece, so it is not a disagreement.
The docs/bugs/0822 entry's own sentence "the applier now aligns every piece
column" was true of one of its two paths.

**Fix.** The applier aligns every piece column on every purchase and receipt row
whose code it moves: inside the transaction on a purchase-line update and
insert, and on the purchase / receipt rows a carry touches. The added purchase
piece COPIES `supplier_sku` from the row it is built from, then its piece token
is moved — the supplier's own spelling is kept, as docs/bugs/0822 ruled
(`HOK-5540 SOFA 2S` → `HOK-5540 SOFA 1A(RHF)`). The fresh-connection verify now
reads `supplier_sku` + `material_name` on a purchase line and FAILS a row that
names another piece (an empty supplier code is printed as a NOTE). Pinned by
`backend/tests/sofaCorrectionsSupplierCode.test.mjs` — 5 cases, all 5 RED on the
unfixed script, green with the fix.

**Ref.** fix/po-010086-sofa-build, 2026-09-14. Follows docs/bugs/0822.
