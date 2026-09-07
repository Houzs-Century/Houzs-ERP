## A migrated sales order could never gain a line it was imported without, so RM 0.00 give-away goods the customer is owed sat on no ERP document [high]

**Symptom.** `HC-SO-012128` carries, in AutoCount, 4 x `HOK-SQUARE PILLOW` at
RM 0.00 marked `FOR CONPESSANTION WRONG ITEM DELIVERY` — four pillows the
customer is owed for a wrong delivery. The ERP document had no pillow line at
all. `HC-SO-004188` is the same shape twice over: `AK-ULTIMATE MATT (Q)` x1 and
`AK-SK + MICROFIL PIL` x2, both at RM 0.00, both absent.

**Root cause (traced).** `import-ac-outstanding-so.mjs` is idempotent at
DOCUMENT level, not at line level:

```
const todo = built.filter((o) => !existing.has(o.docNo));   // :421
```

and its own header says *"items and payments are written only for a NEWLY
inserted header"*. So whatever a run did not carry can never arrive: the next
run reports the document as already imported and writes nothing. Exactly the
defect `topup-ac-po-lines.mjs` exists to repair on the purchase side, on the
sales side, unrepaired.

The mechanism that dropped these particular lines is the importer's
unmapped-and-free rule: a line whose ItemCode resolves to no ERP product and
whose `UnitPrice` is 0 is dropped (`else { droppedZero++; continue; }`). All
three codes above ARE in today's binding CSV — `HOK-SQUARE PILLOW` carries
status `NEW` — so they were bound AFTER the run that imported these documents,
and document-level idempotency then made the gap permanent.

This is NOT the `Math.round(num(l.Qty)) || 1` defect, which was zero QUANTITY
and is already fixed and removed. Zero quantity and zero price are different
things.

**Fix.** `backend/scripts/topup-ac-so-lines.mjs`, the SO twin of the PO top-up.
The match is AutoCount's own `DtlKey` on both sides — the export's `DtlKey`
against `mfg_sales_order_items.linked_ac_dtlkey` — so it is exact and never
fuzzy; a decomposed sofa line stamps all its ERP rows with the same key, so the
test still answers correctly. A document holding ANY line with a NULL
`linked_ac_dtlkey` cannot be judged and is REPORTED, never touched: under-repair,
never duplicate.

It writes ONLY a missing line at unit price 0, and only outside sofa/bedframe.
Price, because the header carries `local_total_sen`, `balance_sen`, `paid_sen`
and five category buckets computed from the lines the importer wrote — inserting
a PRICED line makes the header disagree with its own lines and breaks the
payment reconcile, so a priced miss is reported for an owner decision. A
zero-priced line moves every one of those sums by exactly 0; `line_count` is the
one header column that moves and it is bumped in the same transaction. Group,
because re-decoding a sofa into compartments or a bedframe into gap/divan/leg
here would be a second copy of an import rule, which is this repo's most
expensive recurring bug class — those are reported with the tool that owns them.

The apply path re-reads the document's live keys INSIDE the transaction, then
verifies on a FRESH connection that each written line reads back with the book's
item and quantity at RM 0.00 AND that the document's header total still equals
the sum of its lines. A row count would not have caught a moved total.

**Ref.** fix/ac-display-sofas, 2026-09-08.
