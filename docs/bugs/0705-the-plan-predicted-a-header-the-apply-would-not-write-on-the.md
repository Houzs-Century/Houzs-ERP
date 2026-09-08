## The plan predicted a header the apply would not write, on the one document whose header already disagreed with its lines [high]

**Symptom.** The first production plan of `topup-ac-lines-from-truth.mjs`
(run `34201640955`, 2026-09-08 16:00 +08, PLAN, nothing written) printed for
`HC-SO-012842`:

```
header now RM 4888.00  +RM 300.00  ->  RM 5188.00   the book says RM 4888.00  <-- STILL DIFFERS
PAID RM 4588.00 + header balance RM 300.00 = RM 4888.00 ... After: does NOT equal the total
```

Both sentences are wrong about what the apply would do. The apply re-sums the
header from the LINES, and this document's lines sum to RM 4,588.00 while its
header reads RM 4,888.00 — a pre-existing self-inconsistency named in
`docs/cutover-so-do-remainder-2026-09-08.md` section A. Adding the book's
RM 300.00 line makes the lines sum RM 4,888.00, so the apply leaves the header
exactly where it is, matching the book, and paid + balance still adds up.

Nothing was written: this was caught on the plan, which is what the plan is for.

**Root cause (traced).** `planSo` computed the predicted header as
`t.erpHdr + t.add` — what the document SAYS plus what is being added — while
`applySo` computes `SUM(total_sen) OVER the document's lines`. Two different
expressions for one number, and they agree on every document whose header
already equals its own lines, which is why the defect was invisible on the other
eight. It is the trap CLAUDE.md names as *"the check that answers a different
question"*: the plan was right about a quantity nobody was going to write.

**Fix.** `planSo`'s query now reads each document's own
`SUM(total_sen)` beside the header, the predicted total is `lines_sum + add` —
the same expression the apply evaluates — and a document whose header does not
equal its lines is printed as `PRE-EXISTING: the header reads X while its own
lines sum to Y`, with the note that the re-sum CORRECTS it, because the header is
defined as the sum of its lines. The payment-consistency sentence is computed
from the same corrected figure.

Not pinned by a unit test: the expression is one SQL sum against a live
document's rows, and a test that mocked those rows would be asserting the mock.
It is pinned by the plan itself. Corrected plan run `34204160822`, 16:07 +08:

```
PRE-EXISTING: the header reads RM 4888.00 while its own lines sum to RM 4588.00 — a
difference of RM 300.00 that was there before this script. The re-sum below CORRECTS it,
because the header is DEFINED as the sum of its lines.
lines sum RM 4588.00  +RM 300.00  ->  header becomes RM 4888.00 (was RM 4888.00)
the book says RM 4888.00  = MATCHES THE BOOK
```

And the apply agreed with it: run `34204421089` read back
`HC-SO-012842  7 line(s), total RM 4888.00 (book RM 4888.00 = same)   paid RM 4588.00 +
balance RM 300.00 = RM 4888.00 = the total`.

**A second thing the same run refuted, recorded because a doc was written from
the stale reading.** The DO lane was built on
*"`delivery_order_items.linked_ac_dtlkey` is null on all 173 migrated delivery
orders"*, which is what reconcile run `34199308084` (15:26 +08) implied —
`DO-001604` appeared in its could-not-line-match list, a verdict only reachable
when no ERP row on the document carries a key. Thirty-four minutes later the
plan read the live rows: all three of that document's sofa compartments carry
DtlKey `199269`. `backfill-ac-downstream-line-keys.mjs` is filling the column
and the state moves between two dispatches. The lane now stamps the new row's
own key (`199273`) instead of leaving it NULL, prints how many rows of the
target document are keyed rather than asserting a corpus number, and
`docs/modules/delivery-order.md` carries the correction with both run ids.

**Ref.** fix/book-line-remainder, 2026-09-08.
