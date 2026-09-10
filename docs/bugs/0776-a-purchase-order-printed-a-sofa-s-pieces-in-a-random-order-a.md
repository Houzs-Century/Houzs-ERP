## A purchase order printed a sofa's pieces in a random order, and the photos with them [high]

<!-- area: Purchase orders + GRN + PI -->
<!-- status: fixed -->

**Symptom.** The owner, 2026-09-10, on `HC-PO-2609-053`: the purchase order
printed a three-piece sofa with the ARMLESS piece first. He stated the rule in
his own words — 「我们的 Sales Order 都是从 L 到 R（L 在第一，R 在最后）」: the
left-arm piece leads, the armless pieces sit in the middle, the right-arm piece
closes. And 「照片是根据 line item 的顺序来的」, so the ITEM PHOTOS block at the
foot of the printed PO scrambles with the table. `1NA` is armless and cannot
physically be at either end of a run; the factory reading that sheet builds the
sofa in the wrong shape.

| source | order |
| --- | --- |
| sales order `HC-SO-013503` (correct) | `L(LHF)` → `1NA` → `1A(RHF)` |
| purchase order, as it read | `1NA` → `1A(RHF)` → `L(LHF)` |

**Root cause (traced against production, not inferred).**
`scm.mfg_sales_order_items` has a `line_no` column. **`scm.purchase_order_items`
had no line-order column at all** — read off `information_schema.columns` on the
live database, the only two columns whose name begins with "line" are
`line_total_sen` and `line_suffix`, and neither is an order.

So the order was whatever Postgres returned. The three lines of that sofa were
written by ONE insert and share a `created_at` to the microsecond
(`2026-09-10 02:53:25.121542+00` on all three rows), and the detail read was
`.order('created_at')` with nothing after it — no tiebreak, so the rows come
back in PHYSICAL order. An UPDATE moves a row's physical position, which is why
the same document could print two ways on two days. That is not a theory: while
this was being measured, one line of `HC-PO-2609-053` was edited between two
reads twenty minutes apart, and its position in the un-ordered read moved.

The convert made it worse rather than merely leaving it undecided. The PO lines
were written in the order the CALLER's `picks` array happened to arrive in — and
the MRP "Proceed PO" picker groups by ITEM, not by document, so that array is
routinely not in sales-order order.

`orderSofaModuleRowsWithinBuilds` looked like it should have caught this and
could not: it groups on `variants.buildKey`, and only **141 of the 580** sofa PO
lines on production carry one. On the rest it is a no-op.

**How big it was, measured 2026-09-10 (read-only `claude_ro`).**

| | |
| --- | --- |
| purchase orders / lines / sofa lines | 734 / 1,690 / 580 |
| POs carrying MORE THAN ONE sofa line | **214** |
| ... of those, an ARMLESS piece (`1NA` / `2NA` / `CNR`) at an END of the run | **43** |

The classification is the code's own: `parseCompartmentStructure`
(`backend/src/scm/shared/sofa-build.ts`) decides which module carries an arm,
and `SOFA_MODULES`' `accessory: true` (Console, STOOL) is dropped from the run
first — an ottoman at the end of a document is not a mis-ordered sofa. A first
pass that skipped that step said 53, which was 10 documents wrong in the
direction that flatters the finding.

**Fix.** `line_no integer` on `scm.purchase_order_items`
(`20260910T0547_scm_po_item_line_no.sql`), plus one module that owns it,
`backend/src/scm/lib/po-line-order.ts` — the same shape as `ac-line-order.ts`:

- **Writes.** All six paths that born PO lines number them — the New-PO create,
  the SO→PO convert (both the create and the append-to-existing arms, which is
  also the MRP "Proceed PO" path), `POST /:id/convert-from-so`, the manual
  `POST /:id/items`, the PO amendment ADD and the SO amendment's added line. A
  converted line's position is derived from the SOURCE SO line's `line_no`
  (`sortBySourceSoLine`), so the pick order stops mattering.
- **Reads.** `inPoLineOrder` — `line_no NULLS FIRST, created_at, id` — on the PO
  detail route and on `snapshotPo`. NULLS FIRST is load-bearing: a PO whose
  lines predate the column answers `max(line_no) = NULL`, so an appended line
  takes 1 and has to land AFTER them.
- **Print.** `sortLinesByStoredLineNo` (shared, byte-identical in
  `backend/src/scm/shared/so-line-display.ts` and
  `frontend/src/vendor/shared/so-line-display.ts`) is now the BASE of
  `purchase-order-pdf.ts`'s `orderedItems` — the const that drives both the line
  table and the photo block, which is the owner's second sentence.

**Proved RED on the unfixed tree.**
`backend/src/scm/routes/mfg-purchase-orders.line-order.test.ts` drives the real
`convertSosToPosCore`; before the fix all 6 failed, every written row's
`line_no` was `undefined`, and the scrambled pick order came out as
`1NA` → `1A(RHF)` → `L(LHF)` — the production shape. Its fake `select()`
PROJECTS the requested columns, so a convert that never asks the database for
`line_no` fails instead of passing on a fake row that has it anyway.
`backend/tests/poLineOrderWiring.test.ts` pins the wiring, and was itself proved
red by deleting `line_no` from one insert site.

**The 43 do not all become 40 by accident — and 3 stay wrong on purpose.**
Re-ordering each broken PO by its source SO's `line_no` fixes 40. The other
three (`HC-PO-008986`, `HC-PO-010160`, `HC-PO-2609-055`) stay wrong because
THEIR SALES ORDER is in that order — e.g. `HC-SO-011965` holds
`1A(LHF), 1NA, 1NA, CNR` with the corner last. The fix copies the sales order; it
does not second-guess it. Those three are an SO-side data question for the owner.

**What the backfill changes, stated rather than buried.** 661 of the 734 POs are
fully derivable and are numbered; the other 73 keep `line_no` NULL. **142 of the
214 multi-sofa POs will display their rows in a different order afterwards.**
That is deliberate and it is the one non-behaviour-preserving part: it is not the
sofa handedness rule applied retroactively (the owner bounded that one
「只针对新的order生效 旧的就不理了」, `sofaOrderForNewLines.test.ts`, and nothing
here reads a module code) — it copies an order the source document already holds.
If the owner would rather leave history alone, deleting the backfill statement
from the migration is the whole change; every PO raised afterwards is still
correct.

**Ref.** `fix/po-line-order`, 2026-09-10.
