## The specials recording never reached the delivery order or the invoice [medium]

**Symptom.** Three documents sat on the reconcile's `specials` axis with the
same finding, run 34315002578:

```
HC-DO-010104  DtlKey 818716 (ERP 9058-1NA):        the book asks for Nylon Fabric and the line does not carry it
HC-DO-011371  DtlKey 909888 (ERP 8030-2A(RHF)):    the book asks for Nylon Fabric and the line does not carry it
HC-I-2605-0294 DtlKey 856708 (ERP 9058-1A(LHF)):   the book asks for Nylon Fabric and the line does not carry it
```

The SALES ORDERS they were converted from — `HC-SO-010130` and `HC-SO-008464` —
are clean on that axis, so the build was recorded correctly once and the copies
were left behind.

**Root cause (traced).** `record-priced-specials-on-migrated-lines.mjs` applies
the owner's ruling 甲 of 2026-09-03 (「记下来给工厂看，但单据的钱不可以动」) by
writing `variants.specialsRecorded`, and its `TABLES` constant listed exactly two:
`mfg_sales_order_items` and `purchase_order_items`. `check-ac-erp-reconcile.mjs`
compares a delivery order's and a sales invoice's OWN line against the book —
both types select `i.variants` in `lib/ac-reconcile-erp-sql.mjs` — so the two
downstream copies were being measured against a rule that had never been applied
to them.

Read on production, `probe-book-line-gaps` run 34313162057: `HC-I-2605-0294`'s
line carries `specials: ["Bttm upgrade to umbrella fabric"]` — the slip's own
words — and not the owner's picker code `Nylon Fabric` that
`lib/sofa-special-map.mjs` maps that phrase to. The instruction is on the line;
the CODE is not, and the code is what the comparison asks for.

**Fix.** `scm.delivery_order_items` and `scm.sales_invoice_items` join `TABLES`,
with their own money columns read off each table's DDL. The trigger and
generated-column census now reads `TABLE_OF` instead of a hand-typed IN-list, so
a table added to `TABLES` cannot be left out of the measurement that proves no
write here turns into money — the census was the thing that could silently have
covered two tables while four were written. The per-table counters (`updates`,
`cover`, `alreadyArmed`) are derived from `TABLES` for the same reason.

Neither new table has a re-price: a delivery order's and an invoice's line money
is COPIED from the document it was converted from and never re-derived from
`variants`, so the exposure a plain stamp into `variants.specials` would arm is
structurally absent there rather than merely small. Nothing about `variants.specials`
or `custom_specials` changes on any table.

**Ref.** fix/book-line-inserts, 2026-09-09.
