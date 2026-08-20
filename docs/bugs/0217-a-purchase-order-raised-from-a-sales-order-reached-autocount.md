## A purchase order raised from a sales order reached AutoCount with no link to it [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The owner, describing the flow he expects: *"当 Sales Order 转换成
PO 时，AutoCount 那边也要跟着同步把 PO 开进去。通常流程是先开 PO，然后做
Connection（关联），即 Transfer From 之类的单据流转."* The PO did arrive — but as
a standalone document. `git grep -c so_to_po` was **0**: there was no such
operation, no such route, and nothing named the sales order it came from.

**Root cause.** The four conversions all use one SDK primitive,
`AddPartialTransferDetail(fromType, keys, transferMaster)`, and `Convert_`
serves all four. SO-to-PO is not one of them: a PURCHASE document transferring
from a SALES one has its own method, `AddSOToPOTransferDetail(Int64)`, one key
at a time (`sdk-api-reference.txt`, the PurchaseOrder METH list). Nobody had
written it, so `convertSosToPosCore` fell through to `enqueuePoCreate` and the
book got a new PO with no provenance.

**Why it is not simply a transfer, which is the part worth keeping.** Measured
against the owner's own 2026-08-01 decision, recorded in mig 0235: **one PO line
can serve several customers plus stock at once** — the live example is one qty-5
MAKOTO line covering SO-036 x1 + SO-029 x1 and 3 for stock. A transfer builds
the purchase order FROM sales lines, so it would either split a line the
business deliberately consolidated or drop the stock quantity, which belongs to
no sales order at all. It also brings the SALES price across, and a purchase
order owes the supplier's cost.

**Fix — both shapes, decided per document.** `scm/shared/po-transfer-shape.ts`
transfers only when it is certain and falls back on any doubt, because a create
is what happens today and cannot be wrong:

| falls back when | why |
|---|---|
| any line has allocation rows | consolidated; mig 0235's case |
| any line is for stock (`so_item_id` null) | nothing to transfer it from |
| any source line has no `linked_ac_dtlkey` | a transfer is addressed by that key and nothing else |
| two lines name the same source line | a transfer would count the quantity twice |
| the lines come from more than one sales order | the drain has ONE parent anchor to wait on |

On the create path the source document numbers go into the PO's `Ref` —
deduplicated and sorted so the same order renders the same string every time.
That field was free: the ERP has no PO ref column and `readPoHeader` sent
`ref: null`, while `CreatePo` has always applied `po.Ref`.

On the transfer path the payload carries `DtlKeys` and per-line `UnitPrice` /
`Qty` / `Location` / `DeliveryDate`, applied AFTER the transfer so the ERP's
agreed cost replaces the sales price the transfer brought over. `fromDoc` makes
the drain hold the row as `waiting` — without burning an attempt — until the
sales order itself has an AutoCount number.

`DtlKeys` is REQUIRED on `/so-to-po`, unlike the four conversions, which may
omit it and fall through to "every still-outstanding line on the parent". That
default is safe when the two documents are the same document one step on; a
purchase order is not, and guessing would buy lines nobody ordered from this
supplier.

Mig 0295 widens the outbox `op` CHECK, which 0277 pinned. The contract test
gained a `/so-to-po` case, so the new route's keys are held against the C#
source like the rest.

**Ref.** 2026-08-15, PR #2251.
