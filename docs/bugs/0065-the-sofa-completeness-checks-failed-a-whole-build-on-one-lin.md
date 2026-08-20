## The sofa completeness checks failed a whole build on one line's remark, and over-reported by a third [med]

**Symptom** - `COMPARTMENT` read 32 incomplete on purchase-order sofa and 41 on
sales-order sofa, with 30 lines in scope flagged "placeholder, never decoded".
Chasing them found documents that are demonstrably correct.

**Root cause (read from the data, not the message)** - both checks test
`build.some(r => /SOFA UNPARSED/.test(r.remark))` and then fail EVERY line of
that build. The remark marks the one LINE the decoder could not read, not the
build. `HC-PO-009018` is correctly decomposed to `1A(LHF)+1NA+1A(RHF)` and was
failed only because the same document also carries a `9028-STOOL`, whose own
Desc2 is `BO315-21/32" X 49"` - a dimension, with no structure to parse and none
needed, because STOOL IS its compartment. `HC-PO-000136` is the same shape.

Classified over production: of the 30 flagged lines, **19 are a bare `-1S`** (the
real defect - a multi-piece sofa imported as one line), **4 are a real named
accessory piece** (STOOL / Console / DB) and **7 carry a real compartment**
(`1A(LHF)`, `2A(LHF)`, `L(LHF)`, `1ABOX(LHF)`). Eleven of thirty were the
check's own doing.

**Fix** - only a line that fell back to the bare `1S` placeholder counts as
undecoded, and only that line is flagged, not its siblings. COMPARTMENT moved
32 -> 15 (PO) and 41 -> 22 (SO) with no data change of any kind: the same rows,
counted correctly.

**Lesson** - a per-line fault flagged at build level inflates by the build's
width, and the inflation looks exactly like a data problem. Before repairing
what a check reports, confirm the check is counting the thing it names - the
first version of this session's own backfill made the identical mistake in the
opposite direction, reporting 338 held colours because it recorded a hold before
asking whether the line had a blank axis at all.

**Ref** - fix/sofa-unparsed-false-positive, 2026-08-11.
