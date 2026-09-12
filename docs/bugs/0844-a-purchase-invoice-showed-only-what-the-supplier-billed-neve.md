## A purchase invoice showed only what the supplier billed, never what we ordered [medium]

<!-- area: Purchase orders + GRN + PI -->

**Symptom.** Owner, 2026-09-12:

> 我的 Purchase Invoice 应该要有两个价钱：第一个价钱是从 PO 那边带过来的，第二个
> 价钱可能是 Supplier 给我 fill-in 进去的 … 然后我就会看到：原来我的 PO 带出来的
> 价钱是多少钱，可是 Supplier 为什么比我高或者比较低？它就有差异。有差异的话，我们
> 基本上就要做 checking

The PI line showed one number, **Unit price**, and that number is the supplier's
— a keyed-in invoice price overwrites the price the line was converted with. So
a supplier billing RM 485 against an RM 415 order produced a document that
looked entirely ordinary, and the only way to catch it was to open the purchase
order in another tab and compare by eye.

**Root cause (traced).** Nothing stored the ordered price beside the billed one,
and nothing needed to: the chain to it already exists on every goods line —

```
purchase_invoice_items.grn_item_id
  -> grn_items.purchase_order_item_id
    -> purchase_order_items.unit_price_sen
```

The detail route already walks the first hop (it reads `grn_items` for
`supplier_sku`, and walks `purchase_order_item_id` further on for the customer
DO list). The ordered price was simply never asked for or served.

**Fix.** `GET /purchase-invoices/:id` now serves `po_unit_price_sen` per item,
resolved through those two hops in the block that was already reading
`grn_items` — so it costs one extra read for the whole document, not one per
line.

Deliberately a **join, not a stored copy**: a purchase order is amendable, and a
price snapshotted at conversion would go on showing what the order USED to say
after Purchasing renegotiated it. The join always answers "what does the
purchase order say today", which is the number a person checking a bill wants.

The mapping is `backend/src/scm/lib/pi-po-price.ts` — pure, so the case that
matters is tested without a database: a line with **no** purchase order behind
it (a PI-native service line, a receipt taken without a PO, a `grn_item` the
caller cannot see) reads **no PO price**, never "the supplier overcharged by the
whole amount". An order genuinely placed at **0** — the unbound-SKU case
`mfg-purchase-orders.ts` writes as *"key in at PI"* — IS a difference, and is
reported as one.

The PI detail page gains a read-only **PO price** column before **Supplier
price**; where the two differ the supplier cell carries the delta underneath, red
when the supplier billed more and green when less, with the sentence to act on
in its tooltip. A line with no ordered price renders `—`, not `0.00`, which
would read as a giveaway.

Pinned by `backend/tests/piPoPrice.test.ts` — 13 cases over the comparison, the
two hops and the header summary (a credit and a charge must not hide each other
in the COUNT). Backend `tsc --noEmit` and frontend `tsc -b` clean.

**Ref.** feat/pi-po-price-vs-supplier-price, 2026-09-12.
