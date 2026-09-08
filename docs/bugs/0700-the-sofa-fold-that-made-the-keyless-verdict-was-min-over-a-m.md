## The sofa fold that made the keyless verdict was MIN over a model, and a document has no batch [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The first production run of the keyless-multiset verifier
(`34189979464`, 2026-09-08) reported **nine sales orders and two delivery
orders** as real differences, every one of them shaped exactly alike:

```
SO-002315 (ERP HC-SO-002315) — book 2 line(s), ours 4:
   SOFA 5527: book qty 2 vs ours 1
```

and returned **six more as undecidable**, all of them sofas:

```
GR-003922: SOFA 9058: the book says qty 1; our compartments are uneven
           (9058-1A(LHF) x1, 9058-1A(RHF) x1, 9058-1NA x2, 9058-CNR x1)
```

Not one of the seventeen was a defect. Every one was the FOLD.

**Root cause (traced).** The fold was taken from `lib/sofa-piece-fold.mjs` — MIN
across a model's distinct compartment SKUs — and that module folds **STOCK**,
where one build is one `batch_no`. A DOCUMENT has no batch, and the same
arithmetic is wrong on it twice over:

- **Two sofas of one model with different layouts fold to ONE.** Four rows of one
  piece each give `min = 1` when the answer is two. That is the nine sales
  orders.
- **A build that legitimately repeats a piece reads as uneven.** `1R+1NA+1NA+C+1R`
  is FIVE pieces including TWO `1NA`, so `1NA x2` beside four singles is a
  correct sofa, not a shortfall. That is the six undecidables.

**The grouping key was there all along.** Both cutover importers write the
AutoCount line's `Desc2` verbatim onto every compartment row they mint
(`description2`) — the fact `src/services/autocount-sofa-collapse.ts` is built
on, its ECHO path re-sending that stored text to the book. So the compartments of
ONE book sofa line carry ONE build text, and grouping by (model, build text)
recovers what the missing line key would have given, by VALUE and never by
position.

**And the count is a DIVISION, not a minimum.** `parseSofa` — the same decoder
both importers used to mint these rows — turns the build text into the piece list
for one sofa. Sofas = our quantity of each piece ÷ how many one sofa needs, and
every piece must give the same whole answer. Verified against the live rows
before the rule was written:

```
GR-003922  "CH141-01 (CREAM)/30”/1R+1NA+1NA+C+1R"  needs 1A(LHF) x1, 1NA x2,
           CNR x1, 1A(RHF) x1; we hold exactly that -> 1 sofa, decided
```

**One further correction, from run `34190818236`.** Using the decoder as a HARD
divisor over-corrected: where our compartment set is not what the text decodes
to, it returned five sales orders and six delivery orders as undecidable whose
line, model, quantity and money all agree — `HC-SO-011099` holds `1A(LHF)` +
`1A(RHF)` under a build text reading `2S`. That is a COMPARTMENT question, which
the reconcile's variant half owns and the sofa-corrections lane repairs; it is not
a missing line. The divisor is now used only where it covers what we hold, and
the disagreement is reported in its own count (12 documents) that can never be
read as a line difference.

**Fix.** `lib/keyless-multiset.mjs` folds per BUILD and divides by the decoded
piece list; where the text does not decode or does not cover our pieces, it falls
back to the build's own row quantities and says AMBIGUOUS only when those are
uneven. Pinned by 26 tests in `tests/keylessMultiset.test.mjs`, including the two
production shapes above and the `5535 is its own model` rule. Every one of the
three fold rules was proved RED against the previous fold before it was changed —
the counts in the Symptom are that red run.

**Measured, run `34191920800` + `34191922821` (both 2026-09-08, 14:0x +08).**
136 keyless documents: **126 identical, 6 different, 4 undecidable.** The two
scripts agree cell for cell.

**Ref.** `fix/keyless-sofa-desc2-fold`, 2026-09-08. Follows `docs/bugs/0695`.
