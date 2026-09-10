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

**DIAGNOSED — WORLD (b), a lopsided link, PROVEN.** `check-so-po-coverage.mjs`,
run 34484832417: `HC-PO-009974` physically carries **2x `9058-1NA`** — exactly
what the order needs — but BOTH `purchase_order_items.so_item_id` point at the SO
line `edada633`, leaving its twin `8d59fff0` with zero links, so MRP shows it
SHORT. The goods ARE on order; the owner's intuition (「我们都是一起开的」) was
right. The two `L(LHF)` / `L(RHF)` pieces are correctly one-to-one.

**And it is a ONE-OFF.** The CENSUS (SO_DOC=CENSUS, run 34485530501) scanned
every outstanding company-1 sofa/bedframe line that reads SHORT: **1 line / 1
order** is world (b) — this one. The other 2,900 SHORT lines across 1,656 orders
are world (a): no PO linked at all, i.e. the normal not-yet-ordered MRP backlog,
NOT a defect. So this is a single stray link, not a systemic fault.

**Fix.** `backend/scripts/repair-so-po-link-008166.mjs` + the **Repair SO/PO
link HC-SO-008166 (plan/apply)** workflow move ONE of the two `9058-1NA` PO
lines from `edada633` to `8d59fff0` — one foreign-key column on one row, no
quantity, no money, no goods move. Identity-scoped and shape-guarded: it refuses
if production no longer matches the 2-SO-lines / 2-PO-lines / both-on-one shape.
Plan default; apply needs CONFIRM. **Not yet applied — awaiting the owner's go.**

**The verdict heuristic's blind spot, recorded.** The single-order probe's
auto-SUMMARY first mis-called this line "world (a) real under-order", because it
only looked for an UNLINKED spare of the same code and both pieces were linked
(to the wrong line). The raw PO lines are what settled it — the summary was a
check answering a slightly different question. The census query fixes the class
by comparing the GROUP's linked total against its need, so an over-linked sibling
is seen.

**Ref.** diag/po-coverage-008166, 2026-09-10.
