## SO-to-PO now carries the quantity and the cost — a two-phase write, PROVEN on the live book [high]

<!-- area: AutoCount sync + write-back -->

**Fixed and verified 2026-08-16.** The purchase order raised from a sales order
was saving with a **NULL `Qty`**, which is fatal in a way that reads as nothing:
AutoCount's outstanding predicate is `Qty - ISNULL(TransferedQty, 0) > 0`, NULL
is never greater than zero, so the document looked correct in every list and
could never be converted onward.

**Root cause.** `AddSOToPOTransferDetail(Int64)` does not return a purchase
line. It returns an `AutoCount.Invoicing.Purchase.TransferSOToPODetail` — a
transfer INSTRUCTION with a different shape and no `Qty` at all. Assignments to
it went through `Set()`, which logs and swallows, so the type mismatch never
surfaced:

```
set skipped: 'AutoCount.Invoicing.Purchase.TransferSOToPODetail'
             does not contain a definition for 'Qty'
```

**Fix — two phases, and it does not depend on that unknown type.**

1. transfer the lines, set the header, `Save()`
2. reopen the saved PO, where the purchase lines finally exist with keys of
   their own, and apply the ERP's agreed cost and quantity through
   `EditDetail(newKey)`, then `Save()` again

Lines match by ORDER: `AddSOToPOTransferDetail` is called once per key in the
order of `DtlKeys`, and `CreatedLines` reads them back `ORDER BY DtlKey`, which
is creation order. The counts are **asserted equal**, not assumed — a mismatch
refuses rather than guessing which override belongs to which line.

`Qty` and `UnitPrice` are deliberately **not** wrapped in `Set()`. Swallowing is
precisely what let a NULL quantity reach the book.

**Proof, same script, before and after:**

```
before:  PO line 906199: Qty=   TransferedQty=0  Transferable=T
after:   PO line 906231: Qty=4  TransferedQty=0  Transferable=T
```

And the downstream error CHANGED, which is the second half of the proof:
`/po-to-gr` no longer answers `no transferable lines on PO` — our own guard
reading AutoCount's outstanding predicate — but the unrelated
`IndexOutOfRangeException` it has always had. The purchase order is now healthy;
what remains is `po-to-gr`'s own defect, already recorded.

**Still open on this route:** `FromDocType` comes back EMPTY on the PO's lines
while `FromDocNo` is set, so AutoCount's *convert from* has half a link. That is
the API's doing — `AddSOToPOTransferDetail` takes no source-type argument, where
the four ordinary conversions are handed one — and is not addressed here.

**Ref:** this PR, 2026-08-16.
