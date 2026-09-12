## The same free line read FOC on the delivery order and Sale on the invoice [medium]

<!-- area: Sales orders + pricing -->

**Symptom.** Owner, 2026-09-12: 「免费品（FOC）应该全部都要有，全部
documentation」. Looking for where to add it turned up something worse than an
absence — four surfaces already answered "is this line free?", and they answered
it **differently**:

| surface | its rule |
|---|---|
| Sales Order (desktop) | `unit_price_sen === 0 && total_sen === 0` |
| Sales Invoice (desktop) | `unit_price_sen === 0 && (line_total_sen ?? 0) === 0` |
| **Delivery Order (desktop)** | `Number(unit_price_sen ?? 0) === 0` — **the price ONLY** |
| Sales Order (mobile) | `(unit_price_sen ?? 0) === 0 && lineTotalSen(it) === 0` |

Two disagreements follow, and neither is visible on the surface that has it
right:

- a line **priced at 0 that still carries a total** reads **FOC on the delivery
  order** and **Sale on the invoice** — the same goods, two documents, opposite
  words;
- a line whose price is **null** reads FOC on the delivery order and on mobile,
  and not on either desktop sales document.

Purchase Order, Goods Receipt and Purchase Invoice carry no badge at all.

**Root cause (traced).** There is no FOC column — on any of the eleven line
tables. Checked against a live document (staging copy of production,
2026-09-12): a free line is one that CHARGES NOTHING, computed, plus
`variants.freeGift` for the promotion-with-purchase path. A computed rule with
no shared home grows a copy per screen, and the copies drift — this repo's most
frequent bug class, and the owner's own complaint in another form (「一张单有，
另一张没有」).

**Fix.** `frontend/src/vendor/scm/lib/foc-line.ts` — one rule, tested:

- the unit price is 0 **or absent** (absent counts as zero: "no price" and
  "priced at zero" are the same thing to a customer, and treating them
  differently is what made two surfaces disagree);
- **and** the line total is 0, read from whichever column the document calls it
  (`total_sen` on a sales order, `line_total_sen` everywhere else) — this is the
  half the delivery order was missing;
- **or** the line carries `variants.freeGift`, which wins over the arithmetic
  because a promotional gift can hold a granted base price for costing while
  costing the customer nothing.

**Discounted to zero stays NOT free**, deliberately: unit 100, discount 100,
total 0 is a line that was sold and then given away, and the discount is the
story the document should keep telling. Both desktop sales surfaces already
behaved this way.

The four sites now call it. 10 cases pinned in `foc-line.test.ts`, including
both disagreements. The badge is NOT yet added to PO / GRN / PI — that is a
display addition on three screens and is deliberately separate from making the
existing four agree.

**Ref.** fix/foc-is-one-rule, 2026-09-12.
