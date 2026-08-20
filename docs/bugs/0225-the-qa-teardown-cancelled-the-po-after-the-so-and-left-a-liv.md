## The QA teardown cancelled the PO after the SO and left a live sales order [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** `qa-matrix.ps1` ended with
`FAIL 7 cancel SO ... status=500 ... CANCEL BY HAND`, leaving a real,
uncancelled sales order in the live book.

**Root cause.** The teardown order was `PI, GR, IV, DO, SO, PO` — the PO last.
A sales order transferred to a purchase order cannot be cancelled while that PO
is live, and AutoCount says exactly that:

```
SOTransferedToDocumentNotAllowToCancelException:
The Sales Order was transfered to Purchase Order, so it is not allow to cancel.
```

So "child before parent" was written into the list but not fully applied: the PO
is a child of the SO too, and it was ordered after it.

**Fix.** `PI, GR, IV, DO, PO, SO`, with the exception quoted at the site.

**The leftover was cleaned up rather than left:** the SO was cancelled once its
PO was gone, and the cancel was verified by reading the document back —
`Cancelled: "T"` — not by trusting the 200.

**Worth keeping:** this is the second time the cancel guard has proved to be
working after being suspected. It refuses by a NAMED exception in both
directions, SO->DO/IV and SO->PO.

**Ref:** this PR, 2026-08-15.
