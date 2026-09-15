## A supplier delivery date entered in the ERP never reached AutoCount's purchase order [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** AutoCount's PO chasing list is missing the supplier delivery dates
staff enter in the ERP. The ERP has been the only editing surface since go-live
(owner 2026-09-15: 「我们只操作erp 不操作autocount」). The companion entry,
`docs/bugs/0918-autocount-supplier-delivery-dates-never-reached-the-erp-purc.md`,
covers the other direction: book dates that never reached the ERP, now filled.

**Root cause (traced).** The PO write-back never carried them.

- `composeCreatePo` (`services/autocount-writeback.ts`) built the master with
  `UDF: {}`. `/so-to-po` spreads that master, so it sent the same empty UDF.
- `composePoState`'s edit header (`scm/lib/autocount-outbox.ts`) sent only
  `CreditorName` and `Description`.
- `readPoHeader` did not select `supplier_delivery_date_2/3/4`.
- PROVEN on production outbox rows. The ERP edits sent for HC-PO-009827
  (2026-09-15 03:41Z), HC-PO-009880 and HC-PO-009517 carried a `Header` of
  exactly `{Description, CreditorName}`.

**Fix.** The three header slots now go out as the book's PO UDFs:
`supplier_delivery_date_2/3/4` become `EDate/EDate2/EDate3`, on `/create-po`,
`/so-to-po` (through the master) and `/edit` (`Header.UDF`).

- **A blank slot is omitted, never sent as null.** AcSyncService turns a present
  null into "" and blanks the book's field, and every PO edit republishes the
  whole header.
- The accepted cost: clearing a date in the ERP does not clear it in the book.

**Key spelling (PROVEN for the convention, LIKELY for these three keys).**

- The book's `UDF` table lists the PO fields as `FieldName` `EDate` / `EDate2` /
  `EDate3`, columns `UDF_EDate*`, datetime (read-only query 2026-09-15).
- The SO's `PDate` uses the same unprefixed spelling, through the same
  `ApplyUdf`, into a datetime column, and it lands. SO-011331 sent
  `Header.UDF.PDate = 2026-09-15` at 03:26:39Z. The book reads
  `UDF_PDate = 2026-09-15`, LastModified 11:26:39 book time, by `MASTER`. Eleven
  more SOs from 09-13/14 match the same way.
- The service needs no change: `CreatePo`, `PurchaseHeader` and `Edit` already
  call `ApplyUdf`, and `SetUdf` retries a refused string as a `DateTime`.
- Still to observe: a PO date landing in the book.

**Test.** `backend/src/services/autocount-po-supplier-dates.contract.test.ts`
has 12 cases. They prove:
- a null slot is absent from the UDF, on create, transfer and edit;
- an all-blank PO sends no `UDF` key on the edit;
- `readPoHeader` selects the slots;
- the C# routes apply `UDF` from the payload.

RED on the unfixed wiring: 3 of the 12 cases failed with the write-back and
outbox changes stashed.

**Live proof: UNTESTED until staff make a real supplier-date edit in the ERP.**
No test document is made in either system (owner rule). The read, when it
happens, is read-only:
1. `scm.entity_audit_log` row on `PURCHASE_ORDER` with a `supplierDeliveryDate2..4`
   field change, source `web`, after the deploy of this PR.
2. The `scm.autocount_outbox` `edit` row for that PO is `sent`, and its
   `payload->'body'->'Header'->'UDF'` carries the date.
3. On the book, `SELECT UDF_EDate, UDF_EDate2, UDF_EDate3, LastModified,
   LastModifiedUserID FROM PO WHERE DocNo = <linked_ac_docno>` reads the same
   date, modified by `MASTER` after `sent_at`.

**Ref.** fix/po-supplier-dates-writeback, 2026-09-15.
