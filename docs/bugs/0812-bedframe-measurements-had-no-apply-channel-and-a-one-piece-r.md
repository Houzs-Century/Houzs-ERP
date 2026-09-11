## Bedframe measurements had no apply channel, and a one-piece rename had no tool [low]

**Symptom.** Two gaps the owner's 2026-09-11 instruction walked straight into —
「跟着供应商… 无论是 BedFrame 还是 sofa compartment 跟它们的 variant」:

1. **Bedframe.** `check-supplier-bedframe-vs-erp.mjs` could report that 18 of our
   purchase orders disagree with the supplier on divan height / gap / leg, and
   nothing could write the answer. The handoff said so in terms: "there is no
   bedframe proposer/apply channel yet".
2. **A one-piece rename.** Purchasing reported `SO-013503 / PO2609-053 the item
   code convert wrong, need 1A(LHF)+1NA+L(RHF)` — the third piece is a lounger,
   read as an arm. The sales order was corrected through the normal channel
   (run 34570012915, `VERIFY OK`), and the purchase order was **REFUSED**:

       HC-PO-2609-053: REFUSED — money would move — total 273000 -> 106000

   Nothing about that sofa's money was wrong; one row's item code was.

**Root cause (traced).** `apply-sofa-compartment-corrections.mjs` rewrites a
BUILD: it pairs rows by CODE and re-shapes the set, which is right when a build
gained or lost a piece. A rename of ONE piece reads to it as "remove 1A(RHF),
add L(RHF)", and on a document where more than one line carries money the price
cannot ride the first piece — so its money guard refuses, correctly. The
operation the document needed was not expressible in that tool's vocabulary, and
no smaller tool existed (run 34570088451 is the refusal).

**Fix.** Two gated tools, both built around the `docs/bugs/0722` gate — a
measurement is part of the inventory identity, so a line whose goods are already
in is never rewritten:

- `apply-supplier-bedframe-variants.mjs` (+ workflow, + `lib/supplier-bedframe-variant-plan.mjs`,
  14 unit tests). Beds match by SIZE, never row order; a document holding two
  same-size beds that state different measurements is skipped, because nothing in
  the export says which bed is which. Observed on production, DRY-RUN: 283
  comparable documents, 410 lines already agreeing, **1 line to write**
  (`HC-PO-010153` gap blank -> 10"), 8 held for received stock, 6 documents
  skipped as the same-size ambiguity above.
- `rename-sofa-line-in-place.mjs` — changes `item_code` on ONE named row and
  nothing else, so price, quantity, `so_item_id` dedication, variants and
  description2 all survive. Refuses more than one match, received goods, a
  goods-received or delivery line, and an unminted target SKU; verifies the whole
  document's shape on a fresh connection. Observed: by the time it ran,
  `HC-PO-2609-053` already read `1NA + L(RHF) + 1A(LHF)` at RM 2,730 — the tool
  reported `nothing to rename`, which is the convergent answer it promises.

**Ref.** fix/sofa-supplier-round3, 2026-09-11. Follows `docs/bugs/0807`, `0811`.
