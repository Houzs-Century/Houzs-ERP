## Our purchase order numbers never reached the sales order's PO Doc No. in AutoCount [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** Owner, 2026-09-15: 「他们的 PO document no 应该是根据我们的系统来填写的」.

The office plug-in fills a sales order's "PO Doc No." (`SO.UDF_ToPONo`) with the
purchase orders it makes from the order: `PO-008785, PO-008786` when there are
several (live book, 264 separators seen, every one ", "). A purchase order made
in the ERP never reached that field.

Worse, until docs/bugs/0926 the ERP wrote the order's reference into it. At
09-15 the damage covered 553 orders and 110 of our purchase orders:

- 553 orders carried a sent row with `UDF.ToPONo`;
- 110 purchase orders had no `UDF_SONo`, and a create had put our own SO numbers
  in `Ref`.

**Root cause (traced).** Nothing composed `ToPONo` from purchase orders at all:

- the sales order create and edit composed it from the reference (0926);
- `/so-to-po` and `/create-po` write the purchase order and nothing on its source
  orders' headers;
- the drain (`dispatchOne`) records the book number and line keys of a sent
  purchase order and stops.

**Fix.**

- **New module** `backend/src/scm/lib/autocount-so-po-doc-no.ts`:
  - `readSoPoDocNos` reads the purchase orders the ERP links to an order through
    its lines (`purchase_order_items.so_item_id`), not cancelled, already in the
    book, by book number.
  - `joinPoDocNos` sorts, de-duplicates and ", "-joins whole numbers up to the
    field's 500 characters.
  - `queueSoPoDocNos` runs from `dispatchOne` after a purchase order's
    `create_po`, `so_to_po` or `cancel` is marked sent. It queues each source order
    (company-scoped, in the book, not cancelled) a header-only edit
    `{ Header: { UDF: { ToPONo } }, Lines: [] }`. After a cancel that leaves none,
    that edit clears the field.
- **Repair** `backend/scripts/repair-ac-po-doc-no.mjs` (workflow *Put our PO
  numbers back in AutoCount's PO Doc No.*). It touches only the documents the
  write-back wrote these fields on:
  - each sales order gets its purchase order numbers, or an empty field when it
    has none, plus `Ref` on orders made in the ERP;
  - each purchase order gets `UDF_SONo` and the source order's reference in `Ref`.

  Plan by default, CONFIRM on apply, `LIMIT` per run because the drain sends 20
  rows a sweep, fresh-connection shape check. Documents already given the edit
  are skipped.

**Why the ERP's links are safe to write.** They were checked against the book
before writing (read-only, both systems, 2026-09-15), over the 558 orders the ERP
had written the reference into. Where the field held purchase order numbers
before the ERP's first change, the ERP's list equals them on 102 of 103 orders and
adds one on the last. No carried-over order has a purchase order in the book that
the ERP does not link.

**Plan against production** (read-only connection, 2026-09-15 ~09:20Z):

- 553 sales orders: 169 get our purchase order numbers, 384 are cleared, and 74
  made in the ERP get `Ref`;
- 110 purchase orders: `UDF_SONo` on 110, `Ref` on 109.

Apply is UNTESTED until run.

**Tests.** `backend/src/scm/lib/autocount-so-po-doc-no.test.ts`, 8 tests:

- the join and its cap;
- the reader leaves out cancelled and unsent purchase orders;
- a create queues the edit with `HC-PO-2609-122, PO-009995`;
- a cancel that leaves none clears the field;
- controls: an order not in the book, a receipt, a purchase for stock, another
  company;
- a create marked sent through the real `dispatchOne` queues the source order's
  edit.

The AutoCount suites pass: 46 files, 881 tests, 7 skipped.

**Ref.** fix/ac-so-po-doc-no-fill, 2026-09-15.
