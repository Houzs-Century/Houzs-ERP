## A supplier freebie printed as RM 0.00 with nothing to say it was free [medium]

**Symptom.** The same physical goods carried a **FOC** badge on the delivery
order and the sales invoice, and on the purchase order, goods receipt and
purchase invoice that brought them in they were a line reading **RM 0.00** with
no marker at all. A zero printed as money reads as missing data — a price
somebody forgot to key — which is the opposite of what it means.

The owner's ruling, 2026-09-12: the free-of-charge marker belongs on every
document, not on the sales side only.

**Root cause (traced).** Not a defect in a rule — an absence. The three sales
documents put the badge in their Discount column; the three purchase documents
have no Discount column on their line grids at all. `purchase_order_items`,
`grn_items` and `purchase_invoice_items` each store a discount, but none of the
three detail pages reads it, so there was no cell the sales-side pattern could
be copied into and it was never added.

**Fix.** `FocAmount` (`frontend/src/vendor/scm/components/FocAmount.tsx`) renders
the Amount cell of a document line: the FOC badge where the line charges
nothing, the formatted money otherwise. Wired into the purchase order, goods
receipt and purchase invoice line grids.

The badge went in the AMOUNT cell rather than in a new Discount column on
purpose. "Did we pay for this?" is asked at the amount, and widening three row
types and three API selects to print a column nobody asked for is not what was
requested. The three sales documents keep their Discount-column placement: they
already have the column, and moving it would be churn on a working screen.

The rule is not re-derived. `isFocLine` (`vendor/scm/lib/foc-line.ts`) is the one
answer every surface uses — written because four surfaces had grown four
different ones and the same line read FOC on the delivery order and Sale on the
invoice for the same goods
(`docs/bugs/0846-the-same-free-line-read-foc-on-the-delivery-order-and-sale-o.md`).

One judgement worth reading: the freight sub-line is DROPPED on a free line. The
goods receipt and purchase invoice print allocated landed cost under the amount,
and "FOC" beside "+freight RM 12.00" reads as two answers to one question. A
freebie that carries allocated freight still cost nothing to BUY, which is what
the badge claims. Pinned as its own case in `focAmount.test.tsx`.

**Ref.** feat/foc-badge-purchase-side, 2026-09-13.
