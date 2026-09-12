## Four documents kept a change log nobody could read [high]

**Symptom.** The purchase order, purchase invoice and sales invoice each had a
History button that did nothing visible — it rewrote the address bar to
`?tab=history` and the page stayed where it was. The delivery order's History
button DID open something, which was worse: a "Change history" modal that was
built out of the delivery order's own current columns (created date, driver
name, delivery date, status, line count), so it described the document as it
stands and read as a list of things that had happened. Edit a date and the
"history" changed retrospectively with it.

Meanwhile every one of those four documents had a complete, correct, timestamped
change log sitting in the database, with the staff name against each change.

**Root cause (traced).** Two lists, one meaning — the shape this repo keeps
paying for.

`ENTITY_TYPES` in `backend/src/scm/lib/entity-audit.ts` is the closed union the
read endpoint filters on, and it carries ten names. `AuditEntityType` in
`frontend/src/vendor/scm/lib/entity-audit-queries.ts` was a HAND-COPY of it that
carried five: `PAYMENT_VOUCHER`, `GRN`, `STOCK_TAKE`, `STOCK_TRANSFER`,
`INVENTORY_ADJUSTMENT`. Its comment said "must stay in step with ENTITY_TYPES",
and nothing made it.

So when the document modules were wired into the audit log, the write half
landed and the read half could not be spelled. Counted on `origin/main` at
134abbc75, `recordEntityAudit` is called 18 times in `grns.ts`, 17 in
`mfg-purchase-orders.ts`, 17 in `payment-vouchers.ts`, 13 in `sales-invoices.ts`,
13 in `purchase-invoices.ts` and 11 in `delivery-orders-mfg.ts` — a broad and
working write side. `GET /entity-audit-log/:entityType/:entityId` accepts all ten
names. No screen could name four of them, so no screen asked.

Nothing failed anywhere. No error, no empty state, no log line. The backend was
right, the rows were there, and the only broken artifact was a list one
directory tree over. That is why it survived: the failure mode of a missing
union member is silence.

The delivery order's synthesized modal is the second half of the same cause. Its
own comment said "A future backend history endpoint can replace this with a
proper audit log; for now the detail endpoint doesn't return one". That endpoint
had existed and had been recording `DELIVERY_ORDER` rows for months.

**Fix.** `AUDIT_ENTITY_TYPES` is now an exported VALUE the type derives from, and
`entity-audit-queries.test.ts` READS `backend/src/scm/lib/entity-audit.ts` and
fails the moment the two lists differ. Proved RED on the unfixed tree: three
failing assertions, the equality one reporting the five missing names.

On top of that root fix, the four documents gained the real drawer.
`DocumentHistoryDrawer` holds one registry — entity name, label vocabulary,
status pill vocabulary — keyed by the same entity type the backend records
under, so adding a document is one row rather than a fifth copy of six props.
The goods receipt, which already had the drawer, was collapsed onto it too.
`DocumentHistoryDrawer.test.tsx` pins that every registered document names a
real entity type, carries a status vocabulary the pill actually maps, and labels
every header field its own route diffs — that last one reads the backend's alias
tuples, so a renamed column cannot leave a label silently unreachable.

The delivery order's synthesized `HistoryModal` is deleted. A history that is
computed from the present is not a history.

`ActivityRow` moved to its own file only because `SalesInvoiceDetailV2.tsx` sat
three lines under the 2,000-line cap and the wiring did not fit; the component
is unchanged.

**Not covered here, deliberately.** The sales order reads a different table
(`mfg_so_audit_log`) through its own panel and was already correct.
`PURCHASE_RETURN` and `INVENTORY_ADJUSTMENT` are write-only today — the rows
exist for an investigator, and no detail screen asks for them — so they are in
the type union and not in the drawer registry.

**Ref.** feat/change-log-six-docs, 2026-09-13.
