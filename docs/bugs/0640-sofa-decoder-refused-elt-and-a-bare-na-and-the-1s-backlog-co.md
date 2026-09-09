## Sofa decoder refused ELT and a bare NA, and the -1S backlog counted correct lines as defects [medium]

**Symptom.** Two things the owner reported on 2026-09-04.

1. A sofa line the decoder refused outright — HC-SO-000814 and the PO raised
   from it, HC-PO-000254, whose Desc2 is
   `[ (1 ELT / T + NA +2ER) (28") / COL: J9883-1-1 PAMA]` and whose remark reads
   `SOFA UNPARSED — 按图/原文补件: token "NA"; token "1ELT"`. He read the
   spellings himself: `ELT` is `L`, the chaise; `ER` is the end on the right, so
   `2ER` is `2A(RHF)`; a bare `NA` with no leading digit is `1NA`.
2. The completeness audit's compartment backlog was bigger than the work. A line
   whose ERP code ends in `-1S` is either a build the decoder could not read
   (work) or a genuine one-seater the book also writes as one seat (correct),
   and both were one number.

**Root cause (traced).**

1. `backend/scripts/lib/parse-sofa.mjs` had no arm for `ELT` and its `na` arm was
   `/^([12])NA$/`, so a digitless `NA` fell through to the "unknown structure
   token" branch, which kills the whole segment. Observed by running the real
   decoder over the corpus row and over the live rows (read-only prod DSN,
   company 1).
2. The audit's `undecoded` branch (`check-sofa-bedframe-completeness.mjs`)
   short-circuited on the remark plus the `-1S` suffix and never asked what the
   Desc2 says, so it reported only "collapsed to a bare 1S placeholder" and had
   no census of the `-1S` population behind it. Counted by hand off the item code
   the two situations came to one figure — 26 lines on the proceeded sales
   orders, of which 5 were never a defect.

**Fix.** The decoder learns `ELT`/`1ELT` (chaise, sided by position) and a bare
`NA` (= `1NA`); `2ER` already read as `2A(RHF)` and is now pinned so a later
sweep cannot change it quietly. The split guard was widened in the same commit,
because it had to be: with those tokens taught, a build written across a slash
INSIDE a bracket ("(1 ELT / T + NA +2ER)") decoded only its second half and
shipped a two-piece sofa with the chaise silently gone, at HIGH confidence. The
guard now normalises a leftover segment's brackets to `+` the way the token
pipeline does, so that line stays a placeholder — which is the right answer,
because the `T` in it is unexplained and the owner has the photograph.

The audit gains `scripts/lib/sofa-single-seat.mjs` and prints the `-1S` census:
the total first, then "the book says a single seater and we agree" apart from
"WE COULD NOT READ THE BUILD (the real backlog)". Both halves of that predicate
are required and each covers the other's measured failure — HC-SO-013327's
`Seater depth +1”` fools the decoder alone, HC-SO-001472's `3S+2S+1S` fools the
text alone.

Proved RED on the unfixed tree: `tests/parseSofaGrammar.test.ts` failed 6 of its
8 new cases before the decoder change (`2ER` and the approved 5-piece precedent
passed, as they should). For the audit half, each half of the predicate was run
alone over the five real lines and each was WRONG on one of them.

Behaviour on the committed corpus is preserved: 697 rows, **identical 695,
changed 2** — the two changed rows are HC-SO-000814 and HC-PO-000254, both still
`pieces=(none) conf=low`, only the recorded reason moves from
`token "NA"; token "1ELT"` to `structure split across segments`.

**Ref.** `fix/sofa-elt-na-audit-split`, 2026-09-04.
