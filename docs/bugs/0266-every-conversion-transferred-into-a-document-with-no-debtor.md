## Every conversion transferred into a document with no debtor, and the SDK's three transfer events reported to nobody [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** `HC-DO-2608-001` and `HC-DO-2608-002` have never entered the account
book; `HC-SI-2608-001` is blocked behind them. Every attempt answers

```
AutoCount.Invoicing.InvalidTransferItemException: Invalid transfer item.
```

thrown inside `GeneralSalesPartialTransferDetail..ctor` — eleven words naming no
key, no document and no reason. Eleven production attempts produced no new fact
between them.

**What was RULED OUT** (against the live book, 2026-08-16 — do not re-chase
these): the line data (all four DtlKeys exist on the named sales order,
`Cancelled=F`, `TransferedQty=0`, `Transferable=T`, `Location=PG` populated, UOM
matching the item master); a blank `SalesExemptionExpiryDate` (347 sales orders
with it blank have transferred); `transferMaster=false` (DO-011260 and DO-011262
were both created with it); a NULL `TransferedPOQty` (36,301 of 46,597
successfully-transferred lines have it NULL); the sales agent `WEIPIN` (61 orders
using it have transferred); and the location `PG` (13,835 lines in it have
transferred). A brand-new minimal order created through `/create-so`
(`ZZDIAG-SO-2`, keys 906383/906384, no UDFs, no addresses, never edited) also
fails, so it is not the content and not the editing.

**Root cause — UNKNOWN, and stated as unknown.** What IS established is that the
call did not match the API the vendor documents, on four counts, and each is
fixed here:

1. **The order was inverted.** `Convert_` ran
   `cmd.AddNew()` -> transfer -> `SalesHeader(doc, p)` -> `Save()`. Neither
   `SalesHeader` nor `PurchaseHeader` sets a debtor or a creditor, so every
   conversion ran its transfer against a target with NO ACCOUNT; the only reason
   a GRN had a supplier at all was `transferMaster:true` copying one out of the
   source inside the SDK. All three vendor pages
   (`Programmer:Goods_Received_Note_Transfer_from_Purchase_Order`,
   `Programmer:Sales_Invoice`, `Programmer:Delivery_Order`) set the account and
   the document date on the target BEFORE calling the transfer.
   **A contradiction, left standing rather than bridged:** DO-011260 was written
   on 2026-08-12 through the OLD order and it worked, so "the target has no
   debtor" cannot on its own be the whole of it. What changed between that
   document and `HC-DO-2608-001` is that the ERP started naming `DtlKeys`.
2. **The documented transfer API was believed not to exist** — see the BUG CLASS
   entry directly above.
3. **Three events the SDK raises during a transfer were subscribed by nothing.**
   `OnSalesDocumentTransferConflict`, `ConfirmOverTransferedQtyEvent` and
   `ShowEditTransferDetailFormEvent`. The header argued the over-transfer one
   *"cannot be subscribed"* because its `EventArgs` type is not public. It can:
   .NET's relaxed delegate binding matches a handler declared with `object`
   parameters to a delegate whose parameters are any reference types, so
   `Delegate.CreateDelegate` binds one without ever naming the args type. An
   unhandled conflict is a live candidate for the exception above.
4. **No pre-flight.** `IsTransferFromSupported()` was never called, and neither
   was `TransferHelper.CheckAndGetValidPartialTransferItem(fromDocType, keys,
   dbSetting)` — the vendor's own validator, and the most likely origin of the
   throw. A `false` from the first and a rejected key from the second are
   completely different failures and were indistinguishable inside those eleven
   words.

**Fix.** `backend/scripts/autocount-service/AcSyncService.cs`:

- The vendor's ORDER: `PlanTransfer` -> `AddNew` -> `SetMaster` (debtor/creditor
  read off the SOURCE header in the book, plus the document date) -> preflights
  and event subscriptions -> transfer -> the rest of the header -> `Save`.
- `LogTransferApi` prints every transfer overload the host's assemblies expose,
  with parameter names, once per document class per service start.
- `PreflightTransferFromSupported` says plainly in the log when the class refuses
  transfers at all; `PreflightValidItems` calls the vendor validator BEFORE a
  document exists, so its throw arrives with the keys still in hand and nothing
  written. `/so-to-po` gets the SO-specific twin,
  `CheckAndGetValidSOTransferItem`.
- The three events are subscribed and **logged only** — nothing answers a
  confirmation. Answering "yes" to an over-transfer prompt would silently accept
  shipping more than was ordered. A delegate that RETURNS a value is deliberately
  not subscribed; its signature is logged instead.
- `FullTransfer` / `PartialTransfer` are invoked LATE-BOUND, argument by argument
  against the parameter's own NAME and TYPE in the assembly metadata, and an
  overload with one parameter the service cannot name is not called at all. This
  file compiles nowhere but the office host: writing `TransferFrom.SalesOrder`
  and being wrong costs a failed build, and writing `PartialTransfer`'s decimals
  in the wrong order and being wrong costs a live account book holding a quantity
  nobody sent. The `TransferFrom` value is not guessed either — the SDK's own
  `TransferHelper.DocumentTypeToTransferFrom` converts the doc-type strings the
  service already holds.
- `AddPartialTransferDetail` remains, as the fallback everywhere and as the
  chosen call for a by-line partial (PR #2302's pattern). Worst case is
  yesterday's behaviour, and the fallback says in the log why it happened.

**Both transfer shapes, and the ERP decides which** (owner, 2026-08-16:
「你要确保它是可以 partially transfer 跟 fully transfer 的。跟着我们的 ERP 就对了」).
The decision lives in ONE method, `PlanTransfer`, and reads only what the payload
SAYS — never what the numbers happen to add up to:

| the payload | the shape | the call |
|---|---|---|
| no `DtlKeys` | FULL — the whole source document, every line, full quantity | `FullTransfer(String[], TransferFrom, FullTransferOption)`, which takes an ARRAY of document numbers, so several sources into one target is native |
| `DtlKeys` | PARTIAL BY LINE — the ERP named the lines it took, and it stays partial even when that set is everything outstanding | `AddPartialTransferDetail`, per source document — the documented call for "these lines, at whatever is outstanding", and the only one whose arguments the ERP sends |
| `Details[].Qty` | PARTIAL BY QUANTITY — "3 of 5" | `PartialTransfer`, once per line; **refused, never approximated,** if its arguments cannot be bound by name |

**The half the ERP cannot express yet, said plainly rather than papered over.**
`enqueueConvert` composes `{ DocNo, DocDate?, Ref?, DtlKeys? }` and no per-line
quantity — `readConvertSourceKeys`'s own comment says *"NOT COVERED, and
deliberately so: partial QUANTITY on a line"*. Every documented `PartialTransfer`
overload takes a `Decimal`, so none can be filled from what the service is
actually told, and a DO shipping 3 of a 5-unit line still writes 5. Registered as
**D14** in `autocount-writeback.contract.test.ts`, which pins the count. The C#
half is done and refuses rather than shipping the 5; the ERP half is a payload
change plus a decision about which quantity is authoritative.

**NOT verified, and it cannot be from this machine.** There is no Windows host,
no licensed AutoCount assemblies and no C# compiler here, so this change is
UNCOMPILED and UNRUN. `deploy-on-host.ps1` compiles before it swaps and keeps the
previous exe, so a build error costs a round trip and not the service. The first
run on the host is a DISCOVERY run: the log will name the real parameter names of
every overload, the real `TransferFrom` value, and every member of
`FullTransferOption` — the facts that make a strongly-typed follow-up possible.

**Test.** `backend/src/services/autocount-writeback.contract.test.ts` parses the
C# and now asserts the three new payload keys (`FromDocNos`, `Details[].DtlKey`,
`Details[].Qty`), the new `DocDate` read, and D14. No test can exercise the SDK
calls: they need the licensed assemblies.

**Ref.** PR for `fix/autocount-documented-transfer-api`, 2026-08-17.
