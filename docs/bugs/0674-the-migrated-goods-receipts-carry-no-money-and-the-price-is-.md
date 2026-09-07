## The migrated goods receipts carry no money, and the price is on the RECEIPT line — not the purchase order [high]

<!-- area: Cutover + migrated data -->

**Symptom.** `create-migrated-invoices.mjs` dry-run against prod, 2026-09-07
23:19 local (local run, read-only DSN, `KIND=both`):

```
=== PURCHASE INVOICES (from migrated goods receipts) ===
source documents: 320     WOULD CREATE: 0     refused: 320
  total_disagrees_with_autocount: 270
  of the 270 total mismatches: 95 are ours RM 0.00 ..., 175 have both sides priced and genuinely differ
=== SALES INVOICES (from migrated delivery orders) ===
  of the 4 total mismatches: 2 are ours RM 0.00, 2 ... genuinely differ
```

97 source documents are worth RM 0.00 in the ERP where the book states a price,
so the converter's total gate refuses every invoice they should raise.

**Root cause (traced, not guessed).** `create-migrated-documents.mjs` carried
the quantity of the outstanding receipts and dropped the money — the same
omission `docs/bugs/0617` records on the delivery side. `scm.grn_items`
`unit_price_sen` is `integer DEFAULT 0 NOT NULL`, so the miss is silent: a
stored zero is indistinguishable from a genuinely free line.

**The trap, and it is the part worth recording.** The obvious repair — copy the
price off the purchase order the receipt came from — writes nothing at all.
Read from the committed 2026-09-07 cut, on ALL 180 zero-priced migrated receipt
lines the book's own PO line reads `UnitPrice 0.00, SubTotal 0.00`. Houzs does
not price factory purchase orders in AutoCount (7,591 of 9,416 POs carry
`NetTotal 0.00`). **The money first appears on the GOODS RECEIPT line**, and the
purchase invoice bills that line:

```
PO-001068 DtlKey 145254  qty 1  UnitPrice     0.00  SubTotal     0.00
GR-000815 DtlKey 209355  qty 1  UnitPrice 3,373.45  SubTotal 2,867.43
PI-001531                                           NetTotal 2,867.43
```

And `SubTotal` is the value, not `qty x UnitPrice`: the RM 506.02 between the
two columns is the line discount of `docs/bugs/0662` / `0664`, on the receipt
this time. Copying the unit price leaves the gate refusing by exactly that.

**A price does NOT fix most of them, and the count says so.** The 95 zero-priced
receipts fall into 41 AutoCount purchase invoices. For 20 of those the book's
own receipt lines for OUR purchase order sum to LESS than the invoice —
PI-006897 bills RM 10,893.00 against a line set worth RM 2,224.00 — because a
migrated receipt is a PARTIAL mirror: the cutover imported one outstanding
purchase order and AutoCount's receipt spans several. Those are the multi-order
fragments already with the owner, and stamping them would have been actively
harmful: a correct price there moves an owner-held decision out of the
converter's "ours RM 0.00" bucket and into "both sides priced and genuinely
differ", where the next reader meets it as a new problem.

**Fix.** `backend/scripts/stamp-migrated-source-prices.mjs` +
`stamp-migrated-source-prices.yml`, with every decision in the pure
`scripts/lib/migrated-source-price-plan.mjs` (12 tests, each a planted defect).
It writes `unit_price_sen`, `discount_sen` AND `line_total_sen` — all three,
because the app recomputes `line_total = qty*unit - discount` on every edit
(`grns.ts:1654`, `:1885`, `:2256`) and a line total written alone is
self-erasing — then re-sums the header.

Four refusals carry the weight:

| refusal | why |
|---|---|
| the invoice must reconcile AFTER the stamp | the partial-mirror fragments above are left at RM 0.00 on purpose |
| one AutoCount line is many ERP rows | a sofa is one GRDTL row and one ERP row per compartment; the price rides the LEAD piece and the siblings stay 0, which is what `import-ac-outstanding-po.mjs:290` already does. Spreading it is `docs/bugs/0673`, RM 2,216,501 |
| an assignment only sort order could decide | two book lines of equal quantity and different money landing on two different products is refused, never ordered |
| blank never overwrites | 空白不覆盖; a book line that STATES zero is honoured as zero and written not at all |

Currency is a refusal, not a conversion (`docs/bugs/0665`), and the cross-check
is not circular: the line money comes from `ac-reconcile-truth.json.gz`
(GRDTL/DODTL) and the invoice total from `ac-invoice-refs.json.gz` (PI/IV
headers) — two independent exports of the same book agreeing to the sen.

**Ref.** fix/cutover-price-colour-keys, 2026-09-07.
