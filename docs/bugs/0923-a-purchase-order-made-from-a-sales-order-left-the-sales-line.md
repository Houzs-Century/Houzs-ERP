## A purchase order made from a sales order left the sales line's PO number blank in AutoCount [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** None seen yet; this is the shape difference, found on 2026-09-15
while answering the owner's question of whether a received order shows READY
in AutoCount (「最主要的是 能show status ready」).

The office's plug-in (TechDevs.SOBatchPurchase, "Post SO batch to PO") writes
three fields on each sales order line it buys:

- `SODTL.UDF_PONo`, the purchase order's number;
- `SODTL.UDF_PODocKey`, its DocKey;
- `SODTL.UDF_Creditor`, the supplier.

A purchase order the ERP makes from a sales order leaves all three blank. Live
book, purchase orders dated since 2026-08-01, read 2026-09-15:

| Purchase order made by | Lines linked to a sales line | `UDF_PONo` filled |
| --- | ---: | ---: |
| the plug-in | 564 | 563 |
| the ERP (`HC-` numbers) | 164 | 1 |

**What is proven and what is not.**

- PROVEN: `Remark 2` ("READY", "BEDFRAME/ACC") is written by a program inside
  AutoCount, not by hand and not by the ERP. The book's `EventLog` holds 665
  Remark 2 changes from 2026-09-01 to 09-15, all by ADMIN on the office PC, with
  no third-party application. There is no SQL trigger, procedure or UserScript
  writing it.
- PROVEN: it recognises the ERP's receipts. 37 bedframe or sofa groups were
  received by ERP receipts on 2026-09-10. For 33 of them, Remark 2 gained the
  group after the receipt; none showed it before.
- UNKNOWN: whether it finds a receipt when `UDF_PONo` is blank. Every bedframe or
  sofa line it has marked ready carried the field. No ERP-made purchase order had
  been received by 2026-09-15 except August test documents with no category.

**Root cause (traced).** `AcSyncService.cs` `SoToPo` transfers the sales lines
(`AddPartialTransferDetail("SO", ...)`), saves the purchase order, re-opens it
to apply costs and returns. Nothing in the service writes a sales-line UDF: its
UDF writes are header-only (`ApplyUdf` on `doc.UDF`). The ERP payload has no
field for it either.

**Fix.** `PointSalesLinesAtPurchase` runs at two points:

- after `/so-to-po` has saved its costs;
- after an `/edit` of a purchase order.

It reads which sales lines the purchase order was made from (`PODTL.FromSODtlKey`)
and opens each sales order through the SDK. It fills `UDF_PONo`, `UDF_PODocKey`
and `UDF_Creditor` through `SetUdf`, which logs a refused value by name, then
saves and logs how many lines now name the order.

- Only a blank is filled. A line that already names another purchase order keeps
  it, so a line bought on two orders cannot flip on every edit.
- It is wrapped whole: the purchase order is already saved and must never be
  lost to this step.
- Purchase orders already in the book get the fields on their next edit. To fill
  them now, re-send them with `resend-ac-document-edits`.

Pinned in `backend/src/services/autocount-so-line-po-link.contract.test.ts`:

- 5 tests fail against main's `AcSyncService.cs` and pass after.
- The 14 test files that read the service source pass: 403 tests, 7 skipped.
- `build-local.ps1` compiles clean. A planted type error in the new method failed
  the same build, so the check does compile it.

**INERT until the office host is swapped** (`deploy-on-host.ps1`). Compiling is
not running: whether `SalesOrderDetail.UDF[...]` accepts these keys at run time
is UNTESTED. After the swap, re-send one ERP purchase order and read
`SODTL.UDF_PONo` on its sales lines.

**Ref.** fix/ac-so-line-po-link, 2026-09-15.
