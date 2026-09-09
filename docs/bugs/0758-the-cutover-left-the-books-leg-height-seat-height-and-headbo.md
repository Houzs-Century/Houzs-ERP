## The cutover left the book's leg height, seat height and headboard special blank on nine rows [low]
<!-- area: AutoCount sync + write-back -->
<!-- status: fixed -->

**Symptom.** Five company-1 sales orders sit on the tally under `build heights`,
`seat size` and `specials`. On each, the account book states a value and the ERP
holds nothing. The owner's standing rule covers it exactly — 「一律跟账本」 /
「autocount怎么写我们就怎么写」 — so this is a copy, not a judgement.

**Root cause (traced).** The cutover parsed each book line's `Desc2` into
`variants`, and these nine rows are where the parse produced nothing. Verified
against live `AED_HOUZS`: the values are present in the book's own text
(`Size:30”/…/+2” leg`, `(1EL+1na+1ER)/Col:BO315-2 (24inch)`,
`…/HB straight`), and `variants.legHeight` / `variants.seatHeight` /
`variants.specials` on our side are absent, null or `[]`.

The findings are the reconcile's own words, from `so-tally-verdict`
run `34344456950` with the reconcile log printed:

```
SO-012442 DtlKey 848371: AutoCount "1""  vs ERP "(blank)"
SO-013310 DtlKey 908744: AutoCount "2""  vs ERP "(blank)"
SO-012049 DtlKey 830097: AutoCount "24"" vs ERP "(blank)"
SO-012049 DtlKey 830098: AutoCount "24"" vs ERP "(blank)"
SO-009373 DtlKey 640588: AutoCount "HB straight | HB Straight" vs ERP "(blank)"
SO-010298 DtlKey 701159: AutoCount "HB Straight" vs ERP "(blank)"
```

**Fix.** `backend/scripts/copy-book-specs-2026-09-09.mjs` +
`.github/workflows/copy-book-specs-2026-09-09.yml`. Every write is a FILL,
predicated on the field being blank, so a row somebody has since filled is
skipped rather than overwritten. A book line is ONE sofa and SEVERAL ERP rows, so
the manifest is keyed by `(doc_no, linked_ac_dtlkey)` and the value lands on
every row behind the book line — 012049's two book lines cover five compartment
rows. `variants.specials` is written, never `custom_specials`, which is derived
and self-erasing.

**Four rows on these same documents are deliberately NOT copied**, and each
refusal is a finding rather than a gap:

- **HC-SO-007678** — the book asks for `Front Drawer`; the line carries
  `Left Drawer` + `Right Drawer` and a customer note reading "customize the front
  divan with one drawer on the left and one drawer on the right". The same
  request in two vocabularies; a third special would double-count a drawer the
  factory is already building. Also NOT PROCEEDED.
- **HC-SO-011725** — the book says `DL-CS2 ELEGANCE SUITE (SS)`, the ERP says
  RITZ LUXURY, because Sim approved the amendment "exchange to Ritz Luxury SS" at
  07:38 on 2026-09-09. **The ERP is ahead of the book**; copying the book would
  undo a change a person made today. The book is what needs updating.
- **HC-SO-009373 DtlKey 640590** — the book is blank and the ERP holds `0"`,
  because the book's Desc2 reads `Divan:8 inch+No inch leg`, a typo for "No leg"
  the parser cannot read. Ours is the same statement, correctly recorded.
- **HC-SO-009373 DtlKey 640588 item code** — the book's CODE says plain
  `TRION (A)-(K)` (`HOK-2009(A) (K)`) while the book's own Desc2 says
  "HB straight", which is the HB-STR product the ERP holds; `HOK-2008(A)` is the
  book's own code for TRION (A) (HB STR). The book contradicts itself and only
  the owner can settle which it meant — the same shape as HC-SO-000870 in
  `docs/bugs/0757-both-purchase-lines-landed-on-one-sales-line-because-the-boo.md`.
