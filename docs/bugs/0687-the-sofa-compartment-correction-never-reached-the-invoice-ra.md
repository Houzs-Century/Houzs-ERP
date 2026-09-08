## The sofa compartment correction never reached the invoice raised from the document it corrected [high]

**Symptom.** Four invoice lines in production carry a link to the delivery or
receipt line they were raised from, and that line names a DIFFERENT item code.
Every one is FILLED and none DANGLES, so no constraint fires, no coverage count
drops, and `probe-doc-link-matrix.mjs` reports both chains clean. It is an
instance of `docs/bugs/0672-bug-class-key-without-identity-a-link-written-on-the-key-alo.md`.

**PROVEN — `probe-invoice-link-facts.mjs` run 34178911176, 2026-09-08 10:08
local, conclusion `success`:**

| invoice | says | its parent says | parent lines |
|---|---|---|---|
| `HC-I-000745` | `5526-1S` | `HC-DO-000542` `5526-L(LHF)` | 1 |
| `HC-I-2412-0065` | `2379-1S` | `HC-DO-002158` `2379-2S` | 1 |
| `HC-PI-007551` | `9058-1S` | `HC-GR-005068` `9058-1A(LHF)` | 1 |
| `HC-PI-007920` | `8030-1S` | `HC-GR-005277` `8030-1A(LHF)` | 1 |

`probe-link-identity` counted five on 2026-09-07 23:22; `HC-PI-007917` was moved
by another lane in the window and is gone. Re-measured rather than carried
forward, which is why this table says four.

**The LINK is not the error, and that is the first finding.** Every parent
document holds exactly ONE line. There is no other row the invoice could name,
so the link is forced by cardinality and nothing here touches it.

**What the BOOK says, and it is the arbiter** (`migration-copy-never-compute`).
Read against the AutoCount re-cut committed at 08:03-08:07 today —
`backend/scripts/data/ac-reconcile-truth.json.gz`, `exported_at
2026-09-08T00:03:44Z`, 48,772 DO lines and 22,633 PI lines:

```
IV I-000745    <- DO-000542   RDS-5526 SOFA    Desc2 "[ (1 ELT / T + NA +2ER) (28") / COL: J9883-1-1 PAMA]"
IV I-2412-0065 <- DO-002158   THL-2379         Desc2 "2R(60cm) / Guardian - 05"
PI PI-007551   <- GR-005068   AMN-SF9058 SOFA  Desc2 identical on both sides
PI PI-007920   <- GR-005277   DSL-8030 SOFA    Desc2 identical on both sides
```

On all four the book carries ONE line on each side, the SAME item code and the
SAME Desc2 on both, and states the transfer itself (`IVDTL.FromDocType='DO'`,
`PIDTL.FromDocType='GR'`); `ac-invoice-refs.json.gz` agrees document for
document. So the book says the two sides are the same line-item — **the
disagreement is ours, on one side, and it is the invoice's.**

On the two the book can arbitrate directly it names the parent's piece and not
the invoice's: `1 ELT` is the owner's ELT = L (`sofa-slip-notation`), which is
`5526-L(LHF)`; `2R` is the two-seater, which is `2379-2S`. Neither Desc2
contains a one-seater. The book carries a sofa as ONE line and never names a
compartment, so for the other two it settles the EQUALITY without naming the
value — which is enough, because only one side moved.

**Root cause, traced.** A migrated invoice line is a SNAPSHOT and has no opinion
of its own: `create-migrated-invoices.mjs` copies `l._row.item_code` and
`l._row.variants` straight off the parent row, at `:305` for a purchase invoice
and `:345` for a sales one. The parent then MOVED.
`apply-sofa-compartment-corrections.mjs` rewrites a sofa that reached the ERP as
a bare `-1S` placeholder into the owner-approved compartments — the corrections
file says so in its own `_note`, *"the sofa lines still on a bare -1S
placeholder"* — and carries the new code down the chain. Its comment states the
reason exactly:

> All three took a SNAPSHOT of the code and variants when they were created
> (create-migrated-documents.mjs), so correcting the parent alone would leave
> them stating the old build.

**The carry named `purchase_order_items`, `grn_items` and
`delivery_order_items`, and stopped.** The two invoice tables took the same
snapshot from the same rows and are not in the loop. All four documents above
are named in an owner-approved corrections file — `HC-SO-000814`,
`HC-SO-003295`, `HC-PO-009260` in the 2026-09 round, `HC-PO-009597` in the
2026-08 round — and all four invoice lines still read the pre-correction
placeholder. That is 4 of 4: the correspondence is total, not suggestive.

**What it costs, and it is not the invoice's face value.** The invoice line
carries its own quantity and price and all four already match the book's own net
total to the sen. What a wrong code costs is downstream:
`sales_invoice_items.do_item_id` is the `invoiced` term in
`remaining = delivered - invoiced - returned` and
`purchase_invoice_items.grn_item_id` is how a supplier invoice's money reaches
the lot it paid for — both are keyed on the LINK, which is correct here, so no
money is currently mis-routed. The damage is that the ERP and the account book
state different products for the same line, which is what every future
reconcile, every write-back and every person reading the document will trip on.

**Fix.**

1. **The site.** `apply-sofa-compartment-corrections.mjs` now carries the
   corrected code and variants onto `purchase_invoice_items` and
   `sales_invoice_items` as well, guarded by `migrated_no_stock` — the same
   assertion the GRN and DO carry already rests on. A typed invoice is somebody's
   own statement about what was billed: it is HELD, reported by number, and never
   overwritten. Both counts are printed, so a run that carried none is visible.
2. **The rows.** `repair-invoice-item-from-parent.mjs` (new, PLAN by default,
   CONFIRM phrase on apply, fresh-connection SHAPE verify, `RE-RUN:` note) puts
   the four back on their parent's code. The decision is pure and tested —
   `scripts/lib/invoice-snapshot-repair.mjs`. A repair is offered only when it is
   FORCED: the invoice is migrated paperwork, the parent holds exactly ONE line,
   and the two codes are two compartments of ONE model. **A different MODEL is
   REFUSED and listed**, because that is a wrong LINK and not a stale
   compartment, and rewriting the code would erase the evidence instead of
   repairing it.

It writes `item_code` only — never qty, price, discount, line total, the link,
the parent row, or a header. `variants` is deliberately left alone: 0672 records
the colour comparison on these rows as currently INVALID (`colourId` on one side
against `colourLabel` on the other), and repairing something whose correctness
has not been established is the failure this repo keeps paying for.

**Proved RED first.** `tests/sofaCorrectionsCarryToInvoices.test.mjs` failed 4 of
5 against the unfixed site; `tests/invoiceSnapshotRepair.test.mjs` passes 9 with
the guards and fails its 4 refusal assertions with them removed, so they are not
a false negative. 14 passed after the fix, backend typecheck clean,
`audit:release-discipline` reports no new violations.

**Ref.** fix/cutover-wrong-links, 2026-09-08.
