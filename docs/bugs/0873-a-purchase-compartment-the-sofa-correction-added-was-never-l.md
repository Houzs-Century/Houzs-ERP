## A purchase compartment the sofa correction added was never linked to its sales-order piece, so the sales order could not see its PO [high]

**Symptom.** Staff issue list #18 and #19:
*"SO-013389 this already have PO-010087, please update it"* and
*"SO-011114 already have PO:010045, please update, why only item 3 no show PO?"*
The purchase order exists, and one sofa piece on the sales order still shows no
incoming PO and reads SHORT.

**How the screen decides (read, then measured).** The desktop SO detail paints
from `GET /mfg-sales-orders/:docNo` (`coverage_po: null`, hard-coded) and
overlays `GET /mfg-sales-orders/:docNo/coverage`
(`mfg-sales-orders-list-enrichment.ts`), which runs `soCoverage` ->
`computeMrp` -> `mrpLineCoverage`. `SoSourceChips` shows that PO only when
`stock_state === 'po'`. A company-1 sofa / bedframe / `(SP)` mattress line is
covered ONLY by a live PO line whose `so_item_id` is that line and whose own
`item_group` is hard-bound (`isDedicated`, `scm/routes/mrp.ts`). So "the SO shows
its PO" means "a PO line carries this SO line's id".

**Root cause (traced, production).** Two shapes, one origin — the sofa
compartment corrections.

1. **#19 — the added piece was inserted with no link, and nothing linked it
   later.** `apply-sofa-compartment-corrections.mjs` splits a build into its
   compartments on both documents. On the purchase order it INSERTed the new
   piece and deliberately left `so_item_id` NULL ("an added compartment has no SO
   line of its own until the SO half of the same build is corrected") — and no
   step ever came back once the SO half was written. Prod APPLY run 34507126629
   (2026-09-10 17:16-17:47Z) printed `HC-PO-010045 ... add STOOL`, and production
   holds exactly six sofa PO rows with `line_no` NULL sharing a book key with a
   linked sibling, all created 17:38-17:44Z that evening — the earlier memory
   note calling them "hand-opened POs" was wrong. Two of the six were linked by
   `repair-mrp-po-line-links` APPLY run 34569729362 (2026-09-11), including
   HC-PO-010045 / 9058-STOOL. The other four are NOT missing links: two are
   SURPLUS duplicate pieces on HC-PO-010041 (the sales-order line is already
   covered by another PO line) and two sit on orders whose sales-order half was
   refused or amended. 
2. **#18 — the purchase order never got the second piece.** HC-SO-013389 was
   split to `8030-1A(LHF)` + `8030-1A(RHF)` (both on book line 915302), but
   HC-PO-010087 still holds only `8030-1A(LHF)`. The purchase-side entry for it
   exists (`sofa-compartment-corrections-purchase-side.json`, book line key
   917339) and was SKIPPED by the whole-file APPLY runs 34507126629 and
   34557669854 with `no line matches line key(s) 917339`. The row carries 917339
   today (who stamped it after 2026-09-11T03:14Z is UNKNOWN), and a dry-run on
   2026-09-14 matches it: `keep 1A(LHF)`, `add 1A(RHF)`. With no PO line there is
   nothing to link, so the RHF piece is a genuine shortage to the engine.

Measured with the real engine (`check-so-po-line-links.mjs`, computeMrp over the
shim, read-only against production 2026-09-14): HC-SO-011114 items 1-3 all show
HC-PO-010045; HC-SO-013389 item 1 shows HC-PO-010087 and item 2 (`1A(RHF)`)
shows none (`source=shortage`). Class size on company 1: #19 shape with an
uncovered hard-bound SO line = 0; #18 shape = 1 line on 1 order (HC-SO-013389).

**Fix.** The applier now links every purchase piece it adds, AFTER every build
in the run is written, through `scripts/lib/added-po-compartment-link.mjs`: the
linked pieces of the same build on the same PO must name exactly one sales order
and one book line, and that order must hold exactly one live, uncovered piece
with the same code, book line and warehouse. Anything else is LEFT with its
reason (surplus, ambiguous, not on the sales order). One column, guarded on
`so_item_id IS NULL`, re-read on a fresh connection and asserted by SHAPE (right
order, right line, same code). The dry-run now prints the link it would make.
`tests/addedPoCompartmentLink.test.mjs` pins the rule, and its applier test was
proved RED on the unfixed script (`1 failed | 7 passed`).

The data half — adding `1A(RHF)` to HC-PO-010087 linked to HC-SO-013389 line 3 —
is a production write and waits for the owner.

**Ref.** fix/so-po-link-18-19, 2026-09-14.
