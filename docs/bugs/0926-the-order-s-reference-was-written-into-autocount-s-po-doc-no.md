## The order's reference was written into AutoCount's PO Doc No., overwriting purchase order numbers [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** Owner, 2026-09-15: 「ERP convert to Autocount the PO DOC NO. overwrite
as Ref number」 and 「他们的 PO document no 应该是根据我们的系统来填写的，而不是放
reference number」.

The live book's `EventLog` labels `SO.UDF_ToPONo` as "UDF PO Doc No.". It records
these ERP (MASTER) changes to that field between 2026-09-07 and 09-15:

| From → to | Orders |
| --- | ---: |
| a PO number → the reference (e.g. SO-012411 lost `PO-009995`) | 92 |
| blank → the reference | 376 |
| text → other text | 15 |

On top of that, the 77 orders made in the ERP reached the book with the reference
in PO Doc No. and `Ref` blank. The ERP's purchase orders carried no
`UDF_SONo`. A create put our own SO numbers in `Ref`, and a transfer sent
nothing.

**How the office plug-in fills the same fields** (live book, 910 SO-PO pairs
since 2026-06-01):

- `PO.UDF_SONo` is the order's number on 908 pairs, and `UDF_SODocKey` its DocKey
  on 908.
- `PO.Ref` equals the order's `Ref` on 897.
- `SO.UDF_ToPONo` names the purchase order on 778. When one order made several
  purchase orders, it names all of them as `PO-008785, PO-008786` (264 separators
  seen, all ", "). The field is `nvarchar(500)`.

**Root cause (traced).**

- `soCustomerRef` in `backend/src/services/autocount-writeback.ts` fed `customer_so_no`
  (the reference the operator types) into `UDF.ToPONo` on the create.
- `so-edit-header.ts` did the same on every edit.
- `Ref` was sent from `ref`, which is empty on all 77 ERP-made orders and equal to
  `customer_so_no` on carried-over ones (2,876 of 2,882). So an edit of a
  carried-over order wrote the reference into both fields, over the PO number.
- The premise came from the 2026-08 field audit (§7 of
  `docs/autocount-field-alignment-audit.md`). It read `ToPONo` as the customer's
  PO reference, although the migration record lists it as "the PO raised for an
  order, comma-joined".
- On the purchase side, `readPoHeader` hard-coded `ref: null`. `enqueuePoCreate`
  overwrote a create's `Ref` with the source SO numbers (`poSourceRef`).

Before the fix, main's composer sends `Ref: null, UDF.ToPONo: "MR TAN / SUNWAY"`
for an ERP-made order. For a carried-over order it sends
`Ref: "PG10 / IOI", UDF.ToPONo: "PG10 / IOI"`.

**Fix.**

- **Sales order.** A new `soReference` returns `customer_so_no`, falling back to
  `ref`. The create and the edit send it as `Ref`, and nothing composes
  `ToPONo` any more, so the book keeps its own. `clearedAcKeys` clears `Ref` only
  when both columns are empty.
- **Purchase order.** A new `backend/src/scm/lib/autocount-po-source-so.ts`
  (`readPoSourceSo`) reads the orders a purchase order was made from:
  - `source_so_no` holds their book numbers (`linked_ac_docno`, else the ERP
    number), ", "-joined by the renamed shared `poSourceSoNos`;
  - `ref` holds the order's reference when there is exactly one.

  `readPoHeader` fills both. `composeCreatePo` (and so `/so-to-po`) sends
  `Ref` and `UDF.SONo`. `poEditHeader` sends them when present. The Ref
  override in `enqueuePoCreate` and `readPoSourceSoDocNos` are gone.

Pinned in `backend/src/services/autocount-po-doc-no.test.ts` (7 tests):

- the create and the edit put the reference in `Ref` and nothing in `ToPONo`;
- the fallback to `ref`;
- the clearing rule;
- one source order gives `Ref` and `UDF.SONo`;
- two source orders give `UDF.SONo` in the plug-in form and no `Ref`;
- a purchase for stock gives neither.

Existing expectations of `ToPONo: <reference>` in `autocount-outbox.test.ts`,
`autocount-writeback.test.ts` and the contract test were changed to the rule
above. The AutoCount suites pass: 44 files, 866 tests, 7 skipped.

**Not in this change, and still wrong in the book until done:**

1. `ToPONo` is not yet filled with our purchase order numbers.
2. The orders already changed are not yet repaired.

Both need the live book, and each comes with its own plan run.

**Ref.** fix/ac-po-doc-no, 2026-09-15.
