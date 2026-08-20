## A delivery of 2 out of 5 booked 5 in the account book, and answered ok [high]

**Symptom.** Nothing visible. A delivery order that ships part of a sales-order
line — 2 of a 5-unit line — produced an AutoCount delivery order of **5** on that
line. The outbox row read `sent`, the service logged success, and the ERP and the
account book disagreed about how much stock had moved. The only way to notice was
to compare the two documents by hand.

**Root cause (read on both sides).** `enqueueConvert` composed
`{ DocNo, DocDate?, Ref?, DtlKeys? }` and `readConvertSourceKeys` resolved line
IDENTITY only — its own comment said so, and called partial quantity "NOT
COVERED, and deliberately so", on the grounds that `AddPartialTransferDetail`
takes line keys and not quantities. That was true of the primitive and stopped
being true of the SERVICE: `PlanTransfer` reads `Details:[{ DtlKey, Qty }]` and
`RunTransfer` uses the documented `PartialTransfer` overloads for it, **refusing**
rather than falling back — because the fallback moves each named line's whole
outstanding quantity. The C# half had been waiting for a payload the ERP never
composed.

**Fix.** `readConvertSourceKeys` sums what this document took of each source line
(summed, because a sofa build's compartments are several target lines against one
source row), compares it to the source line's own quantity, and returns
`details: [{ DtlKey, Qty }]` when any line is taken in part. `enqueueConvert`
sends it as `Details`. `AcDownstreamSpec` gained `itemQtyCol` / `sourceQtyCol`
because the four chains disagree — a GRN line's quantity is `qty_accepted`, what
entered stock, and everything else is `qty`. Both are REQUIRED fields, and the
compiler duly caught the one spec that was missed.

**Only when it really is partial.** A quantity commits the whole document to the
documented overloads, which the service refuses to fall back from, while the plain
`DtlKeys` shape is the one proven against this book on every conversion type.
Measured on the live book (`ac-fidelity-so-lines.json.gz`, 2026-08-11): **10 of
60,939** sales-order lines were ever partly transferred; 6 of 10,351 moved sales
orders carried one. Sending quantities on every conversion would put all six
document types onto an unproven call path to fix a 0.02% case.

All-or-nothing per document, because `PlanTransfer` throws on a key named with no
`Qty` while another carries one. Where a quantity cannot be read, nothing is sent
and the old shape applies.

**Tests.** Three in `autocount-convert-lines.test.ts`: 2-of-5 carries
`Details:[{DtlKey,Qty:2}]`; a whole-line shipment carries **no** `Details`; one
partial line makes every named line carry a quantity. The first and third were
proven red against `if (false && partialQty …)` — the pre-fix behaviour of never
sending a quantity. The second stays green under that mutation on purpose: it
pins the behaviour that did NOT change.

**Ref.** 2026-08-18, `fix/ac-sync-close-gaps`. Service half: #2259.
