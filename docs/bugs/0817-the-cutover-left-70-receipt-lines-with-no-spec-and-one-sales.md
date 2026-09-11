## The cutover left 70 receipt lines with no spec, and one sales line's converted-count sat on the wrong row [low]

**Symptom.** The owner, 2026-09-11, after the supplier alignment: 「然后你在看整
条流程有什么不一样的数据 正常来说要一样的」 — walk the whole flow and find where
the same build is recorded differently. The chain audit (run 34587006588) came
back with two paper gaps and one counter:

- **91 goods-received lines carry no variants at all** (70 of them sofa/bedframe)
  while the purchase line they were raised from states the spec in full.
- **4 sales-order lines disagree with their own purchase children** on
  `po_qty_picked` — 3 reading LOW (the line offers itself for purchase although
  it was already bought) and 1 reading HIGH.
- `HC-SO-008166` holds two `9058-1NA` lines of qty 1; the purchase order bought
  two. The counter sat as **2 on one line and 0 on the other** — the total was
  right, the attribution was not, and the 0 makes that line look unpurchased.

**Root cause (traced, and the first suspicion was wrong).** The obvious reading
was "the receiving path does not copy the spec". It does: `grns.ts` writes
`variants: it.variants` on both create paths (PR #44), and the delivery path
copies from the sales line the same way. Measured instead of assumed: of the 70
sofa/bedframe receipt lines, **70 of 70 are `migrated_no_stock` paperwork created
in 2026-08**, and **70 of 70 have a parent purchase line that carries the spec**.
So the gap belongs to the cutover importer, which stopped at the purchase line —
nothing is still falling through it today. The counter drift is the gap
`repair-migrated-po-lines.mjs:369-383` named against itself ("po_qty_picked is
NOT recomputed here, and that is a real gap") and that
`recompute-so-po-qty-picked.mjs` exists to close; 962 lines were repaired on
2026-09-08 and four had drifted since.

**Fix.**
- `backfill-grn-variants-from-po.mjs` (+ workflow) copies the parent's `variants`
  column across IN SQL — never read into JavaScript and written back, so the
  double-encoding trap of `docs/bugs/0814` has no way in. It refuses any receipt
  that is not migrated paperwork, and refuses again if an inventory movement
  names it: a receipt whose goods actually moved must never be re-specced
  underneath its own lot.
- The counter was fixed with the tool that already exists. Observed (run
  34588323217, production): `4 sales-order line(s) disagree` → `wrote 4 of 4` →
  `rows still disagreeing with their purchase-order children : 0`.

**What this is NOT, recorded so it is not re-chased.** The same audit's other
findings were measured and are not defects: 39 of 39 sofa OUT movements consumed
a real lot (no phantom shipment); the 9 sales-vs-delivery variant differences are
migrated deliveries whose sales line gained a seat height AFTER the delivery note
was made; and the six "double-ordered" pillow lines are not over-ordering —
outstanding demand for SQUARE PILLOW is 503 against 237 on hand and 62 on order,
so the second purchase order is stock the business needs. What is wrong there is
only the attribution: an MRP-origin convert is exempt from the per-line ceiling
by design (`mfg-purchase-orders.ts`, `!fromMrp && p.qty > remaining`), so its
second purchase line lands on a sales line that is already fully converted and
reads as a duplicate. That is a decision for the owner, not a repair.

**Ref.** fix/flow-consistency, 2026-09-11.
