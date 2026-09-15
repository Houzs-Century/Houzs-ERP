## AutoCount supplier delivery dates never reached the ERP purchase orders [medium]

<!-- area: Purchase orders + AutoCount sync -->

**Symptom.** The owner, 2026-09-15, comparing AutoCount's PO chasing list with
the ERP: AutoCount shows supplier delivery dates on purchase orders where the
ERP shows none. 「第 6 的这样子就要解决掉了」. The 2026-09-04 export
(`PO chasing list 20260904.xls`, 449 lines / 221 POs) had "Estimate Delivery
Date" on 49 lines and "Supplier Delivery Date 2" on 5. For example, HC-PO-009950
had no supplier date at all in the ERP, while the book had
`UDF_EDate2 = 2026-09-12`.

**The mapping (PROVEN, read-only against live AED_HOUZS, 2026-09-15).** The
dates are HEADER UDFs. The chasing report repeats them on every line.

| report column | AutoCount column | UDF caption (`UDF` table) | ERP column |
| --- | --- | --- | --- |
| Delivery Date | `PODTL.DeliveryDate` | (standard) | `purchase_order_items.delivery_date` (already imported) |
| Estimate Delivery Date | `PO.UDF_EDate` | Supplier Delivery Date | `supplier_delivery_date_2` |
| Supplier Delivery Date 2 | `PO.UDF_EDate2` | Supplier Delivery Date 2 | `supplier_delivery_date_3` |
| Supplier Delivery Date 3 | `PO.UDF_EDate3` | Supplier Delivery Date 3 | `supplier_delivery_date_4` |

- Evidence for the report columns: on 410 of 410 comparable lines, the xls
  "Estimate Delivery Date" equals live `UDF_EDate`. The other 38 lines were blank
  on 09-04 and are set in the book now. "Supplier Delivery Date 2" equals
  `UDF_EDate2` on 448 of 448 lines, and "Supplier Delivery Date 3" equals
  `UDF_EDate3` on 448 of 448.
- `PODTL.EstimatedDeliveryDate` is a different field: free text, set on only 3
  rows, all from 2024.
- Why the ERP slots are shifted by one: the ERP's first date is the base date
  (`delivery_date` / `expected_at`), and slots 2/3/4 are the supplier's dates
  after it. `effective-delivery.ts` takes the effective date as the MAX of all
  four.
- `UDF_EDate` is its own supplier date, not a copy of the base date. Across 2026
  POs it is later than the line delivery date on 296 and earlier on 109.
- A name-for-name mapping (`UDF_EDate2` to `_2`) was rejected because it throws
  away `UDF_EDate`, the most-used of the three (984 POs in the book).
- This agrees with how the ERP already uses slot 2: 2990 staff and ERP-raised
  HC-PO-2609-031 put the supplier's first date into `_2`.

**Root cause (traced).** There has never been a path for these dates, in either
direction:

1. **The cutover never read them (PROVEN).** The committed snapshots the PO
   importers read, `backend/scripts/data/ac-outstanding-po.json.gz` and
   `ac-so-linked-pos.json.gz`, carry no `UDF_EDate*` key. Their export SQL
   (`data/autocount-refetch-po.sql`) selects `pod.DeliveryDate` only.
   `import-ac-outstanding-po.mjs` and `import-ac-so-linked-pos.mjs` write only
   `delivery_date` / `expected_at`.
2. **No live pull brings them into `scm` (PROVEN).** The only code that reads
   them is `services/po.ts` `runPOPull` (`SupplierDeliveryDate1/2/3`), and it
   writes the legacy `public.purchase_orders` mirror, never `scm.purchase_orders`.
   That mirror is frozen: its newest `execution_logs` row is `PO_PULL_SCHEDULED`
   2026-06-12 16:30Z, and its newest `doc_date` is 2026-06-12.
3. **The write-back does not send them (PROVEN in code).**
   `services/autocount-writeback.ts` composes the PO header with `UDF: {}`. So a
   supplier date typed into the ERP never reaches AutoCount either.

**It WILL keep happening (PROVEN).** Staff are still typing supplier dates into
AutoCount on migrated POs. The 38 lines above were blank in the 09-04 export and
are set in the live book on 09-15. Nothing brings those in, so every date typed
in the book from now on is missing from the ERP, and every date typed in the ERP
is missing from the book.
At 2026-09-15 no ERP-written PO (`HC-PO-*`, 135 in the book) carries a book-side
supplier date.

**Fix.** A one-off fill of blanks from a committed live snapshot.

- `backend/scripts/export-ac-po-supplier-dates.py` is read-only against the
  book. It writes `data/ac-po-supplier-dates.json.gz` + a manifest (997 POs with
  a supplier date, exported 2026-09-15T12:11:49).
- `backend/scripts/fill-po-supplier-dates-from-autocount.mjs` and its workflow
  work on company 1 only.
  - A PO is matched on `linked_ac_docno`.
  - Only a header slot that is NULL is filled. That PO's lines are filled only
    where the same slot is NULL, which is the header PATCH cascade.
  - A different ERP value, or a line carrying its own value, is listed and never
    overwritten.
  - One `entity_audit_log` row is written per PO.
- Read-only plan against production before the PR: 130 POs, 136 header slot
  fills, 411 line slot fills.
  - 0 "both set and different" and 0 "line has its own value".
  - 0 book POs with a date that are still open in the book and absent from the
    ERP.
  - 867 book POs with a date that are fully received and were never imported
    (outside cutover scope).
  - 12 ERP lines match no book line by key or item code: sofa compartment pieces
    on HC-PO-008783, HC-PO-009024 and HC-PO-010083, where one book line becomes
    several ERP lines. They are still filled, because the date belongs to the PO.
- **Does not publish to AutoCount (PROVEN in code, and asserted per run).**
  - The write-back is queued only by the route layer (`queueAcPoEdit`).
  - The only trigger on the two tables is `trg_po_item_qty_guard` (BEFORE UPDATE
    OF qty).
  - Even a republish would send `UDF: {}`.
  - The verify step fails the run if any `scm.autocount_outbox` row appears for
    a touched PO after the transaction starts.
- Plan / apply / re-plan run ids are recorded in the follow-up to this entry.

**Root fix: NOT BUILT, options owed to main before any build.** The one-off fill
does not stop recurrence. The candidates:

- (a) send `UDF_EDate/2/3` from `supplier_delivery_date_2/3/4` in the PO
  write-back, so the ERP, as the editing surface, owns the dates;
- (b) pull them from the book into `scm`;
- (c) both, with a last-modified rule.

Residual risk: the PO header PATCH has no stale-version guard. A PO edit form
opened before the apply and saved after it sends its blank `supplierDeliveryDate2..4`
and clears the filled header slot. The audit log records both events.

**Ref.** fix/po-supplier-delivery-dates, 2026-09-15.
