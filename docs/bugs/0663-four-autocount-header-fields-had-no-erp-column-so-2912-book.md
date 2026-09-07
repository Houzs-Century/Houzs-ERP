## Four AutoCount header fields had no ERP column, so 2,912 book values could not be copied [high]

**Symptom.** A migrated sales order in the ERP cannot say where the goods go.
AutoCount holds a separate delivery address on the document; the ERP holds only
the invoice address, and there was nowhere to put the other one. Same shape for
the contact person the document is addressed to, the credit term AutoCount
prints, and the purchase orders AutoCount raised from the order.

**Root cause (traced).** Not a write bug — a SCHEMA gap, which is why nothing
before PR #3061 could see it. `check-ac-erp-reconcile.mjs`'s field-identity
section classifies a field `NOT_CARRIED` when the book carries the column and no
importer names an ERP one. Four such fields were left on the sales order and two
on the purchase order:

| AutoCount field | `backend/scripts/lib/ac-field-identity.mjs` before | why nothing could be written |
|---|---|---|
| `SO.DeliverAddr1..4` | `erp: null, status: NOT_CARRIED` | `scm.mfg_sales_orders` has `address1..4` (the INVOICE address) and a single `ship_to_address`, no four-line delivery address |
| `SO.DisplayTerm` / `PO.DisplayTerm` | `erp: null, status: NOT_CARRIED` | the ERP keeps credit terms on the CUSTOMER, never on the order |
| `SO.Attention` / `PO.Attention` | `erp: "attention"` but `status: NOT_CARRIED` | the checker already NAMED the column; `scm.mfg_sales_orders` did not have it |
| `SO.UDF_ToPONo` | `erp: null, status: NOT_CARRIED` | no column, and the four `customer_po*` columns that might have looked like a home were dropped as dead by mig 0312 |

`lib/ac-header-fields.mjs` (PR #3060) recorded the same six as `erp: null` rows,
which is what made them countable at all. The exporter was never the problem:
`export-ac-reimport.py`'s `hdr` section already selects every one of them into
`ac-doc-headers.json.gz` — `SO_HDR_COLS` and `PO_HDR_COLS`, both added by #3060 —
so the values have been sitting in the tree, unusable, since that cut.

**Measured** against `backend/scripts/data/ac-doc-headers.json.gz`, exported
2026-09-07T17:36:03+08:00 from the live AED_HOUZS book (13,365 SO and 9,408 PO
headers, test documents excluded):

```enumeration
$ node -e "const z=require('zlib'),f=require('fs');const r=JSON.parse(z.gunzipSync(f.readFileSync('backend/scripts/data/ac-doc-headers.json.gz'))).rows;const F=(s,n)=>s.indexOf(n);const c=(rows,fs,n)=>{const i=F(fs,n);return i<0?'ABSENT':rows.filter(x=>x[i]!=null&&String(x[i]).trim()!=='').length};for(const n of ['DeliverAddr1','DeliverAddr2','DeliverAddr3','DeliverAddr4','DisplayTerm','Attention','UDF_ToPONo','DeliverContact'])console.log('SO',n,c(r.so,r.so_fields,n));for(const n of ['DisplayTerm','Attention'])console.log('PO',n,c(r.po,r.po_fields,n))"
SO DeliverAddr1 12791
SO DeliverAddr2 10384
SO DeliverAddr3 11991
SO DeliverAddr4 10027
SO DisplayTerm 13365
SO Attention 3018
SO UDF_ToPONo 7071
SO DeliverContact 25
PO DisplayTerm 9408
PO Attention 300
```

**The delivery-address number that matters is 124, not 12,791.** The same cut,
compared line by line against `InvAddr1..4` after collapsing whitespace and case:
identical on **12,667** orders, genuinely **DIFFERENT on 112**, and **12** more
carry a delivery address with no invoice address at all. Those 124 are the
documents that would send a driver to the wrong place. Quoting the fill count as
the size of the problem is the denominator error CLAUDE.md warns about, and this
entry states both numbers so the next reader does not have to re-measure.

`DisplayTerm` holds exactly ONE distinct value across both document types —
`C.O.D.`, on all 13,365 sales orders and all 9,408 purchase orders. It earns a
column anyway: it is the only order-level record of a printed term, so a document
whose term ever stops being C.O.D. is invisible without it.

**Fix.** Migration `20260907T1026_ac_header_notcarried_columns.sql` adds seven
nullable `text` columns to `scm.mfg_sales_orders` (`attention`,
`delivery_address1..4`, `display_term`, `ac_to_po_no`) and two to
`scm.purchase_orders` (`attention`, `display_term`). Additive only — no default,
no backfill, no view work (adding a column is invisible to a view that projects
by name; the 0189 → 0190 → 0191 grant incident was a DROP). Nothing in the
application reads them, so the migration changes no screen and no total.

`lib/ac-header-fields.mjs` turns those six map rows from `erp: null` into named
`copy` fields, which is all `sync-ac-delta.mjs LANES=hdr` needs to plan and write
them — the lane already derives everything from the map, including its per-field
human veto. The SO importer's `HCOLS` is deliberately NOT extended: it is
INSERT-ONLY and mid-cutover, and the header lane runs over every row with a
`linked_ac_docno`, so a document imported five minutes ago is covered as readily
as one imported in August. That is recorded in each map row's `why`.

`lib/ac-field-identity.mjs` moves the six from `NOT_CARRIED` to `CARRIED` with
the column named, and `lib/ac-field-identity-run.mjs` selects the new columns
through `pick()`, which degrades to `NULL AS <name>` when the column is absent —
so a database that predates the migration reports "the ERP has nowhere to put it"
instead of killing the statement.

**One thing had to change beyond the schema.** Three of the fields
(`SO.DisplayTerm`, `PO.Attention`, `PO.DisplayTerm`) are not in the MIGRATION
exports at all, only in the header cut, so the checker would have scored them
`acBlank` — "AutoCount says nothing" — on a field the book fills on every
document. `loadAcFieldSide` now merges `ac-doc-headers.json.gz` as a **fill-only**
enrichment: a key the migration cut already carries is never overwritten, which
is the owner's own rule of the same day (「保留 ERP 的价钱 — 空白不覆盖」) applied
to the AutoCount side. The file is optional; without it the three fields simply
stay unfilled. Verified on the committed snapshots — `SO.DisplayTerm` went from
0 to 2,789 of 2,789 headers and `PO.DisplayTerm` from 0 to 484 of 484.

**Proved RED before green**, on the unfixed tree, by reverting the map:

- `ac-header-fields.test.mjs` — reverting `display_term` to `erp: null` and
  renaming `ac_to_po_no` to `customer_po_no` failed exactly the three new tests
  and no others (`tests 16 / pass 13 / fail 3`); restored, 16 of 16 pass.
- `ac-field-identity.mjs`'s self-test — the same reversion failed 2 of 13, and
  giving `DeliverAddr<n>` an `InvAddr<n>` fallback failed the delivery-address
  case on each of the four lines in turn (four separate runs, `failed 1` each).
  That fallback is the cheap wrong implementation: it would report 100%
  agreement and hide all 124 orders the column exists for. The first draft of
  that case checked line 1 only and stayed GREEN while line 2 was broken, which
  is why it now loops over all four.

**A naming correction is baked into this change.** `UDF_ToPONo` reached this work
described as "customer PO number". It is not: of the 7,071 filled values, **7,068
begin `PO-`** (SO-000002 → `PO-000972`, SO-013507 → `PO-010170`) — they are the
purchase orders AutoCount raised FROM the order, going OUT to a supplier, the
opposite direction from a customer's own reference. The column is `ac_to_po_no`
and a test asserts the name never becomes `customer_po_no`. Naming it for the
wrong direction is how this repo ended up dropping four dead `customer_po*`
columns in mig 0312.

**Ref.** feat/ac-notc-fields, 2026-09-07. Follows PR #3060 (the header map) and
PR #3061 (the field-identity checker that found this).
