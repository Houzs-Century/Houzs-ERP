## A sofa the warehouse already holds cannot be delivered because its purchase line never split into compartments [high]

<!-- area: Sofa, fabric, variants -->
<!-- status: open -->

**Symptom.** Delivery orders were opened to staff at 17:41 on 2026-09-08. Within
the hour the owner sent a screenshot of `HC-SO-012565` refusing to convert, with
the comment 「barang sudah ready」 — the goods are physically in the warehouse:

> No single production batch on hand can fulfil this whole sofa set, so it can't
> ship without splitting a dye lot or leaving an orphan. Wait until one complete
> batch is received. Affected: 8030-2A(LHF), 8030-1A(RHF). **8030-2A(LHF),
> 8030-1A(RHF) have no live supplier PO linked**, so there is no incoming batch
> to ship against.

**The account book holds the whole chain**, re-derived from the committed
snapshot `backend/scripts/data/ac-reconcile-truth.json.gz` (exported
2026-09-08T00:03:44Z), not quoted from a brief:

```
SO-012565  dtl 856506  HOK-5540 SOFA    qty 1  RM 3990.00  transfered 0
PO-009435  dtl 859095  HOK-5540 SOFA    qty 1  FromSODtlKey 856506  transfered 1 of 1
GR-005256  dtl 906536  HOK-5540 SOFA    qty 1  from PO-009435
```

Neither header is cancelled. `HOK-5540` aliases to model `8030`
(`SOFA_MODEL_ALIAS`), which is why the screen names `8030-…` pieces.

**Root cause (traced).** Not a missing purchase order and not a missing key —
**a stale decode on the purchase side only.**

`isHardBoundLine` (`backend/src/scm/lib/so-stock-allocation.ts:78`): a company-1
bedframe / sofa / (SP) mattress sales line reads READY only through its OWN
dedicated purchase-order line, never through the pooled walk. The dedication is
`scm.purchase_order_items.so_item_id`, and it is per COMPARTMENT — one purchase
row can name exactly one sales row.

The ERP holds `HC-PO-009435` as **one row coded `8030-1S`**, while
`HC-SO-012565` holds **two rows**, `8030-2A(LHF)` and `8030-1A(RHF)`. So
`repair-po-so-link-sofa-compartments.mjs` refuses the pair at its gate 4 — the
two sides carry different products — and it is right to: that tool may not
invent a compartment. Probe run
[`34215752748`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34215752748),
section C, prints the refusal verbatim:

```
HC-PO-009435 <- SO-012565: the purchase side carries 8030-1S and the sales side
carries 8030-1A(RHF), 8030-2A(LHF) - a BUILD disagreement, not a link one
```

**It is not a build disagreement.** The book's own Desc2 for that purchase line
(`ac-fidelity-po-lines.json.gz`, DtlKey 859095) is

```
(3S)26inch/Col:BO315-31
*Fully Cover to Floor
*Bottom wrap Nylon Fabric
```

and today's decoder — `backend/scripts/lib/parse-sofa.mjs`, the one the importer
uses — reads it as `2A(LHF)+1A(RHF)`, conf `high`, note
`3S→2A+1A(owner 定规:座深≠24" 必拆)`. Run locally against the committed text:

```
model 8030  pieces ["2A(LHF)","1A(RHF)"]  conf high  size 26  color BO315-31
```

That is the sales side, piece for piece. The purchase row was written before the
decoder could read that text; nothing about the sofa changed.

**Why no existing tool reaches it.** `redecode-collapsed-sofa-lines.mjs` selects
on `isPlaceholderLine` (`lib/redecode-sofa-plan.mjs:63`) — `SOFA UNPARSED` in the
remark **AND** a bare `1S` compartment. These rows carry the `1S` and **not** the
marker, so the whole class is invisible to it: its production plan run
[`34216040071`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34216040071)
found 4 purchase-order placeholders in the entire company and 0 builds to write.
Widening that predicate is not the answer either — a `-1S` without the marker can
be a genuine one-seater, and a blanket re-decode would rewrite hundreds of live
builds.

**The class, measured.** Probe run `34215752748`, company 1: **26 hard-bound
sales lines on 14 sales orders** carry no dedicated purchase line while the book
records one, all 26 not READY. Fourteen of the fifteen refused compartment pairs
in section C are this exact shape — a `{model}-1S` purchase row against a
decomposed sales side. The fifteenth, `HC-PO-010085 <- SO-010287`, is the same
sofa MIRRORED and stays the owner's.

The transfer-counter check
([`34216340414`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34216340414))
sees the same documents from the other end: `SO -> PO` reads **42 line groups
ERP LOW**, `SO-012565` among them — `8030-1A(RHF) book 1 of 1 | ERP 0 of 2 over
2 row(s) [key 856506]`. That counter is a symptom of the same missing link, not
a second defect.

**Fix.** `backend/scripts/repair-collapsed-sofa-po-line.mjs` +
`.github/workflows/repair-collapsed-sofa-po-line.yml`. It gives the collapsed
purchase row the compartments the book's own text states and dedicates each one
to the sales compartment of the same product. The write is a copy witnessed
three ways and refuses unless all three agree:

1. the book names the edge (`PODTL.FromSODtlKey`);
2. the book's PURCHASE text decodes, today, with conf above `low`, into pieces
   whose SKUs are all minted;
3. the ERP's SALES rows — decoded separately, at import, from the book's SALES
   text — hold exactly that MULTISET, every code unique.

Anything else is refused and counted: a mirrored build, a shorter or longer
decode, a repeated compartment, a purchase row that already names a sales line, a
sales compartment already dedicated, or any goods receipt / delivery line
downstream. It never relaxes the sofa batch guard — an order that still refuses
after the link is right is that guard working, and is the owner's call.

Nothing is deleted (owner: 不可以删只可以 cancel): the existing row is re-coded
as the first piece and the rest are INSERTED beside it, so the row id survives.
The money does not move — `buildCloneInsert`'s `zeroSen` puts every `_sen`
column of an inserted piece at 0, the re-coded row's money columns are not
written at all, and the purchase order's total is asserted before and after
inside the same transaction. No payment column is named. No outbox row is
written and no AutoCount call is made (owner 2026-09-08:
「写回autocount的你不需要理了」).

`MODE=plan` is the default and writes nothing; `MODE=apply` needs
`CONFIRM="I HAVE REVIEWED THE DRY-RUN"`. The apply re-reads on a FRESH
connection and asserts the SHAPE — the piece multiset, that every `variants`
block is a jsonb OBJECT, that each purchase row names a sales row of the SAME
product, that no sales row is named twice, and that no purchase total moved —
never a row count.

**A LINK DOES NOT RECOMPUTE READINESS** (`docs/bugs/0675`): the projection is a
separate, serialised operation. Dispatch *Recompute SO stock allocation* after
the apply, then *Recompute SO po_qty_picked* for the SO -> PO counter the same
missing links left reading LOW.

**Ref.** `fix/do-blocked-by-po-link`, 2026-09-08. **The remedy is SHIPPED but NOT
YET APPLIED to production at the time this entry was written** — the workflow has
to reach `main` before it can be dispatched. The apply run, the before/after and
the control belong to the follow-up entry.

Module guide: `docs/modules/purchase-order.md`, *A sofa's purchase line and its
sales compartments*.
