## The sales side had no discount field at all while purchasing had one [medium]

<!-- area: Sales orders + pricing -->

**Symptom.** Owner, 2026-09-12, on the six-document parity plan: 「折扣百分比全部
都可以补齐」 — P1. A discount on a Purchase Order line has had its own box since
2026-09-11 (`docs/bugs/0803-*.md`); on a **Sales Order** line there was nowhere
to put one. A salesperson giving RM 250 off had to write it into the unit price,
which loses the fact that a discount was given: the printed document, the margin
and AutoCount all read a cheaper product instead of a discounted one.

**Root cause (traced).** Not missing plumbing — a missing control. The column
and the server rule have existed all along:

- `scm.mfg_sales_order_items.discount_sen` exists (renamed from `_centi` by
  mig `0305`), and the SO line routes validate it —
  *"discountSen must be between 0 and qty × unit price"* (`mfg-sales-orders.ts`,
  three write paths).
- `SoLineDraft.discountSen` exists and every consumer already reads and persists
  it.
- `SoLineCard` **displayed** it (`− Discount` in the price breakdown, shown only
  when `> 0`) and offered no way to set it. The one writer was the
  delivery-FEE path, where the amount cell writes
  `discountSen = gross − charged` (`feeDiscountForAmount`).

So the discount was a value the system could store, print and validate, that no
sales screen could enter.

**Fix.** One `DiscountInput` in the `SoLineCard` row, between Unit Price and
Delivery Date — the same component the purchase side uses, so `1000` is ringgit
and `25%` is a percentage of qty × unit price (`docs/bugs/0842-the-discount-percentage-was-a-mode-to-pick-instead-of-someth.md`).
It commits sen into `draft.discountSen`; the server rule that was already there
is what bounds it.

A **delivery-fee line is disabled** and renders the amount read-only, because
its price cell already writes that same field — two controls on one value would
fight. The grid gained a 116px column (and its 1100px-breakpoint twin); the cell
is wider than Unit Price because it carries the conversion hint underneath.

`SoLineCard` is rendered by eleven pages, so the one change lands the field on
the Sales Order, Delivery Order, Sales Invoice, Delivery Return and the six
consignment screens at once — all of which already carry `discountSen` on their
draft and persist it as `discount_sen`. The Purchase Invoice is not among them:
it uses `PoLineCard`, which has had the control since 2026-09-11.

**Ref.** feat/so-line-discount-field, 2026-09-12.
