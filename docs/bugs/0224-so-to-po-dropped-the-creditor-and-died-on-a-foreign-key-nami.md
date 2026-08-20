## `/so-to-po` dropped the creditor, and died on a foreign key naming the payment term [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** `POST /so-to-po` answered 500 with no body. `qa-convert.ps1`
reported it as `status=0 ... (500)` for days because it never read the response
stream, so the failure had a symptom and no cause.

**Root cause, traced.** The service's own log had it the whole time
(`C:\Temp\ac-sync-service.log`, written by the catch-all in `Serve()`):

```
2026-08-15 23:07:33 ERROR /so-to-po: AutoCount.Data.ForeignKeyException:
  Foreign Key Error (Constraint Name=FK_PO_DisplayTerm)
```

`SoToPo()` called `AddSOToPOTransferDetail` for each line and then
`PurchaseHeader()`, which writes `DocDate` / `DocNo` / `Ref` / `Description` /
UDF and **not the creditor**. AutoCount defaults a purchase order's
`DisplayTerm` — its payment term — **from the supplier**, so a PO reaching
`Save()` with no creditor has no term, and the insert dies on the TERM's foreign
key rather than on anything mentioning a supplier.

That is why `/create-po` passed on the same night while `/so-to-po` did not:
`CreatePo()` assigns `CreditorCode` directly. **The payload had always carried a
creditor. This route simply never read it.**

**Third of a kind.** `FK_SODTL_Location` (the line's warehouse),
`FK_SO_SalesLocation` (the header's sales location), now `FK_PO_DisplayTerm`.
Each is a lookup AutoCount defaults from something the payload failed to set,
and each names a DIFFERENT field than the one actually missing.

**Fix.** `SoToPo` sets `CreditorCode` (refusing when absent, naming the trap in
the message) and `CreditorName`. `DisplayTerm` also becomes a `ContainsKey`
passthrough on both header helpers, because a blank term is a foreign key error
rather than an empty field.

**Ref:** this PR, 2026-08-15.
