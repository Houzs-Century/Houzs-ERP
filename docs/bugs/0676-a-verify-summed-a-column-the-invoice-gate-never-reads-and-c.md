## A verify summed a column the invoice gate never reads, and called 5 correct invoices wrong [medium]

<!-- area: Cutover + migrated data -->

**Symptom.** `stamp-migrated-source-prices.yml` applied against prod
(run [34141318054](https://github.com/hello-houzs/Houzs-ERP/actions/runs/34141318054),
2026-09-08 00:03 local). Every line write landed and self-checked:

```
lines written: 32 of 32
headers written: 28 of 28
32 of 32 stamped line(s) re-read; invariant broken on 0, disagreeing with the book on 0
```

and then the invoice-level arm of the same verification failed on five:

```
PI-007817: our source line(s) now sum to RM 2,380.00, AutoCount billed RM 4,452.00 — THESE DISAGREE
PI-007824: RM 4,388.00 vs RM 4,628.00 · PI-007822: RM 1,210.00 vs RM 1,270.00
PI-007895: RM 2,753.00 vs RM 2,813.00 · PI-007894: RM 7,700.00 vs RM 7,880.00
19 of 24 AutoCount invoice(s) now reconcile to the sen.
```

**All five were already correct.** The converter's own dry-run, run minutes
later against the same rows, lists every one of them in `WOULD CREATE` at
exactly AutoCount's total — `HC-PI-007817 ... RM 4452.00`, `HC-PI-007894 ...
RM 7880.00`, and so on.

**Root cause (traced, not guessed).** The verification summed
`SUM(line_total_sen)`. The gate it was verifying never reads that column:
`migrated-chain.ts` `lineValueSen` is

```ts
Math.max(0, Math.round(l.qty * l.unitPriceSen) - Math.round(l.discountSen ?? 0))
```

over the lines with `qty > 0`. The five failing groups each contain lines the
cutover left carrying a unit price with `line_total_sen` still 0 — PI-007817's
sibling receipt is worth RM 2,072.00 by the gate's rule and RM 0.00 by the
column. So the two numbers were never the same quantity, and the gap was the
check's own.

**Why it matters more than the five annotations.** A red verification on a
production money write reads as "back it out", and backing this one out would
have discarded 32 correct line prices. That is the same shape as
`docs/bugs/0594` (a repair verify compared against the raw master and cried
failure) and as the `sync-ac-delta` lane bug earlier the same day: **the
artefact that was wrong was the check, and a check that computes a different
number from the thing it checks will always find a defect eventually — its
own.**

**Fix.** The invoice-level arm now sums with the gate's rule in SQL —
`GREATEST(0, ROUND((qty_accepted - invoiced - returned) * unit_price_sen) -
discount_sen)` over lines with a positive remaining quantity, and the delivery
side additionally falls back to the sales-order price the converter recovers.
Re-run read-only against the rows the apply left: 6 of 6 previously
"disagreeing" invoices AGREE, including `HC-DO-010332` / `I-2606-0047` at
RM 6,500.00.

**What this does NOT change.** The per-line arm was right and stays: it asserts
the app's own invariant `line_total_sen = qty*unit - discount` and the equality
with AutoCount's own line amount, and it reported `invariant broken on 0,
disagreeing with the book on 0` on the run above.

**Ref.** docs/cutover-keys-and-ledger, 2026-09-08. Follows
`docs/bugs/0674-the-migrated-goods-receipts-carry-no-money-and-the-price-is-.md`,
which shipped the script.
