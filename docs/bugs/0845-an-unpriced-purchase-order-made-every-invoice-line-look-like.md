## An unpriced purchase order made every invoice line look like an overcharge [medium]

<!-- area: Purchase orders + GRN + PI -->

**Symptom.** Found by checking the feature on staging the hour it shipped, not
by a report. `docs/bugs/0844-a-purchase-invoice-showed-only-what-the-supplier-billed-neve.md`
put the ordered price beside the billed one and marked the difference in red.
On a real purchase invoice, **both** lines came back red for the full amount:
`8051-1A(P)(RHF)` +RM 2,138.00, `SQUARE PILLOW` +RM 30.00 — while nobody had
overcharged anything.

**Root cause (traced).** The ordered price on those lines is **0**, and 0 was
treated as a real price. It is not: `supplierCostFor` in `mfg-purchase-orders.ts`
writes 0 for a SKU with no supplier binding and says so in its own words —
*"unbound — key in at PI"*. The purchase order never named a price for that
line; the invoice is where the price is first stated. Subtracting a
never-stated 0 turns the entire billed amount into a "difference".

**How big it was, measured rather than reasoned** — 25 live purchase invoices,
115 lines, staging copy of production, 2026-09-12:

| | lines | |
|---|---|---|
| ordered price **0** — never priced | **78** | 68% |
| ordered **==** billed | 35 | 30% |
| genuinely different | **2** | 1.7% |

The two real ones are both on `HC-PI-008026`: `TRION (A)-(K)` ordered RM 800.00
billed RM 830.00, and `JAGER-(Q)` ordered RM 200.00 billed RM 225.00 — exactly
what the owner asked to be able to see (「有差异的话，我们基本上就要做 checking」).
Painting 78 lines red buries them, which defeats the feature.

**Fix.** `0` joins `null` in `comparePiLinePrice` and in
`piPriceDifferenceSummary`: `diffSen` is null and `differs` is false. The value
is still REPORTED, so the column can say **"not priced"** rather than `0.00` —
three different facts kept apart: *no purchase order behind this line* (`—`),
*the order named no price* ("not priced"), and *the order said RM X* (the
figure, with the delta when it differs).

This corrects a decision the previous entry's own test asserted the other way
("an order placed at zero IS a difference"). That assertion was written from
reading the code path; the measurement above is what changed it.

**Ref.** fix/pi-po-price-zero-means-unpriced, 2026-09-12.
