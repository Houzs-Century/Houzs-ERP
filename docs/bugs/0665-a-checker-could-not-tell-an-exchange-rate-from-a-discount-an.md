## A checker could not tell an exchange rate from a discount and took RM 13,068.55 off a live CNY purchase order [critical]

<!-- area: Purchase orders + GRN + PI -->
<!-- status: fixed -->

**Symptom.** `HC-PO-009335` (AutoCount `PO-009335`) read **RM 34,334.90** in the
ERP, which is exactly what AutoCount's own header states. After the PO
line-discount repair was applied to production on 2026-09-07 (run
[34116301278](https://github.com/hello-houzs/Houzs-ERP/actions/runs/34116301278),
19:23 local) it read **RM 21,266.35**, with RM 13,068.55 of "line discount"
spread across its five lines. AutoCount states no discount on that document at
all. Nine of the ten orders that run touched are correct; this is the tenth.

**Root cause (traced).** The document is denominated in **Chinese yuan**, and
the checker was comparing two different currencies:

```
PO-009335        currency CNY   rate 0.619380   Total 34,334.90 (CNY)   LocalNetTotal 21,266.35 (MYR)
the other nine   currency MYR   rate 1.000000
```

Two lines, on opposite sides of the comparison:

| where | what it does |
|---|---|
| `backend/scripts/export-ac-reconcile-truth.mjs:196` | header amount is `ISNULL(h.LocalNetTotal, h.NetTotal)` — the **local-currency (MYR)** figure |
| `backend/scripts/export-ac-reconcile-truth.mjs:224` | line amount is `ISNULL(d.LocalSubTotal, d.SubTotal)` — likewise **MYR** |
| `backend/scripts/import-ac-outstanding-po.mjs:401` | the importer hard-codes `'MYR'` into `purchase_orders.currency` and writes the **document-currency** amounts |

So on a non-MYR document the snapshot holds MYR and the ERP holds CNY. The
repair's rule is `discount = qty x unit_price_sen - <the book's own line
amount>`, which on this document is `34,334.90 - 21,266.35 = 13,068.55`.
**34,334.90 x 0.61938 = 21,266.35.** The "38.06% discount" it reported is the
exchange rate, and `1 - 0.61938 = 0.38062`.

Read live from `AED_HOUZS`, every line of the document carries
`DiscountAmt = 0.00` with `SubTotal = Qty x UnitPrice` exactly:

```
JM-CL JAC WP MP (K)   240 @ 68.54  disc 0.00  line 16,449.60  dtl 851335
JM-CL JAC WP MP (Q)   230 @ 59.65  disc 0.00  line 13,719.50  dtl 851336
JM-CL JAC WP MP (SS)   40 @ 46.18  disc 0.00  line  1,847.20  dtl 851337
JM-CL JAC WP MP (SK)   20 @ 74.37  disc 0.00  line  1,487.40  dtl 851338
JM-CL JAC WP MP (S)    20 @ 41.56  disc 0.00  line    831.20  dtl 851339
                                                    ---------
                                                    34,334.90 = the header Total
```

**Exposure, measured, not estimated.** The book holds **22 CNY purchase orders**
out of 9,412; of those, **exactly 1 falls in the migrated scope**, and it is this
one. All 13,366 sales orders are MYR. The blast radius is one document — but the
defect is a class, and the other 21 must stay out.

**THE FAILURE WORTH RECORDING IS NOT THE CURRENCY BUG. IT IS THAT THE OUTLIER
WAS SEEN AND EXPLAINED AWAY.** `docs/bugs/0664-the-po-line-discount-repair-planned-but-not-applied-10-live.md`
carries a correction block, written the same day, that says in full:

> **84 lines are 25.00% off and 5 are 38.06% off, all five on PO-009335.**
> [...] **The repair is unaffected, and that is worth stating rather than
> assuming.** `planDocument` computes `discountSen = qty * unit_price_sen - <the
> book's own line amount>` in whole sen. It never derives, applies or validates a
> PERCENTAGE, so a line at 38.06% is copied exactly as faithfully as one at 25%.

Every sentence of that is **true about the code and wrong about the world.** The
question the anomaly was actually asking was not *does the script handle a 38%
discount correctly* — it does — but *why is one document out of ten different
from the other nine at all*. One document behaving unlike its nine neighbours is
a fact about the document, and it was answered by re-reading the script. The
paragraph even names the right instinct ("worth stating rather than assuming")
and then discharges it against the wrong artefact. **Reasoning an anomaly away
is not the same as explaining it**, and the tell is that the explanation never
left the source tree: `SELECT DocNo, CurrencyCode, CurrencyRate FROM PO WHERE
DocNo = 'PO-009335'` is one statement, and it was never run.

This is the `claim-before-check` failure a second time in one day, on the same
document, one level up: the first round inferred a rate from nine documents and
never looked at the tenth; the correction looked at the tenth, found it
different, and inferred that the difference did not matter.

**Fix.** Two parts, because the row and the class are different problems.

1. **The revert.** `backend/scripts/revert-po-cny-false-discount.mjs` +
   `.github/workflows/revert-po-cny-false-discount.yml` put the five lines back
   to `discount_sen = 0` with `line_total_sen = qty x unit_price_sen`, and
   re-sum the header to RM 34,334.90 — the same three-part write the repair made,
   because `mfg-purchase-orders.ts:3042` recomputes
   `lineTotal = max(0, qty*unit - discount)` on every edit and a partial revert
   is self-erasing. It writes all five lines or none, refuses unless the
   post-revert header equals RM 34,334.90 exactly, and guards every UPDATE on the
   row still holding the exact values run 34116301278 left.

2. **The class.** `repair-po-line-discount.mjs` now **REFUSES** any document
   whose AutoCount currency is not the ERP's local currency or whose rate is not
   1, and lists it. A discount and an exchange rate are not distinguishable from
   a total alone, so the script must not try. It also refuses to run at all
   against a snapshot cut before the exporter carried currency — a script that
   cannot see the currency cannot claim a document does not have one.
   `export-ac-reconcile-truth.mjs` now exports `CurrencyCode` and `CurrencyRate`
   per header and BOTH the document-currency and local-currency amounts, so the
   checker can compare like with like instead of choosing one and hoping.

**Ref.** fix/po-cny-discount-revert, 2026-09-07. Follows
`docs/bugs/0664-the-po-line-discount-repair-planned-but-not-applied-10-live.md`,
whose correction block this entry corrects in turn.
