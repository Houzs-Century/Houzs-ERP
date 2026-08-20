## `AddSOToPOTransferDetail` returns a TRANSFER INSTRUCTION, not a purchase line — so every override was dropped [high]

<!-- area: AutoCount sync + write-back -->

**Traced to the exact type, on the live book 2026-08-16.** Three wrong theories
died on the way, which is why the trace is written out rather than the
conclusion alone.

**Symptom.** `/so-to-po` creates a purchase order whose line has a **NULL
`Qty`**, so AutoCount's outstanding predicate
`Qty - ISNULL(TransferedQty, 0) > 0` is NULL and never true. The PO looks right
in every list and can never be converted: `/po-to-gr` answers
`no transferable lines on PO`, one step later, on a different document than the
one at fault. Read back the moment it was made:

```
PO line 906215: Qty=  TransferedQty=0  Transferable=T
                FromDocType=''  FromDocNo='ZZQA-SO-...'  FromDocDtlKey=
```

**Wrong theory 1 — "the payload is missing Qty".** It was, once. Adding it
changed nothing.

**Wrong theory 2 — "the override addresses the wrong line".** It did:
`po.EditDetail(dtlKey)` was called with the SOURCE (sales) key, the new purchase
lines have keys of their own, `EditDetail` returned null and `continue`
swallowed it. Fixed by keeping what the transfer returns. Still nothing changed.

**The actual cause, from the service's own log via `/last-errors`:**

```
set skipped: 'AutoCount.Invoicing.Purchase.TransferSOToPODetail'
             does not contain a definition for 'Qty'
```

`AddSOToPOTransferDetail(Int64)` does **not** return a `PurchaseOrderDetail`. It
returns a `TransferSOToPODetail` — a transfer INSTRUCTION object with a
different shape, which has no `Qty` at all. Assigning to it went through
`Set()`, which logs and swallows, so the failure was invisible at the call site
and the document saved looking fine.

**`TransferSOToPODetail` is not in `sdk-api-reference.txt`.** That dump covers
the six document classes only, so this type's real property names are UNKNOWN
and are not being guessed at here.

**Next step, and it is a measurement, not a fix:** reflect over
`TransferSOToPODetail` on the host — `GetType().GetProperties()` — and record
the names. The quantity is either on that object under another name, or the
resulting line has to be edited AFTER `Save()`, when the purchase lines finally
have keys `EditDetail` can address (a deliberate two-phase write, not a patch).

**Standing consequence.** `SO->PO` produces an unusable purchase order, so
`PO->GR` and `GR->PI` remain unproven end to end. `SO->DO` and `DO->IV` are
proven, both carrying `FromDocType` + `FromDocNo` on every line.

**The lesson worth keeping:** `Set()` swallowing a property assignment turned a
type mismatch into a silently wrong document. Three rounds of live writes were
spent before the log was read. Fields whose absence makes a document UNUSABLE
should not go through `Set()`.

**Ref:** this PR, 2026-08-16.
