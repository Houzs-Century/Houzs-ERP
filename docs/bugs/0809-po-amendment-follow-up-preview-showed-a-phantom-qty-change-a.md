## PO amendment follow-up preview showed a phantom qty change and hid the actual spec change [medium]

<!-- area: Purchase orders + GRN + PI -->

**Symptom.** A product-lane SO amendment (added SPECIAL: Divan Curve, applied)
auto-raised its follow-up PO amendment (HC-PO-2609-033/A1) for purchasing to
confirm, but the PO amendment card showed a meaningless "Qty - -> Qty 1" and
NOTHING about the actual spec change; the routing chip mislabelled it "Quantity".
The reviewer could not see what they were being asked to confirm -- the same
"can't see the change" complaint the owner raised on the SO side in 2026-07.

**Root cause (traced).** Two gaps, both mirrors of ones already fixed on the SO
amendment side:

1. `amendment-po-followup.ts` wrote a preview line whose `old_snapshot` carried
   only item_code + material_name -- no old qty, no variants -- and copied the SO
   line's `new_qty` even onto a SPEC row. With no old qty to diff against,
   `new_qty(1) !== old.qty(undefined)` rendered a phantom "Qty - -> 1" and the
   classifier read it as a QTY change.
2. The PO amendment `DiffCard` (`PoAmendmentDetailV2.tsx`), its mobile twin
   (`MobilePoAmendmentDetail.tsx`), `poLineFieldKinds` and the PDF mapper
   (`amendment-pdf-map.ts buildPoRows`) rendered only code / name / qty / price /
   delivery -- never the variant SUMMARY. A colour/fabric/special change (which
   moves no item_code) was therefore invisible everywhere on the PO side. The SO
   side already solved this with `so-amendment-line-diff.ts` (group-aware
   `amendmentVariantSummaries`); the PO paths never got it.

**Fix.** Backend: `old_snapshot` now records the full before (qty / variants /
item_group / description2 / price / delivery), and a SPEC row no longer carries
the unchanged qty (only a QTY change moves it) -- the phantom qty and the
"Quantity" mislabel both fall out. Frontend: the desktop + mobile card,
`poLineFieldKinds`, and the PDF `buildPoRows` now render a variant before -> after,
REUSING the SO side's `amendmentVariantSummaries` so a bedframe line reads its own
axes (the group-selection trap so-amendment-line-diff documents), guarded on
`new_variants != null` so a QTY row's null blob never reads as a cleared spec. New
`po-amendment-queries.test.ts` pins `poLineFieldKinds` (variant-only -> VARIANT not
QTY; pure QTY never a false VARIANT; code+colour -> both; unchanged -> neither) --
each assertion fails on the unfixed classifier (it returned `['QTY']` for the
variant-only case). The APPLY is untouched: confirming still re-derives the PO
from the Sales Order (`reviseBoundPo`), never from these preview rows -- this was a
visibility bug in the confirm gate, not a data bug.

**Ref.** fix/po-amendment-preview-shows-spec, 2026-09-11.
