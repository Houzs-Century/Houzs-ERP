## MRP SHORT on a piece its PO may actually carry — link vs under-order [high]

<!-- area: Purchase orders + GRN + PI -->

**Symptom.** The owner, 2026-09-10, on HC-SO-008166. The order is a sofa set —
`9058-L(LHF)`, two `9058-1NA`, `9058-L(RHF)` — and the MRP page shows three
pieces covered by `HC-PO-009974` while ONE `9058-1NA` reads SHORT. His words:
「这个PO 都开了 你说没有order到？确定？」 — the purchase order is open, are you
sure this piece was not ordered?

**Why this is not yet diagnosed.** MRP's SHORT means *this sales-order line is
not COVERED in the current allocation*. That is not the same statement as *no
purchase order carries this piece*, and the two produce the identical red chip:

- **World (a) — a real under-order.** `HC-PO-009974` carries fewer of `9058-1NA`
  than the sales order ordered (one, not two). The remedy is a top-up PO.
- **World (b) — a missing link.** The PO carries both, but only one `9058-1NA`
  line was tied to a sales-order line, so the second SO line finds no coverage.
  The goods are on order; the LINK is missing. `linked_ac_dtlkey` is documented
  as NOT unique across ERP lines, and 「purchase order follows the sales order」
  already governs this class: when the PO and SO disagree, the missing link is a
  SYMPTOM.

The fix is OPPOSITE in each world, so the display must not be trusted — the PO's
own lines decide it.

**Investigation.** `backend/scripts/check-so-po-coverage.mjs` + the **SO/PO
coverage (read-only)** workflow read, per sales-order line and per
purchase-order line: the SO line's qty and delivered, every PO line touching the
order (by the direct `so_item_id` link of migration 0098 AND by
`purchase_order_item_allocations`), and whether an unlinked PO line of the same
item code exists that could be the missing coverage. It states the verdict per
line — WORLD (a) or WORLD (b) — in words, and writes nothing.

**Fix.** None yet — this ships the check. The remedy is chosen from what the run
says: link the orphan PO line (b), or raise a top-up (a). **UNTESTED against
production as of this commit — dispatching immediately.**

**Ref.** diag/po-coverage-008166, 2026-09-10.
