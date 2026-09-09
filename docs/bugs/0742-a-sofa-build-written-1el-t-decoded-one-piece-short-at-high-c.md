## A sofa build written 1EL/T decoded one piece short at HIGH confidence [high]

**Symptom.** `[ 1EL/T(32") + 2ER(32") / COL: GD2034-03# STRAW ]` — a chaise and
a two-seater with a raised right arm — decoded to `["2S"]`. One piece, not two,
with no placeholder, no flag and `conf: "high"`. Ten distinct book texts on
**42 rows across all six document types** read this way.

Found while fixing `docs/bugs/0740`: the `Clr:` fix let one of these lines
decode for the first time and it decoded WRONG, which is how the shape became
visible at all. It is NOT caused by that fix — the eight other texts below have
been reading short since the cutover, under `COL:`, which the reader has always
known.

**Root cause (traced, and reproduced against the committed cut).** `1EL/T` is
`1ELT`, the chaise — the owner's own spelling, 2026-09-04, *"ELT is L, the
chaise"* — with a slash typed inside the token. `scripts/lib/parse-sofa.mjs`
protects `C/T` and `NA/LT` from the slash-SPLITTER and has never protected this
one, so the segment is cut in two:

```
"1EL/T(35\")+ 2ER(35\")"   ->   segment A: "1EL"
                                segment B: "T(35\")+ 2ER(35\")"
```

Segment B holds the `+`, wins the ordering, and decodes on its own: `T` is
swallowed by the single-letter arm of `NOISE` and `2ER` alone assembles to a
whole `2S`. The chaise is simply gone.

**The guard that exists for this could not see it.** The leftover-segment guard
at the end of `parseSofa` demotes a build to placeholder when another segment
still looks like structure — but it only inspects segments containing a `+`,
and `1EL` has none. So the line shipped at HIGH confidence rather than falling
to the honest placeholder. Same class as `HC-SO-000814` (`(1 ELT / T + NA
+2ER)`), and the reason that guard was written; this shape slips under it.

**Fix.** `1EL/T` is rewritten to `1ELT` before the slash split, beside the
`C/T` and `NA/LT` guards already there. `1ER/T` is deliberately NOT rewritten —
the owner named `ELT` and `2ER` and nothing else, and no `ERT` arm is invented
here; `parseSofaClrAndLeg.test.ts` pins `1ER/T` at the reading it has today so a
later widening has to come with his word.

**Measured over the committed cut (`ac-reconcile-truth.json.gz`,
`2026-09-09T00:18:49Z`), all 9,029 sofa Desc2 on all six document types: 42 rows
move, 10 distinct book texts, and every one recovers a chaise** — SO 8, PO 6,
GR 6, DO 8, IV 8, PI 6. Six texts went from a wrong build to the right one
(`["2S"]` -> `["L(LHF)","2A(RHF)"]`, `["2A(LHF)","1A(RHF)"]` ->
`["2A(LHF)","L(RHF)"]`, `["2NA","CNR","2A(RHF)"]` -> the same with its leading
`L`); four went from unreadable to readable. No row loses a piece.

**WHAT THIS WILL DO TO THE TALLY, said before anyone reads it as a surprise.**
The ERP's own sofa lines were written by THIS decoder at the cutover, so a
document whose build was imported as `2S` now has a book that reads
`L + 2A(RHF)` — and the compartment axis will report a difference where it
reported agreement. That is the defect surfacing, not a new one: the ERP holds a
sofa one piece short. The owner's standing rule is 「一律跟账本」, so the book's
reading is the right side, and the correction belongs in
`data/sofa-compartment-corrections-2026-09.json` under his eye rather than in a
reader that goes on agreeing with its own mistake.

**Proved RED first.** `backend/tests/parseSofaClrAndLeg.test.ts` ran
**`13 failed | 4 passed (17)`** against the reader as it stands on the merge
base, and this defect's own failure printed the production reading:
`AssertionError: expected [ '2S' ] to deeply equal [ 'L(LHF)', '2A(RHF)' ]`.
After: `4 files, 122 passed (122)` across the new suite, `parseSofaGrammar`,
`parseSofaUnlabelledColour` and `variantInchesNoLeg`.

**Ref.** fix/sofa-clr-leg-reader, 2026-09-09. Related: `docs/bugs/0740`,
`docs/bugs/0741`.
