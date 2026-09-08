# Transaction flow tally — Company 1 (Houzs Century)

**Measured 2026-09-08 08:20 local (UTC+8)**, run
[`34173009728`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34173009728),
`Convert symmetry check (read-only)`, concluded `success`.

The book side is the committed AutoCount snapshot
`backend/scripts/data/ac-convert-edges.json.gz`, exported 2026-09-07 16:39 local
from `AED_HOUZS` live. The ERP side is production, read through
`secrets.DATABASE_URL`. SELECTs only — this document cost no write.

Reproduce the whole thing with one dispatch: Actions → **Convert symmetry check
(read-only)** → Run workflow. Section 7 of its output is the table below.

---

## The table

| relationship | forward: book → ERP | backward: ERP → book | disagreements | what they are |
|---|---|---|---|---|
| **Sales order → purchase order** | **506 / 522** | **506 / 506** | 16 forward | 16 book edges dated 2026-06-08 .. 2026-09-04 the ERP has not linked |
| **Sales order → delivery order** | **171 / 173** | **171 / 171** | 2 forward | `DO-001800 ← SO-002281` and `DO-005583 ← SO-007435`. The first is a LIVE alarm — see below |
| **Purchase order → goods receipt** | **497 / 521** | **497 / 497** | 24 forward | all dated 2026-08-28 .. 2026-09-07, the last 11 days |
| **Delivery order → sales invoice** | **46 / 46** | **46 / 46** | 2 wrong item | already filed, `docs/bugs/0676-two-sales-invoices-and-three-purchase-invoices-name-a-source.md` |
| **Goods receipt → purchase invoice** | **394 / 448** COMPOSED | **394 / 394** COMPOSED | 54 forward, 3 wrong item | spread 2026-01-16 .. 2026-09-02 — NOT a backlog |
| *(sixth edge)* invoice raised straight off the order | 0 / 0 | 0 / 0 | — | the book records 142 of these; the ERP imported none of their documents |

**Denominators, stated so they can be audited rather than trusted.**

- **FORWARD** counts book document edges **both of whose documents the ERP
  imported**, neither cancelled. The cutover took OUTSTANDING documents only, so
  the vast majority of the book's edges are legitimately out of scope and
  counting them as failures would drown the real ones. `GR ← PO` and
  `PI ← GR` scope on the **parent only** — an ERP goods receipt carries no
  AutoCount receipt number, so "did the ERP import this GR" is not a question
  that can be put.
- **BACKWARD** counts every edge the ERP asserts. **All six read N of N: the ERP
  has invented no edge the account book does not record.** That is the more
  serious of the two directions and it is clean everywhere.

---

## The five relationships, one at a time

### 1. Sales order → purchase order — PROVEN, 16 open

Forward **506 of 522**, backward **506 of 506**. Zero wrong products.

This is the made-to-order edge and the only one AutoCount keys at LINE level
(`PODTL.FromSODtlKey`; `FromDocType` is NULL on all 10,792 of them, so a check
that tests `FromDocType` uniformly reports a false failure here). Inside the
book the edge is exact: **0 of 11,139 live sales-order lines disagree with what
their purchase orders took**.

The 16 forward misses are dated 2026-06-08 to 2026-09-04, interleaved with edges
the ERP does hold (which run to 2026-09-07), so this is **not** a clean backlog —
the lane ran over that period and did not link these. UNKNOWN why; not
investigated here.

`purchase_order_items.so_item_id` is NULL on **396 of 1,532** purchase-order
lines. A NULL is not evidence of a missing link — a purchase order raised on its
own correctly has none — and only the book can say which of those NULLs should
have been one. That is what the forward column measures, and it says 16.

### 2. Sales order → delivery order — PROVEN, 2 open and one of them is LIVE

Forward **171 of 173**, backward **171 of 171**. Zero wrong products.

The two misses are `DO-001800 ← SO-002281` (2024-10-30) and
`DO-005583 ← SO-007435` (2025-07-28).

**`DO-001800` is not history.** The scheduled `DO->SO link orphan sentinel` run
[`34170202404`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34170202404)
(2026-09-08 07:29 local) failed with `4 orphan DO lines across 3 documents
[baseline 1]`, and two of the four it names are `HC-DO-001800 from HC-SO-002281`
(`HB109M-CC` qty 3, `HB109NL` qty 3) — the same document this matrix reads as a
missing edge, seen from the other side. The sentinel's own verdict is *"the
mechanism that blanks `so_item_id` is live"*. **Repairing the rows without
fixing that mechanism would re-orphan them**, so nothing was written here.
The third orphaned document is `2990-DO-2607-013`, which is company 2990 and
outside this tally.

### 3. Purchase order → goods receipt — PROVEN, 24 open, LIKELY a backlog

Forward **497 of 521**, backward **497 of 497**. Zero wrong products, zero
dangling, and `grn_items.purchase_order_item_id` is filled on all 715 rows.

**This edge had no forward or backward count until this run.** The checker
printed *"no document-grain book comparison possible"* and stopped, on the true
premise that `scm.grns.linked_ac_docno` holds the receipt's PURCHASE ORDER
number rather than the receipt's own. The edge is recorded elsewhere:
mig `0275_scm_po_ac_grn_refs.sql` stamps
`purchase_orders.linked_ac_grn_docnos` with the AutoCount receipts that brought
that order in, so a PO row carrying `linked_ac_docno = P` and
`linked_ac_grn_docnos = {G1,G2}` **is** the ERP asserting `G1 ← P` and `G2 ← P`
in AutoCount's own numbering. Trace: `docs/bugs/0682-*.md`.

All 24 misses fall in **2026-08-28 .. 2026-09-07** while the held edges span
2024-05-02 .. 2026-09-07. The missing set sitting entirely inside the last 11
days is consistent with the stamping lane not having run recently — **LIKELY a
backlog, not lost data**. What would settle it: re-run the stamp lane and
re-run this check; if the 24 close, it was a backlog.

**What this edge still cannot answer, and it is a limit of the account book, not
of the check.** `GRDTL.FromDocDtlKey` is populated on **0 of 21,746** receipt
lines, so AutoCount itself does not record which PO LINE a receipt line
received. The owner ruled 「跟 autocount 一样」 — leave it unset and flagged,
never invent one. **The CONTENTS of the migrated goods receipts are UNKNOWN
here**: the reshape is another agent's work, was still being audited for a money
difference at the time of writing, and `scm.grns` was deliberately not touched
or measured beyond the link columns.

### 4. Delivery order → sales invoice — PROVEN complete and symmetric

Forward **46 of 46**, backward **46 of 46**. `sales_invoice_items.do_item_id`
is filled on all 183 rows, none dangling.

**2 of the 183 name a different product from the delivery line they point at.**
Already filed as `docs/bugs/0676-two-sales-invoices-and-three-purchase-invoices-name-a-source.md`,
root cause UNKNOWN and deliberately not guessed. It costs money indirectly:
`do_item_id` is the `invoiced` term in `remaining = delivered − invoiced −
returned`, the ceiling every DO→SI write path is checked against, so a wrong
link makes one delivery line read over-invoiced and another billable twice.
Not repaired here — correcting a link moves a money ceiling, and the mechanism
that wrote them is still unidentified.

### 5. Goods receipt → purchase invoice — COMPOSED, 54 open

Forward **394 of 448**, backward **394 of 394**, both **composed**.

**Say plainly what composed means.** The direct edge cannot be compared: the
book names a GOODS RECEIPT as the invoice's parent and no ERP row carries an
AutoCount receipt number to match it against. What is compared is the same
relationship one hop wider — the book's `PI ← GR` composed with its `GR ← PO`
gives 11,543 (invoice, order) pairs, and `purchase_orders.linked_ac_pinv_docnos`
is the ERP's assertion of the same pair. **It proves the invoice hangs off the
right ORDER. It does not prove it hangs off the right RECEIPT**, and where a
purchase order was received in several deliveries nothing here can tell those
apart. Less than was asked for; more than "unknown".

The 54 misses are dated **2026-01-16 .. 2026-09-02**, interleaved throughout the
held range (2024-05-02 .. 2026-09-04). **Unlike the receipt edge, this is not a
backlog shape.** UNKNOWN cause.

**3 of 276 purchase-invoice lines name a different product** from the receipt
line they point at — the other half of `docs/bugs/0676`. This one moves stock
valuation: `recost.ts` aggregates purchase-invoice lines by `grn_item_id`, so a
wrong link books one receipt's cost onto another receipt's stock.

---

## Inside the book itself

The account book is not self-consistent either, and these are AutoCount's own
numbers — nothing in the ERP causes or can fix them.

| check | result |
|---|---|
| a child naming a parent that does not exist | **3** of 144,650 linked child lines: 2 on cancelled `PO-009968`, 1 on `I-2410-0184 → DO-002231` |
| a live child under a cancelled parent | **0** |
| SO → PO counter vs its purchase orders | **0** of 11,139 lines disagree — exact |
| GR → PI counter vs its purchase invoices | **0** of 5,350 documents disagree — exact |
| SO → DO/IV counter vs its children | 94 of 13,363 documents; 91 claim a transfer with **no child document at all**, 78 dated before 2026, **0 since 2026-08-01** |
| PO → GR counter | 19 of 9,412 documents, **0 since 2026-08-01** |
| DO → IV counter | 85 of 11,439 documents, **1 since 2026-08-01** |

The two counters matter separately and confusing them mis-states what is
outstanding: `SODTL.TransferedQty` counts deliveries and invoices,
`SODTL.TransferedPOQty` counts purchases. They are read as two here.

---

## Settled this run: the shared AutoCount line key

The standing verdict was *"296 SO and 98 PO keys are shared by 2+ rows; LIKELY
all sofa decomposition but UNPROVEN"*. It is now **PROVEN**, and the population
has grown since it was last counted:

| | shared keys | the sofa line itself | the upholstery line of a sofa document | on a document with no sofa |
|---|---|---|---|---|
| sales orders | 310 | 308 | 2 | **0** |
| purchase orders | 106 | 106 | 0 | **0** |

**None is a duplicate import.** One book line becomes one ERP row per
compartment, which is the intended representation.

`probe-link-identity.mjs` could not settle this and it is worth saying why: it
counts how many shared keys carry rows naming DIFFERENT products, and reported
295 of 296. A sofa decomposed into compartments produces exactly that — each
compartment has its own piece code — so that number is equally consistent with
both readings and settles nothing. What settles it is resolving the key to the
**book's** own `ItemCode`.

The last two needed the DOCUMENT rather than the line. A sofa order carries the
sofa and its upholstery on separate book lines (`SO-002302`: `RDS-R819 SOFA` at
seq 16, `THL-7179` at seq 32), the fabric code contains no "SOFA" for the
predicate to find, and the importer stamps the fabric line's key on each
compartment row for the same reason it stamps the sofa's. Reading those two as
invented quantity was the false alarm this check raised on its first run and no
longer does.

---

## What was NOT repaired, and why

Nothing was written. Each candidate fails at least one standing rule, and
shipping a repair anyway is how a hard-bound bedframe comes to read READY on
someone else's stock:

| candidate | why not |
|---|---|
| 16 SO→PO links, 2 SO→DO links | writing `so_item_id` moves READINESS — a hard-bound line reads READY off its own dedicated purchase order. This session was scoped to move neither stock nor readiness, and a direct SQL write triggers no recompute (`docs/bugs/0675`) |
| `DO-001800`'s orphaned lines | the mechanism that blanks `so_item_id` is LIVE (sentinel run `34170202404`). Repairing rows under a live mechanism re-orphans them; the root cause is the fix |
| 24 GR→PO, 54 PI→GR stamps | the goods-receipt reshape is another agent's lane and `scm.grns` was not to be touched. The GR set is LIKELY a backlog that a stamp re-run closes on its own |
| 2 + 3 wrong-product invoice links | root cause UNKNOWN (`docs/bugs/0676`) and correcting one moves a money ceiling or a stock valuation |

---

## Honest limits of this document

- **`PI ← GR` is composed, not direct.** Right order, not right receipt.
- **Goods receipt CONTENTS are UNKNOWN.** Only the link columns were read.
- **Line-grain presence is impossible on four of the six edges**, because
  `FromDocDtlKey` is 0 of 220,723 book lines. Those are answered at document
  grain and this document says so rather than letting a document-grain number
  read as a line-grain one.
- **The book snapshot is from 2026-09-07 16:39 local**, roughly 16 hours before
  the ERP read. Documents created in between appear as book-side absences on
  neither side and as ERP-side additions on neither; the check refuses outright
  if the snapshot passes 2 days old.
- **The 241 purchase-order price differences are not a difference.** Houzs
  prices a purchase when the goods arrive: 10,810 of 18,890 book PO lines carry
  no unit price at all and 7,591 of 9,416 purchase orders total RM 0.00.
  Copying the book over the ERP would destroy 241 real prices. Do not "fix" it.
