## Every SO to DO transfer used an undocumented AutoCount call, and every one was refused [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** Ten delivery orders sat NOT ACCEPTED on the AutoCount Sync page —
the goods had left the building and the account book had no delivery order for
them. Owner, 2026-09-08: 「为什么这些进不去autocount？」, then 「我们的SO 转去DO 为
什么不一样呢」.

Each had spent its whole attempt budget on eleven words that name nothing:

> `AutoCount.Invoicing.InvalidTransferItemException: Invalid transfer item.`

**This is the THIRD time this shape has been chased.** On 2026-08-16 the same
exception on HC-DO-2608-001/002 was written up in
`docs/autocount-sync-reasons.md` §4 and left with *"The real cause is UNKNOWN,
and it is deliberately not guessed at here."* That entry closes it.

### What was ruled out first, and how

Everything a reasonable person would suspect. Measured, not argued:

| suspicion | refuted by |
| --- | --- |
| a SERVICE (delivery fee) line AutoCount has no counterpart for | of the ten documents, ONE carries a service line at all, and that line has a book key |
| a source line with no AutoCount line key | `SOlineNoBookKey=0` on all ten, and `noBookKey=0` on all ten parent sales orders |
| a delivery order line naming no sales-order line | `noSOline=0` on all ten |
| two sales orders in one key array (the 2026-08-16 theory) | `sourceDocs=1` on all ten |
| the line already shipped, or the order cancelled | `TransferedQty=0`, `docCancelled=F`, `outstanding=1` on every key |
| the target carrying no customer | the host logged `target debtor before transfer = [300-C002]` |
| AutoCount refusing one of the keys | its OWN validator accepted every one — `valid-transfer-item check: 8 row(s) for 8 key(s)`, eleven times, never once short |

`backend/scripts/check-so-to-do-line-divergence.mjs` produced the first six
(run 34221496549, 2026-09-08); the last two came off `C:\Temp\ac-sync-service.log`
on the host, read over UltraViewer with the owner's consent.

**Root cause — the CALL, not the data.** With every explanation about the lines
dead, the one thing every failure shared was the call itself. From the host log,
verbatim:

```
18:50:58  /so-to-do  HC-DO-2609-012
18:50:58  SO->DO shape: PARTIAL BY LINE - the ERP named 8 source line(s) and no quantity
18:50:59  transfer: AddPartialTransferDetail per source document - ... FullTransfer ... is not used
18:50:59  SO->DO refused: AutoCount.Invoicing.InvalidTransferItemException: Invalid transfer item.
    at AutoCount.Invoicing.Sales.GeneralSalesPartialTransferDetail..ctor(...)
    at AutoCount.Invoicing.Sales.DeliveryOrder.DeliveryOrder.AddPartialTransferDetail(String, Int64[], Boolean)
```

`RunTransfer` RETURNED EARLY into `AddPartialTransferDetail` for any by-line plan
carrying no quantity, and every SO -> DO is that shape. **`AddPartialTransferDetail`
appears on no page of AutoCount's programmer wiki** — all 175 read 2026-09-08.
The documented calls are `FullTransfer` and `PartialTransfer`, and this host's own
assemblies expose both (`LogTransferApi` prints them at every service start):

```
SalesDocument.FullTransfer(String[] fromDocNos, TransferFrom, FullTransferOption)
SalesDocument.PartialTransfer(TransferFrom, String docNo, String itemCode, String uom,
                              Decimal qty, Decimal focQty, Int64 fromDocDtlKey)
```

The reason the service reached for the undocumented one was written in its own
comment: *"every PartialTransfer overload demands a quantity and the ERP sends
none"*. The first half is true. The second half was the mistake — **the ERP does
not send a quantity, but the BOOK knows it.** A by-line transfer means "these
lines, at whatever is still outstanding", and that number is on the source row.

**Fix.**

* `BindTransferArg` fills a `qty` parameter from the ERP's plan when it has one,
  and otherwise from the source line's own `Qty - TransferedQty`. The by-line
  shape is now expressible through the documented call, so `RunTransfer`'s early
  return is gone and `TryDocumentedTransfer` runs on every shape.
* **`focQty` binds to zero.** It contains `qty`, so the quantity rule answered it
  with the quantity being SHIPPED — a free-of-charge quantity equal to the sold
  one on every line, in a licensed account book. Latent until now because only a
  partial-quantity plan reached that overload (10 of 60,939 source lines ever).
  Found while reading the binder for this fix; it is the more dangerous of the
  two defects here.
* **The fallback can no longer double a document.** `PartialTransfer` is one call
  per line, so a throw on line 4 of 8 leaves three lines in the target;
  `AddPartialTransferDetail` on top of that would add them again. `Xfer` counts
  the calls that landed and `RunTransfer` refuses instead of falling back once
  any did. The old code guarded this only for a partial-QUANTITY plan.
* `AddPartialTransferDetail` is kept as the fallback for a shape the documented
  overloads cannot express. It is the call that put DO-011260 in the book.
* **AutoCount's own verdict now rides in the error the ERP stores** — it was
  written only to a log file on the shop-floor PC, so sixty attempts produced it
  and no one could read it. `docs/bugs/0717` is the panel that reads that log.

**Verified.**

* `build-local.ps1` — **`COMPILES CLEAN - 114688 bytes`**.
* `autocount-writeback.contract.test.ts` + `autocount-convert-payload.contract.test.ts`
  — 62 passed, 7 skipped. These read `AcSyncService.cs` itself.
* The refutation table above, each row from a named run.

**UNTESTED against the live book.** The host is still running the 2026-09-07
build; this reaches it only when `deploy-on-host.ps1` is run. Until then the ten
documents fail exactly as before.

**The lesson.** The service's own comment named this failure and its fix a month
before it happened — *"if the line below fails, this is where to look"* — and the
line below did fail, ten times a day, for three weeks. A comment that predicts a
defect is not a mitigation; the prediction has to become a check or somebody has
to go and look. What finally settled it was reading the vendor's documentation and
the machine's own log, in that order, after three theories about our data had died.

**Ref.** fix/why-so-to-do-differs, 2026-09-08. Follows
`docs/autocount-sync-reasons.md` §4, which recorded this cause as UNKNOWN on
2026-08-16.
