## Both purchase-order lanes fed one population without dedupe, so 241 book lines were compared twice [medium]

**Symptom.** The AutoCount reconcile's PO field-by-field section reported
`description` blank in the ERP on **14** lines and `line delivery date` blank on
**14**, and printed each sample TWICE:

```
   description [copy]
      PO-009980/907177 [proceeded] book="AMN SOFA - SF9058" erp=null
      PO-009980/907177 [proceeded] book="AMN SOFA - SF9058" erp=null
      PO-010008/910869 [proceeded] book="DSL SOFA - 8069" erp=null
      PO-010008/910869 [proceeded] book="DSL SOFA - 8069" erp=null
```

The same DtlKey, the same document, the same value, listed as two findings.
Seven book lines were being reported as fourteen.

**Root cause (traced).** `backend/scripts/lib/ac-field-identity-run.mjs`:

```js
const PO = group([...poRows, ...linkedPo], "DocNo", "DtlKey", "PO");
```

The PO population is fed by two exports — `ac-outstanding-po.json.gz` (the
outstanding lane) and `ac-so-linked-pos.json.gz` (the SO-dedicated lane). They
OVERLAP: measured on the committed files, **241 of the 696 linked-lane rows
carry a DtlKey that is already in the outstanding lane, across 152 purchase
orders**, and 907177, 910869 and 913140 are three of them.

Inside `group()` the header side deduped — `if (!headers.has(d))` — and the line
side did not:

```js
if (!lines.has(d)) lines.set(d, []);
const key = r[lineKeyField];
lines.get(d).push({ ...r, __key: ... });
```

So every one of those 241 book lines was pushed twice and compared twice, and
every tally on them — agree, differ, ERP-blank — was doubled. `lines compared:
1196` is 501 + 696 with one empty DocNo, not 956 distinct book lines.

The two copies of a line are not identical, and that is worth stating because it
decides the fix. Diffed field by field, they differ in exactly two places and
neither is comparable: `DocKey`, which only the outstanding lane exports, and
`Cancelled`, which only the linked lane does. Every field the reconcile actually
compares — ItemCode, Description, Desc2, Qty, UnitPrice, Location, DeliveryDate,
FromSODocList, FromSODtlKey — is identical on all 241.

**Fix.** `group()` now keeps one line per `(document, line key)` and MERGES a
repeat's non-null fields into the line already held, rather than pushing a
second one. Merging rather than dropping is the point: dropping the second copy
would lose `Cancelled`, dropping the first would lose `DocKey`. A line with no
key is never deduped — there is nothing to dedupe it ON, and two keyless lines
on one document are two lines.

The header path is untouched: first lane wins there, as before.

**Ref.** fix/po-align-0908, 2026-09-08. Measured against reconcile run
`34178538830`.
