## Sofa Desc2 instructions with digits and five real spellings read as unknown structure and killed their whole segment [medium]

**Symptom.** Owner, 2026-08-30, looking at HC-PO-010083 / HC-SO-013384: "为什么
进来的 Sofa 单全部都是 1S 1S 的呢？…它的 SKU 不可能是这样子的". The re-import
round left 103 of 547 sofa lines on the `{model}-1S` placeholder. 46 of them
have NO composition written in the book at all (faithful placeholder — nothing
to extract; both HC-SO-013384/5 are this class). The rest were parser gaps.

**Root cause (traced).** Run 33251287997's per-line decode log, all 103 lines
read. Two mechanisms in `backend/scripts/lib/parse-sofa.mjs`:
(a) segment glue strips spaces, so an instruction like "headrest change to
8030" becomes the single token `HEADRESTCHANGETO8030`; the rider rule refused
anything carrying a digit or the letters ARM/SEAT, so the token fell through to
`bad` and the WHOLE segment — sometimes the one holding real structure — was
abandoned. (b) five real book spellings had no arm: `1Console`→`1CT`,
`1EFL/1EFR`, `1R(P)`, letter-led bracket titles (`L2L(L+1NA+1NA+L)`), glued
`1B/S seater`, orphan second sizes (`(26/28'Inch)`), model riders
(`back rest (5540)`), and library-confirmable colour codes inside the
structure segment (`2S[P+P](32")B0315-Pearl`).

**Fix.** `INSTRUCTION_TOKEN` vocabulary (digit-tolerant, ≥6 chars) rides those
words as specials; new classification arms for the five spellings; colour
tokens are consumed ONLY when `opts.knownColour` confirms them (unconfirmed
stays fatal — the migration does not guess); `1R(P)` is rewritten before the
bracket→`+` conversion frees a mid-row P. The deliberately-ambiguous
`1 ELT / T + NA + 2ER` line STILL refuses (its gold pin was briefly broken by a
bare-`NA` arm during development and the arm was removed). 11 gold cases added
to `backend/tests/parseSofaGrammar.test.ts`, each quoting the real book line —
proved RED (11 failures) before the parser change, 82/82 after; the corpus
round-trip suites (71 tests) unchanged-green, and the corpus module itself is
input-only so it did not move.

Eight of the 103 placeholder lines carry real structure this recovers on the
next import/repair pass; the no-composition class stays placeholder by design
(the book wrote nothing — owner decides whether staff complete them in the ERP
or amend the book and resync).

**Ref.** fix/effective-status-honors-gates worktree, parser PR, 2026-08-30.
