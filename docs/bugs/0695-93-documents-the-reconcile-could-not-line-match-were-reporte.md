## 93 documents the reconcile could not line-match were reported as though checked [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** `check-ac-erp-reconcile.mjs` prints, per type:

```
DO — 26 documents could NOT be line-matched (no line key on either side and
     the line counts differ). Their line data is UNVERIFIED, not verified-clean.
```

44 goods receipts, 26 delivery orders and 23 sales orders — 93 documents — came
back that way, and on 2026-09-08 that sentence was **reported to the owner three
times as coverage**. It is not. Under 「包括每个 line 都是要一样的」 a document
nobody can state the contents of is not aligned; it is unexamined.

**Root cause (traced).** The refusal itself is CORRECT and stays. It is
`check-ac-erp-reconcile.mjs`, at the top of the line loop:

```js
if (!erpLines.some((l) => l.ac_dtlkey != null) && acLines.length !== erpLines.length) {
  unpairableDocs.push(`${ac}: no line key on either side and the counts differ (ERP ${d.erp_no})`);
  continue;
}
```

Neither side carries a key that could pair the lines — `GRDTL.FromDocDtlKey` is
0 of 21,746 in the book, `fromSoDtlKey` is 0 of 48,772 DO lines, and
`scm.grn_items` has no AutoCount line column that anything backfills
(`0280_scm_ac_line_keys_downstream.sql` says so in its own header). Pairing by
POSITION instead is what produced transposed pairs five separate times on
2026-09-07/08 — sofa colours on two delivery notes, ten bedframe dedications,
two sofa models, the goods-receipt item codes.

The defect is that **the refusal was the end of the road**. Pairing is not the
only way to compare two documents, and it is not even the way the owner's rule
asks for: he asked whether the LINES are the same, not which line is which. A
MULTISET answers that with no key at all — the bag of (item, quantity) on each
side, order ignored. The reconcile already builds exactly that bag six lines
further up (`bags.set(ac, { book: bagOf(acPairs), erp: bagOf(erpPairs) })`) and
uses it only to classify item-code pairings; on the documents it then gives up
on, it is never consulted.

**Fix.** `backend/scripts/lib/keyless-multiset.mjs` + `check-keyless-lines.mjs`
+ `.github/workflows/check-keyless-lines.yml` — a read-only verifier that
answers this population three ways instead of one: IDENTICAL (the bags are
equal, so the document IS identical however its lines are ordered), DIFFERS
(with the difference NAMED — which item, how much on each side), and AMBIGUOUS
(only where a sofa's compartments are uneven so the fold cannot state how many
whole sofas that is; both sides are printed per document, never bucketed).

Two things it must not do, pinned RED first in `tests/keylessMultiset.test.mjs`
(17 tests):

- call a **reordering** a difference — `PI-007893` held the same four prices
  rotated by one position and ordinal pairing reported four price defects, none
  real;
- **state a sofa quantity it cannot know**. The fold is `MIN` across distinct
  compartment SKUs, the same rule and the same reason as
  `lib/sofa-piece-fold.mjs`; when min and max disagree the verdict is AMBIGUOUS,
  not a number. `5535` is never folded through `SOFA_MODEL_ALIAS` — it is its
  own model, and folding it would turn a real finding clean.

The ERP-side SELECTs moved to `lib/ac-reconcile-erp-sql.mjs` so both checkers
read ONE definition of "what the ERP holds for an AutoCount document". A second
statement would let this verifier answer about a different population than the
one being reported unverified — the same failure `lib/ac-mapping-csv.mjs`
records, where two parsers for one CSV invented 40 of 111 item-code defects.

**Not yet run.** This PR ships the tool and its tests; the workflow needs
`secrets.DATABASE_URL`, so it can only be dispatched once this is on `main`.
**The 93 documents are still UNVERIFIED as of this commit** — no verdict is
claimed here. The measurement and whatever it finds land in the follow-up, with
the run id.

**MEASURED — see `docs/bugs/0700`.** Run `34191920800` (2026-09-08, 14:0x +08):
136 keyless documents, **126 identical, 6 different, 4 undecidable**. The first
fold this tool shipped with was itself wrong and invented 17 of those findings;
0700 records what it was and how it was refuted.

**Ref.** `fix/verify-93-keyless-docs`, 2026-09-08.
