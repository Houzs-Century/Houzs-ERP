## Delivery and purchase orders carried over from AutoCount had rows with no line key, so staff edits were refused [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** On 2026-09-15 a salesperson corrected HC-DO-010936 (delivery date,
agent, vehicle). The page listed the delivery under NOT ACCEPTED: *"refused,
nothing sent (KeylessLineError): DO DO-010936: 2 of 3 line(s) carry no
AutoCount DtlKey"*.

**Root cause (traced).** The rows came in two ways:

- the cutover split sofas into pieces, and those piece rows got no AutoCount
  key;
- the 2026-09-07 decomposition added rows with no key.

Composing an edit refuses a document with any keyless row, correctly, because
an unkeyed row would append a duplicate line in the book.

The key stamp could not reach these documents. It planned only documents
numbered `HC-DO-` / `HC-PO-`, which a write-back conversion had sent. A
carried-over document is numbered `HC-` plus AutoCount's own number and was
never sent by a conversion.

Measured on 2026-09-15, carried-over documents with unkeyed rows:

- 14 delivery orders, 36 rows;
- 4 purchase orders, 14 rows;
- 102 goods receipts, 236 rows. Only 28 of those link a book receipt number at
  all.
- 1 sales order, 2 rows.

The book had the shape the pairing needs for every delivery and purchase order
in the list, read the same day:

- every delivery line has exactly one `DocTransfer` row from a sales line;
- every purchase line's `FromSODtlKey` names a live sales line.

A second flaw showed in the same plan. Once `retire-book-only-conversion-lines`
had zeroed HC-GRN-2609-008's split line 928499, the pairing rule still counted
the zeroed line. So the receipt's source read as feeding two lines, and the line
itself read as unclaimed.

**Fix.**

- **The list.** `list-carried-over-keyless-documents.mjs` (read-only) lists the
  carried-over delivery and purchase orders with an unkeyed row, by AutoCount
  number.
- **The export.** `export-ac-conversion-line-keys.py` takes that list as
  `CARRIED_OVER_FILE` and exports them through the same DO and PO lanes and
  shape checks.
- **The stamp.** `stamp-conversion-line-keys.mjs` maps a carried-over number to
  its ERP document (`HC-` + number). In place of a sent conversion, it requires
  that document to link that AutoCount number, and a delivery order to be
  flagged carried over. Pairing rule, digest and fresh-connection verify are
  unchanged.
- **The pairing rule.** `planDocumentKeys` leaves out a book line at quantity 0
  from pairing targets and from the unclaimed count, but only when quantities
  are given, so the drain is unchanged.

The snapshot committed here was cut on 2026-09-15 with the 14 delivery orders
and 4 purchase orders in it. A local plan against it, using the read-only
credential, would stamp:

- 42 delivery rows: the 36 carried over, plus 6 on two new write-back
  deliveries;
- 14 purchase rows;
- 74 invoice rows.

No refusal on any carried-over document. Applying it is UNTESTED until
dispatched.

The goods receipts are not covered: 73 of the 102 carry no book receipt number
to pair against.

Pinned in `backend/tests/conversionLineKeyPlan.test.mjs`. The retired-line test
fails on main's rule (1 failed) and passes after; its control shows that without
quantities the split still refuses. The pairing suites, the book-only plan and
the drain's line-key suites pass (7 files, 40 tests).

**Ref.** fix/ac-migrated-keys, 2026-09-15.
