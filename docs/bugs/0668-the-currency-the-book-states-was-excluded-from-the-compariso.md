## The currency the book states was excluded from the comparison by a stale marker [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** `check-ac-erp-reconcile.mjs` reported, for both sales orders and
purchase orders:

```
NOT MEASURABLE ON THIS CUT — would need PO.CurrencyCode added to the exporter's
SELECT. The importer writes the CONSTANT 'MYR'.
```

So the one field the owner ruled on for `HC-PO-009335` on 2026-09-07 — the ERP
saying `MYR` on a document AutoCount holds in `CNY` — was the one field the
reconcile could not measure, and the next question ("how many others?") had no
answer short of a fresh trip to the live AutoCount book.

**Root cause (traced, not guessed).** The exporter had been pulling the column
for weeks. `export-ac-reimport.py`'s `hdr` section lists `CurrencyCode` in both
`SO_HDR_COLS` (line 570) and `PO_HDR_COLS` (line 580), and writes them into
`data/ac-doc-headers.json.gz`; `lib/ac-field-identity-run.mjs`'s `enrich()`
merges *every* field of that cut onto the header object, fill-only. Read back
from the committed snapshot (cut 2026-09-07 17:36+08):

```
book SO: 13,365 documents — MYR=13365
book PO:  9,408 documents — MYR=9386, CNY=22
```

What stopped the comparison was an annotation, not a missing column:
`notExported: "SO.CurrencyCode"` / `"PO.CurrencyCode"` on the two currency rows
of `lib/ac-field-identity.mjs`. `ac-field-identity-run.mjs:319-321` filters every
`notExported` field out of the compared set and prints it in the
"NOT MEASURABLE" block instead. The marker's own contract is *"a field the
CURRENT cut of export-ac-reimport.py does not pull at all"* — and that had
stopped being true. It was written when the only book side was the migration cut
(`ac-outstanding-so.json.gz` / `ac-outstanding-po.json.gz`, which genuinely carry
no currency) and was not revisited when the header cut and `enrich()` were added
for `Attention` and `DisplayTerm`.

The cost is exactly the cost of a stale fact in an auto-loaded file: the report
did not say "unknown", it said "would need a column added to the exporter", which
sends the next reader to the office host for a re-cut that was never needed.

**Fix.**

- The `notExported` marker is removed from the SO and PO currency rows, so the
  field is compared from the header cut that already carries it. No exporter run
  and no AutoCount round trip is required to measure it.
- `DO.CurrencyCode` genuinely was not exported — `ac-partial-dos.json.gz` is a
  line projection with no header at all — so `export-ac-reimport.py`'s `hdr`
  section grew a **DO lane** (`DO_HDR_COLS`), appended beside `so`/`po` so an
  older reader is unaffected. `enrich()` learned the DO kind. **This one DOES
  need a re-cut**: the committed `ac-doc-headers.json.gz` has no `do` section, so
  the DO currency row keeps its marker, now naming the lane and the re-cut rather
  than a column that does not exist.
- `backend/scripts/check-currency-and-do-warehouse.mjs` +
  `.github/workflows/currency-and-do-warehouse-check.yml` — a read-only
  production diagnostic that answers what the ERP holds for those 22 documents,
  what TYPE each `currency` column is (a text column and an enum are two
  different repairs), and what hangs downstream of them. Built rather than asked,
  per the repo rule.

**What this does NOT do.** It does not change a single currency value. The repair
of the 22 documents is a separate change, because it has downstream consequences
the report has to state first: `resolveGrnFx` (`routes/grns.ts:233-255`) makes a
new GRN inherit its currency from the source purchase order, and
`assertForeignRatePostable` refuses to post a foreign receipt with no rate. The
label is not decoration.

**Ref.** fix/currency-and-line-location, 2026-09-07. Follows
`docs/bugs/0665-*` and `docs/bugs/0666-*`, which are the money half of the same
confusion.
