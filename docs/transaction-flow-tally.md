# Transaction flow tally — Company 1 (Houzs Century)

**Re-measured 2026-09-08 11:17 local (UTC+8)**, run
[`34182972797`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34182972797),
`Convert symmetry check (read-only)`, concluded `success`.

The book side is the committed AutoCount snapshot
`backend/scripts/data/ac-convert-edges.json.gz`, exported 2026-09-07 16:39 local
from `AED_HOUZS` live. The ERP side is production, read through
`secrets.DATABASE_URL`. SELECTs only — this document cost no write.

Reproduce the whole thing with one dispatch: Actions → **Convert symmetry check
(read-only)** → Run workflow. Section 7 of its output is the table below.

---

## The table

| relationship | forward: book → ERP | backward: ERP → book | open | what they are |
|---|---|---|---|---|
| **Sales order → purchase order** | **507 / 522** | **507 / 507** | 15 | every one carries a book LINE key; the block is per line and named below |
| **Sales order → delivery order** | **171 / 173** | **171 / 171** | 2 | **the account book's own gap** — the item is not on the order in AutoCount either |
| **Purchase order → goods receipt** | **521 / 521** | **521 / 521** | **0** | closed 2026-09-08 11:15 local |
| **Delivery order → sales invoice** | **46 / 46** | **46 / 46** | **0** | |
| **Goods receipt → purchase invoice** | **448 / 448** COMPOSED | **448 / 448** COMPOSED | **0** | closed 2026-09-08 11:15 local |
| *(sixth edge)* invoice raised straight off the order | 0 / 0 | 0 / 0 | — | the book records 142 of these; the ERP imported none of their documents |

**95 → 17.** The 2026-09-08 08:20 measurement read 96 book edges the ERP did not
hold; a re-measure at 10:52 (run
[`34181536566`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34181536566))
read 95 after another lane closed a `PO ← SO` edge. **78 of those were closed by
`stamp-ac-grn-refs.mjs`** once it sourced the whole book instead of the
outstanding cut — run
[`34182881026`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34182881026),
`DONE. POs stamped: 54 (+24 GR, +54 PI)`. The 17 that remain are accounted for
one at a time below, and **2 of them are the account book's own gap, which means
having them too IS being identical.**

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
  serious of the two directions and it is clean everywhere, before and after.
- **Wrong-product links are now 0 on every edge.** The 2 + 3 that stood at 08:20
  were closed by the invoice-link lane during the morning.

---

## What was CLOSED on 2026-09-08, and how

### `GR ← PO` 497/521 → **521/521**, and `PI ← GR` 394/448 → **448/448**

Both were one defect. `stamp-ac-grn-refs.mjs` read `ac-gr-refs.json.gz`, which
`export-ac-reimport.py:349` cuts with a `WHERE` clause naming only the purchase
orders being exported — the ones **outstanding on the day of that cut**. The ERP
keeps an imported purchase order forever; the cut does not keep its receipts. So
the moment AutoCount finishes receiving an order it leaves that population, and
its receipts and invoices become invisible to the job — permanently, however
often it runs. It HAD run, successfully, at 2026-09-07 23:51 local
(`34140454809`), and moved neither number.

Measured: that file carried **318** purchase orders, **214** receipt documents
and **186** purchase invoices. The ERP holds **574** imported purchase orders.

**The date shape that ruled a backlog out was reading the wrong date.** This
document previously recorded the 54 as *"NOT a backlog shape. UNKNOWN cause."*,
because they span 2026-01-16 .. 2026-09-02. Membership is not decided by the
invoice's date but by whether its **purchase order** was still outstanding on
2026-08-28; when an order leaves that population its whole invoice history
leaves with it, whatever the dates on it.

The source is now `ac-convert-edges.json.gz` — the same live book, unfiltered —
composed through the receipt exactly the way this checker composes it, so what
the stamp writes is what the check reads. Writes are a UNION, and the run
reported **`held by the ERP but NOT recorded in the book: 0`**. Full trace:
`docs/bugs/0689-the-goods-receipt-and-purchase-invoice-pointers-were-stamped.md`.

**No stock, no readiness, no money moved.** `linked_ac_grn_docnos` and
`linked_ac_pinv_docnos` appear in `backend/src` only inside comments — there is
no read on the Worker request path. The readiness census either side of the
write (`Go-live readiness (read-only)`, runs
[`34182646977`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34182646977)
at 11:11 and
[`34182980374`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34182980374)
at 11:17) went `READY=1724 PENDING=1369 PARTIAL=10` →
`READY=1725 PENDING=1368 PARTIAL=10`. **That one line is LIKELY not ours** —
two other lanes wrote inside the same six minutes (`Enqueue SO allocation
recompute` `34182606676`, `Repair PO line description + delivery date from the
book` `34182769882`) — and it is mechanically impossible from these two columns.
Said as LIKELY rather than asserted in either direction.

**Handed to the goods-receipt lane, not decided here.**
`create-migrated-documents.mjs` (KIND=grn) decides what receipts to create from
`linked_ac_grn_docnos`, and that list is now 24 receipts longer. That job was
NOT run. Whoever owns it is now deciding with a number rather than a surprise.

---

## The two that are the BOOK's own gap — `DO ← SO`

`HC-DO-001800` and `HC-DO-005583` are not links the ERP lost. They were never
linkable, because the item is not on the sales order **in AutoCount either**:

```text
SO-002281  2024-08-10  cancelled=F
   seq  16 | AK-ARMOUR MATT (Q)        qty 1 | transfered 0
   seq  32 | AK- LTX CLS PIL           qty 3 | transfered 3
   seq  48 | NTYR-CS LTX PIL + CSC     qty 3 | transfered 3
   seq  64 | AK-SK + MICROFIL PIL      qty 1 | transfered 0

DO-001800  2024-10-30  cancelled=F
   seq  32 | HB109NL                   qty 3 | from SO SO-002281
   seq  48 | HB109M-CC                 qty 3 | from SO SO-002281
```

Neither item is on the order; AutoCount recorded the delivery anyway and
consumed other lines' quantity for it. `DO-005583` is the same shape one step
subtler — `SO-007435` seq 144 is `AK-SK + MICROFIL PIL` x2 with
`TransferedQty 2`, and the delivery note's seq 144 is `AK-SK FX AIRLOFT PIL` x2:
same sequence, same quantity, a different product name.

`repair-do-so-item-links.mjs`, which never sees the book, reaches the same
verdict from the ERP side alone and refuses all three lines with
`no_so_line_with_that_item_code` (run
[`34182380708`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34182380708)).
Both sides agree. Writing the link would INVENT a relationship AutoCount does
not record, against the owner's standing 「跟 autocount 一样」. **This is the
acceptable non-zero: the gap is in the book, so carrying it too IS being
identical.** Ledger:
`docs/bugs/0691-the-two-orphaned-delivery-lines-are-the-account-book-s-own-g.md`.

The standing reading — *"the mechanism that blanks `so_item_id` is LIVE, so
repairing would re-orphan them"* — is retired for these three. They are not a
delete's doing, so they are not evidence for that mechanism either way. The
sentinel keeps watching for a fifth, on a baseline of 4 with all four named
beside their answers.

---

## The 15 that remain — `PO ← SO`, and whose lane they are

**Every one of the 15 carries a book LINE key** (`PODTL.FromSODtlKey` resolving
to the named sales order), checked against `ac-convert-edges.json.gz`: 15 of 15
keyed, 0 named by document number only. So none of them is "the book records no
source" — the book does record it, and the block is on the ERP side.

`probe-po-so-link-recoverable.mjs` (run
[`34182101293`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34182101293),
2026-09-08 11:02 local) classifies the whole 371-line unlinked population and
refuses to guess:

| why the line is not linked | lines |
|---|---|
| the BOOK records no source order — a link would be INVENTED | 329 |
| the source order was not imported (outside the cutover) | 17 |
| **the two ends name DIFFERENT products** — bug class 0672, refused | **10** |
| the purchase-order key is not unique (sofa decomposition) | 6 |
| no AutoCount line key on the ERP row (an ERP-native line) | 6 |
| **RECOVERABLE — all four gates passed** | **3** |

**The 10 item disagreements are the item-code lane's work, not a link defect.**
In all 10 the BOOK's own two ends AGREE — AutoCount converted a product into
itself — so **an `item_code` was rewritten on import and the LINK is right**.
Five of the 15 missing document edges sit on those documents (`PO-010097`,
`PO-010098`, `PO-010101`, `PO-010154`, `PO-010156`). They close when the item
codes are corrected, and not before: writing the link first is exactly what put
a customer's REGAL on a TRION on 2026-09-07.

The 3 recoverable lines restore `PO-010150 ← SO-011160`, which is **not** one of
the 15 — that document edge is already held through another line.

**Not repaired here on purpose.** `purchase_order_items.so_item_id` moves
READINESS (a hard-bound bedframe or sofa reads READY off its own dedicated
purchase order), the SO/PO line repair belongs to another lane, and a direct SQL
write triggers no recompute (`docs/bugs/0675`).

---

## The 08:20 reading, kept as history — SUPERSEDED above

The detail below was written against the **2026-09-08 08:20** measurement and is
kept because its reasoning is the record of what was believed and why. **Four of
its five section headings are now wrong** and the sections above replace them:

| section below | its 08:20 verdict | true at 11:17 |
|---|---|---|
| 1. Sales order to purchase order | 16 open | **15** open, each attributed above |
| 2. Sales order to delivery order | 2 open and one of them is LIVE | **2 open, and they are the BOOK own gap** — not a live mechanism |
| 3. Purchase order to goods receipt | 24 open, LIKELY a backlog | **0 open.** It was not a backlog; the stamp source could not see them |
| 4. Delivery order to sales invoice | complete and symmetric, 2 wrong item | **still complete; the 2 wrong-item links are now 0** |
| 5. Goods receipt to purchase invoice | 54 open, NOT a backlog shape, UNKNOWN cause | **0 open.** The cause was the same stamp source; the date shape was the wrong signal |

Read it for the reasoning, never for the numbers.

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

## What was repaired, and what was NOT

**78 of the 95 were repaired**, in one change, and re-measured after: run
[`34182881026`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34182881026)
wrote them and run
[`34182972797`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34182972797)
read both edges at N of N.

| candidate | outcome |
|---|---|
| 24 GR to PO, 54 PI to GR stamps | **CLOSED.** The stamp source was the outstanding cut and could never see them; it now reads the whole book. `docs/bugs/0689-*.md` |
| `DO-001800` and `DO-005583` orphaned lines | **NOT a defect.** The item is not on the sales order in AutoCount either, so a link would be invented. The answer is written into the sentinel baseline. `docs/bugs/0691-*.md` |
| 15 SO to PO links | **Another lane.** 5 of them are blocked behind an ERP-side `item_code` that disagrees with the book while the book own two ends agree; `so_item_id` also moves READINESS and a direct write triggers no recompute (`docs/bugs/0675`) |
| 2 + 3 wrong-product invoice links | **CLOSED by the invoice-link lane** during the morning of 2026-09-08. The checker now reads 0 wrong-item links on every edge |

**The migrated goods receipt DOCUMENTS are a separate question and were not
touched.** `create-migrated-documents.mjs` (KIND=grn) builds receipts from
`linked_ac_grn_docnos`, which is now 24 receipts longer. Creating them is the
goods-receipt lane call.

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
