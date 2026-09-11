## Sofa and bedframe book text mostly repeats what the purchase order already prints [low]

<!-- area: Sales orders + pricing -->

**Symptom.** Not a defect — a MEASUREMENT, recorded here because a decision was
about to be taken on an assumption. The owner extended the
`variants.extraAddonNote` backfill to sofa and bedframe on 2026-09-10
(「ok 包过sofa bedframe也是要检查」). Those two are unlike pillows and SP
mattresses: their spec is already STRUCTURED in `variants`, and
`buildVariantSummary` already prints it as the Fabric / SEAT / LEG / DIVAN /
GAP / T.Heights segments that ARE `description2` on the purchase order. Copying
AutoCount's Desc2 whole into the note would therefore make part of the
supplier's document repeat itself, and noise on a supplier document is how a
real instruction gets skipped.

**What was measured (traced).** `backend/scripts/check-sofa-bedframe-book-text.mjs`
plus `.github/workflows/sofa-bedframe-book-text.yml`, read-only, company 1,
sofa + bedframe sales-order lines. The same numbers were first computed locally
over the production corpus dumped by `Export Century SO lines (read-only)` run
34451454550, using the SAME splitting library
(`backend/scripts/lib/book-text-residue.mjs`) the probe imports — 3,920 lines,
sofa 1,329, bedframe 2,591, every one of them on an order linked to AutoCount.

- **The book text is almost always still here.** 3,868 of 3,920 lines carry it.
  `description2` holds it on 3,838; the `账本原文:` remark on 3,703; the
  2026-08-11 gz snapshot on 3,300. They overlap heavily by construction (the
  remark was written FROM the other two on 2026-09-04), and what each one
  RECOVERS is the point: the remark is the only surviving copy on 24 lines, the
  snapshot the only one on 6, and 52 lines have no book text at all.
- **An exact-string match is NOT a usable test here**, and the argument is
  stated with its own circularity: the copy-not-derive guard has already removed
  the lines whose text exactly equals our summary (75 on `description2`, 1 on
  the snapshot), so "0 exact matches" is true by construction. The number that
  carries the argument is the RELAXED one — of the 3,868 remaining, 0 match even
  ignoring case and whitespace, so the two sides differ in wording rather than in
  spacing, and an exact test would file all 3,868 as "carries something new".
- **Residue after coverage** is the test used instead, in three readings whose
  spread IS the honest answer: NARROW (against `description2` alone) says 3,630
  of 3,868 carry something new; LABEL (dropping the words both systems use as
  segment labels, so the book's `M.GAP: 12 INCH` is compared with our `GAP 12"`
  on the NUMBER) says 2,764. NARROW is the upper bound, LABEL the lower.
- **What is genuinely new, on the LABEL reading:** a colour or size still marked
  KIV / TBC (1,406 lines — and on 937 open lines that is the ONLY thing left
  over), a sofa build such as `1R+1NA+1R` that the ERP holds as separate coded
  piece lines (542 lines; the ONLY leftover on 197 open ones), a free-text making
  instruction or fabric note (283 lines by dominant kind), a measurement our line
  does not carry (407), and 991 lines whose leftover the classifier does not name
  — commonest members `EDGE DO CURVE DIVAN`, `HEADBOARD STRAIGHT`,
  `HBDIVANFULLCOVER`, `SIDEDRAWER`, and colour codes our line is missing.
- **The cost of copying whole:** `description2` goes from a median of 44
  characters to 97, and the number of lines over AutoCount's nvarchar(100)
  ceiling goes from 175 to 1,722. Over that ceiling the abbreviator swaps the
  whole SPECIAL segment for the owner's pointer sentence `Special Order: Refer
  to ERP`, so the account book gets the pointer rather than the text — including
  on lines where the appended text was pure repetition.

**Fix.** None applied, deliberately. This is a judgement the owner owns, and the
options are in the pull request that introduced the probe, together with the
verbatim output of its first production dispatch. Nothing was written to any
row.

**Ref.** `audit/sofa-spec-text`, 2026-09-10.
