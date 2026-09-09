## The sofa corrections named only the sales order, so every purchase order raised from one kept a single lead compartment [high]

**Symptom.** Fourteen sales orders and thirteen purchase orders differ from the
account book on the `transfer to` / `transfer from` axes, run
[34298132223](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34298132223)
on a book cut 0.03 days old:

```
SALES ORDERS      2,888 documents — 18 differ  (14 of them transfer to)
PURCHASE ORDERS     574 documents — 13 differ  (7 transfer to, 6 transfer from)
```

Every one of the thirteen purchase orders is a single sofa line raised from a
sales order, and the book says the whole line has been purchased
(`TransferedQty 1` of `qty 1`, read from
`backend/scripts/data/ac-convert-edges.json.gz`).

**Root cause, traced.** `lib/transfer-counter-verdict.mjs` compares the
FRACTION transferred, deliberately, so that a decomposition cannot look like a
defect: the book moved `t` of `q`, the ERP moved `T` of `Q`, and `t*Q === T*q`
is the same fact in both systems. A sofa is one line in the book and one ERP row
per COMPARTMENT, so a sales order holding three compartments of which one is
purchased reads `1/3` against the book's `1/1` and is correctly reported as
`erp_low`. **Every compartment has to be purchased for the fraction to agree.**

They are not, and the reason is in the data file rather than in any code path.
`backend/scripts/data/sofa-compartment-corrections-drawings.json` carries fifty
owner-approved builds and **every single entry names exactly one document, and
it is always the SALES order.** So `apply-sofa-compartment-corrections.mjs`
wrote the compartments onto the sales order and never onto the purchase order
raised from it. Measured on production, read-only run
[34299650607](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34299650607)
(`probe-so-po-compartment-cover.mjs`, book cut `2026-09-09T00:18:49Z`):

| the ERP sales order carries | the ERP purchase order carries |
| --- | --- |
| `HC-SO-013103` `1A(LHF)` `1NA` `1A(RHF)` | `HC-PO-009783` [SUBMITTED] `8030-1A(LHF)` |
| `HC-SO-013258` `1A(LHF)` `1NA` `L(RHF)` | `HC-PO-010160` [SUBMITTED] `1A(LHF)` `L(RHF)` |
| `HC-SO-013310` `2A(LHF)` `L(RHF)` | `HC-PO-010146` [SUBMITTED] `5535-2A(LHF)` |
| `HC-SO-013322` `1A(RHF)` `1NA` `L(LHF)` | `HC-PO-010161` [SUBMITTED] `8030-L(LHF)` |
| `HC-SO-013389` `1A(LHF)` `1A(RHF)` | `HC-PO-010087` [SUBMITTED] `8030-1A(LHF)` |
| `HC-SO-013434` `1A(LHF)` `1A(RHF)` | `HC-PO-010151` [SUBMITTED] `8030-1A(LHF)` |
| `HC-SO-011160` `1A(LHF)` `1NA` `L(RHF)` | `HC-PO-010150` [SUBMITTED] `9058-1A(LHF)` |
| `HC-SO-010209` `1A(LHF)` `1NA` `L(RHF)` | `HC-PO-009587` [RECEIVED] `9058-1S` |
| `HC-SO-010955` `2A(LHF)` `CNR` `1A(RHF)` | `HC-PO-009679` [RECEIVED] `9058-1S` |
| `HC-SO-011207` `2A(LHF)` `L(RHF)` | `HC-PO-009830` [RECEIVED] `9028-1S` |
| `HC-SO-012128` `1A(LHF)` `1A(RHF)` | `HC-PO-009467` [RECEIVED] `9028-1S` |
| `HC-SO-012729` `2A(LHF)` `CNR` `1A(RHF)` | `HC-PO-009554` [RECEIVED] `9058-1S` |
| `HC-SO-010287` `2A(LHF)` `1A(RHF)` | `HC-PO-010085` [SUBMITTED] `1A(LHF)` `2A(RHF)` — MIRRORED |

**And the second half of the cause: where an entry DID name the purchase order,
it could not find it.** Four entries in
`sofa-compartment-corrections-2026-08.json` name both sides, and the plan run
[34297962031](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34297962031)
skipped every one of the purchase orders with

```
HC-PO-009679: no line matches "{SIZE:2ER+C+1ER+(28")}/{COL:CH141-12 MET"
              (no line carries this text, exactly or normalised)
              — skipped, the build is not on this document
```

while that string **is** the account book's own Desc2 for `PO-009679` line
`880127`, byte for byte
(`backend/scripts/data/ac-reconcile-truth.json.gz`, cut `2026-09-09T00:18:49Z`).
The needle is written from the BOOK and matched against
`scm.purchase_order_items.description2`, and the ERP's purchase row does not
hold the book's text. Eleven purchase orders were skipped that way in one run.

**Why it is not cosmetic.** `isHardBoundLine`
(`backend/src/scm/lib/so-stock-allocation.ts`) makes a company-1 sofa sales line
read READY only through its own dedicated purchase-order line. A compartment
whose purchase order is not linked can never light up when the goods arrive, and
MRP goes on offering that line for purchase — the duplicate-purchase-order risk
`recompute-so-po-qty-picked.mjs` warns about in its own header. Seven of these
sofas are PROCEEDED, which means the factory is building them.

**Fix.** `backend/scripts/data/sofa-compartment-corrections-purchase-side.json`
— fifteen builds, the purchase side of sofas whose sales side is already ruled,
plus two purchase orders whose ERP rows are already correct and only needed the
reading recorded (`HC-PO-009018`, a STOOL the book books as a sofa, and
`HC-PO-010145`, the `1EL + CS + 1EL` the book spells out). Which side moves is
not this file's choice: the owner ruled on 2026-09-09, about `HC-SO-010287`
itself, that **the purchase order follows the sales order**.

**Every entry is addressed by the account book's own `DtlKey`, never by text.**
`scm.purchase_order_items.linked_ac_dtlkey` carries it on every row concerned
(printed as `key NNNNNN` by the probe run above), and
`lib/sofa-desc2-match.mjs` treats a line key as IDENTITY and never falls back to
the text — which is exactly the hole the skipped eleven fell through. Pinned by
a test so a later edit cannot quietly turn one back into a `desc2Match`.

**What this does NOT decide, and deliberately.** Five of the thirteen purchase
orders are RECEIVED. 「库存先不看」 — a write that would move an on-hand figure
stops — and it is not this file that judges that: `downstreamMovedStock` in
`apply-sofa-compartment-corrections.mjs` already refuses a build whose
downstream moved real stock (any `scm.inventory_movements` row naming the
document, or a GRN/DO that is not `migrated_no_stock`) and prints the figure it
refused on. The entries are written so the plan run answers with a measurement
rather than an argument.

**Ref.** fix/ac-align-so-po-gr, 2026-09-09. Sibling entry `docs/bugs/0735`
measured the same fourteen sales orders and attributed them to the owner's
drawing; this is the mechanism underneath that reading, and the drawings are now
read rather than asked for.
