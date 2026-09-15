## A description typed in SKU Master Edit Prices snapped back to the old text when the cell was left [high]

<!-- area: Products + SKU master -->

**Symptom.** Owner, 2026-09-15, Products -> SKU Master -> Edit Prices. He changed
the description of `810 BOLSTER` from "RDS BOLSTER 810" to "BOLSTER 810". A moment
later the row showed "RDS BOLSTER 810" again, before he pressed Save:
「我点选 edit 之后，它第三张照片就会跳回去。它不是应该 remain 着我 edit 的东西给我 show 出来，然后让我去点 save 吗？」

**Root cause (traced).** The edit is staged correctly, but the cell shows the
wrong value once it is left. `ProductRow` passed the STORED text to the
click-to-edit cell:

- `frontend/src/pages/scm-v2/Products.tsx:1226` (merge base `404c434b5`):
  `value={row.name}`.
- The same at `:1212` for the product code.

`EditableTextCell` staged the typed text on blur, closed the input and painted
`value`, which is the old text. Save still sent the new text, so the screen and
the save disagreed. Re-opening the cell also seeded the input from the old text.

Two more cells in the same row had the same shape:

- **Mattress branding** (`:1153`). `patch?.branding ?? row.branding` read a
  deliberate clear (`null`) as "unchanged" and showed the stored brand.
- **Sofa price inputs** (`:1260`). `PriceInput` seeds its text once. Switching
  P1/P2/P3 kept the last tier's number in the box, and leaving the box staged
  that number into the new tier.

The Save around it also did not behave like a normal system:

- **A failure was thrown past the button** (`:322`). There was no catch, so the
  rows already saved stayed marked as unsaved.
- **Save ended edit mode before the list reloaded.** The grid briefly repainted
  the old text.
- **Leaving a price box without typing counted as a change.** "Save (N)"
  counted rows that had not changed.

**Fix.**

- **Shown values.** The row reads the staged code, description and branding
  (`frontend/src/pages/scm-v2/products/SkuEditRow.tsx`, lifted out of
  Products.tsx unchanged in its own commit first). Sofa price inputs are keyed by
  tier.
- **Change count.** `stageRowEdit` drops a field staged back to its stored value,
  so the Save count is only real changes.
- **Save.** `saveStagedEdits` sends every row and collects failures. The page
  waits for the list to reload, then leaves edit mode and says "Saved N SKUs".
  On a failure it stays in edit mode with the failed rows still on screen and
  names each one with its reason.
- **Cancel.** Asks before dropping unsaved changes.
- **Readback.** The verified-save now also reads back `name` and `code`.

Pinned in `frontend/src/pages/scm-v2/products/SkuEditRow.test.tsx`. On the unfixed
row all 5 display tests fail: description, re-open, code, branding clear and tier
switch. After the fix all 11 pass, including the 6 `stageRowEdit` cases.

Observed in a local browser harness (the real Products page over an in-memory
API): typed text stayed, "Save (1)", then "Saved 1 SKU.", then the grid showed
"BOLSTER 810" in 3 of 3 rows. A simulated failure on one of two rows said
"Saved 1 of 2 SKUs" and kept the failed row staged.

**Ref.** fix/sku-master-edit-filter-category, 2026-09-15.
