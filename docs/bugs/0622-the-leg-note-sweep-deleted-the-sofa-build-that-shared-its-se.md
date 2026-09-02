## The leg-note sweep deleted the sofa build that shared its segment [medium]

**Symptom.** A sofa order whose AutoCount Desc2 spells the build out in full
came into the ERP as ONE bare `{model}-1S` placeholder, with the remark
`SOFA UNPARSED ... no structure tokens` — as if nothing had been written. The
text was `2+C+1(35'INCH)FULLY COVER NO LEG/COL:BOOBOO315-1/25`, and `2+C+1` is
a build the decoder reads correctly everywhere else. HC-SO-011755, company 1.

**Root cause (traced).** `backend/scripts/lib/parse-sofa.mjs`, the leg sweep.
`docs/sofa-import-handoff.md` §2.5 lifts any sentence carrying `leg` out of the
text whole, so it can never be misread as a seat depth. It was lifted with
`[^\/\n]*\bleg\b[^\/\n]*` — `[^\/\n]*` on BOTH sides, which is the WHOLE slash
segment. When the floor writes the leg note after the build inside the same
segment, the backward reach walks straight through the piece list and deletes
it. `/[^\/\n]*\bleg\b[^\/\n]*/i.exec("2+C+1(35'INCH)FULLY COVER NO LEG")`
returns the entire string, build included; the structure loop then finds no
tokens left and the importer falls back to the placeholder.

Observed, not reasoned: `backend/scripts/probe-sofa-placeholder-desc2.mjs`
printed the Desc2 behind every `-1S` placeholder on prod (company 1, ALL_SO=1,
run 33657880776) and this was the only one of the 119 that carried a readable
build. Diffing the decoder over the whole committed corpus
(`backend/src/services/autocount-sofa-corpus.ts`, 697 real AutoCount lines) before and
after the fix changes exactly 1 row and it is this one.

Same class as the NOISE regex that swallowed a bare `C` and a bare `R`
(`docs/bugs/0001-a-bare-c-corner-was-filtered-as-noise-so-49-sofa-builds-lost.md`): a sweep written for prose reaching into the piece list.

**Fix.** The backward reach stops at structure punctuation —
`[^\/\n+)]*\bleg\b[^\/\n]*`. A piece list only ever ends on `+` or `)`, so
refusing to cross either leaves every leg phrase in the book intact: measured
over all 20 distinct leg-bearing segments in the committed corpus, exactly one
match changes. The leg request is still lifted into `specials` — it is never
deleted. Pinned by five cases in
`backend/tests/parseSofaGrammar.test.ts`, two of which were proved RED on the
unfixed tree (`2 failed | 80 passed`) and green after
(`92 passed` with `parseSofaUnlabelledColour.test.ts`).

**What this does NOT do.** The rows already written stay on their placeholder —
the decoder is only consulted at import. Re-deriving them is a separate,
gated repair and is not in this PR.

**Ref.** diag/sofa-placeholder-decode, 2026-09-02.
