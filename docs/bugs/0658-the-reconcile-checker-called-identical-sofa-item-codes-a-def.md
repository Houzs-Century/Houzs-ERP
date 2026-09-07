## The reconcile checker called identical sofa item codes a defect [high]

**Symptom.** On go-live day the AutoCount-vs-ERP reconcile reported
`SO DATA ... item code: 240` — 240 sales-order lines whose item code was said to
disagree with the book. The owner's acceptance test is that the six document
types tally, so 240 unexplained line defects read as the migration being wrong.
The very first offender it listed was
`SO-010035 DtlKey 683839: AutoCount model ? ("AMN-SOFA PILLOW") vs ERP model ? ("AMN-SOFA PILLOW")`
— the two codes are byte-identical.

**Root cause (traced).** Two independent defects in one branch of
`backend/scripts/check-ac-erp-reconcile.mjs`, both observed by RUNNING the
checker against production (runs 34099375384 and 34099753029), not by reading it.

1. `isSofaCode` is a bare `/SOFA/i` substring test, so an ACCESSORY whose NAME
   contains the word — `AMN-SOFA PILLOW`, `THL-SOFA PILLOW` — entered the sofa
   branch. That branch compares only the MODEL, `(/\d{3,}/)`, and a pillow has
   no digits, so both sides yielded `null`. The branch read
   `if (am && em && am === em) D.item++; else ... F.item.push(...)`, so a pair
   where NEITHER side has a model fell through to the finding list — even when
   the two strings were identical. **94 lines over 94 sales orders.**
2. The model was not folded through `SOFA_MODEL_ALIAS`. The floor writes the
   same sofa under an internal number and a catalogue number (5530/9028,
   5536/9058, 5537/8030, 5540/8030); ten other scripts in `backend/scripts` fold
   it before comparing and this checker was the only one that did not, so
   `HOK-5536 SOFA` vs `9058-2A(LHF)` read as a defect. **12 lines over 7 sales
   orders.**

**Fix.** `modelOf` now folds through `SOFA_MODEL_ALIAS`, and a pair where
neither side yields a model falls back to comparing the CODES, exactly as the
non-sofa branch does. A pair where only ONE side has a model is still a real
finding and stays one. Measured against production before and after, same
snapshot: **`item code: 240` -> `item code: 99`**, 141 false positives removed.
The 9 real sofa-model disagreements that remain (3 sales orders) are named in
the PR and are an owner decision, not a checker defect.

**Ref.** fix/ac-four-exceptions, 2026-09-07.
