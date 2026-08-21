## A delivery fee reduction on a locked SO was dropped, and since #2597 it read as saved [high]

<!-- area: Sales orders + pricing -->

**Symptom.** On processing-locked `2990-SO-2608-020`, the operator typed 125
into the delivery fee cell (RM 250 → 125) and pressed **Submit amendment
request**. The dialog answered **"Saved without an amendment — those changes
save straight to the order"**. The fee stayed RM 250.

Before #2597 the same edit answered *"No changes to submit"* — a confusing
error, but an error. #2597's DIRECT_ONLY branch turned the silent drop into a
false success whenever anything FREE (a note, a phone digit) was dirty in the
same session.

**Root cause (traced).** The fee is a DERIVED price (owner 2026-08-07): typing
125 books a line **discount** of RM 125 against the derived RM 250 — the one
lever `rederiveDeliveryFee` preserves through every rebuild
(`SoLineCard.tsx:281`, `feeDiscountForAmount`). But the discount had **no
amendment channel**, in all four places at once:

- `amendmentLineSig` (the editor's dirtiness test) did not include
  `discountSen`, so the fee line scored as "nothing amendable moved" and
  `buildAmendmentLines` emitted nothing;
- `CreateAmendmentLine` had no field to carry it;
- `scm.so_amendment_lines` had no column to store it;
- `applySoAmendment` computed `discount = row.discount_sen` — it could only
  copy a discount forward, never change it (its own test suite pinned this
  under the title *"discount_sen has no amendment channel (documented gap)"*).

Known and written down twice: the sig's comment has listed "discount" among the
nine channel-less fields since 2026-07-16, and mig 0281 — which closed the
identical gap for `remark` — names it among the eight still open. The owner's
rule (2026-08-16, `so-revision.amendmentPrice.test.ts`) is that the amendment
IS the sanctioned road for changing money on a locked SO.

**Fix.** Mig 0317 adds `scm.so_amendment_lines.new_discount_sen` (nullable
bigint, `new_remark`'s exact NULL semantics: NULL = not requested, 0 = clear).
The channel end to end:

- `amendmentLineSig` moved from `SalesOrderDetail.tsx` into
  `so-amendment-line-diff.ts` and gained `discountSen` — with the rule stated
  at the definition: a field may join the signature ONLY together with its
  payload field, its column and its apply write, or it recreates the
  phantom-SPEC defect the signature was built to stop.
- `buildAmendmentLines` sends `newDiscountSen` only when it moved;
  `buildAmendmentLineRows` normalises garbage to NULL and stamps the line's
  current `discount_sen` into `old_snapshot` server-side (the approver's
  before-side comes from the record, never the browser).
- `applySoAmendment` writes it clamped to `[0, qty * unit]` at apply time —
  qty and unit can change in the same amendment, so the bound lives where both
  are final — and audits the clamped value.
- The approver's card (`AmendmentDetailV2`) renders the discount before/after;
  a discount change routes as **PRICE** (money moves to the same desk a price
  change does). Without this the approver signs a money change blind.

Proved RED on the unfixed tree: with the source fix stashed, exactly the three
new apply cases fail (`3 failed | 17 passed`) — a requested discount ignored, a
clamp never applied, a zero-clear ignored — and the pre-0317 behaviours
(NULL preserves, ADD lands 0) still pass on both trees.

Mobile is untouched and unaffected: `MobileNewSO` has no discount input
(zero `discountSen` occurrences), so it can never produce the edit.

**Ref.** fix/so-amendment-discount-channel, 2026-08-21.
