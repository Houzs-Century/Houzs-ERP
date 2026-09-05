## The 1ELT sofa build was decoded from the spelling, not the shorthand [medium]

**Symptom.** HC-SO-000814 and its purchase order HC-PO-000254 carried the sofa
build `1ABOX(LHF) + 1NA + 2A(RHF)`. The AutoCount text on both lines is
`[ (1 ELT / T + NA +2ER) (28") / COL: J9883-1-1 PAMA]`. The owner, 2026-09-05:
「1ELT 就是L来的」 — the slip token `1ELT` IS the chaise, `L` — and 「1Abox 是
1NALT」 — `1ABOX` is what a slip writes as `1NALT`. So the first piece was the
wrong piece on both documents: a chaise had been recorded as a box arm.

**Root cause (traced).** Nobody decoded this line; its shape was read off the
letters. `backend/scripts/data/sofa-compartment-corrections-2026-08.json` said
so in its own `why` — *"the ELT/T spelling has no parser rule"* — and that entry
is where the build came from. `fix-modenza-label-and-5526-pieces.mjs` was then
written to MINT `5526-1ABOX(LHF)` and `5526-1NA` specifically so that reading
could be applied; its header states the build "decodes to 1ABOX(LHF) + 1NA +
2A(RHF)". A guess became a minted SKU, and the SKU then made the guess look
settled. The 2026-09 round copied it onto the sales order to make the two sides
agree, so one guess ended up on two documents.

The reason there was nothing to contradict it is measurable. Running
`scripts/lib/parse-sofa.mjs` on the REAL string returns `pieces: []`,
`conf: "low"`, `why: ["note \"T\"", "structure split across segments (\"(1 ELT\")"]`
— the stray `/ T` splits the structure, so the decoder declines. Remove only
that stray token and the same parser answers `["L(LHF)","1NA","2A(RHF)"]` at
`conf: "high"`, and `1NALT` in the same position answers `1ABOX(LHF)`. The
parser had already agreed with the owner on both halves since 2026-09-04; the
data file had not, and no check compared them.

This line has no photograph in the account book — 0 rows in both photo manifests
and the full-book export reported 0 failed lines — so the text and the owner's
ruling are the only evidence that exists.

**Fix.** `5526-L(LHF)` opened by `backend/scripts/open-5526-chaise.mjs`, all
three steps of `docs/sofa-import-handoff.md` §3.2 — `allowed_options`, the SKU
copied field-by-field from the model's sibling `5526-1A(LHF)`, and the master
pool (already carried `L(LHF)`, so nothing was appended). Both corrections files
re-pointed to `L(LHF) + 1NA + 2A(RHF)`; the 2026-08 entry was edited in place
rather than overridden, because the files are all loaded on every run and
`FILE=2026-08` plans that round ALONE, which would have silently reverted the
ruling. Money did not move: the price rides the first piece and the script
asserts both money columns per document, before and after.

`5526-1ABOX(LHF)` was NOT deleted — nothing else in company 1 uses it (measured:
1 SO line, 1 PO line, 1 GRN line, 1 DO line, all this one build, 0 inventory
movements), so it is now unreferenced and the owner decides whether it goes.
`558-1ABOX(LHF)` and `822-1ABOX(RHF)` are different models and are untouched.

Two tests, both proved RED on the unfixed tree before they were made to pass:
`scripts/lib/parse-sofa.test.mjs` pins `1ELT -> L(LHF)`, `1NALT -> 1ABOX(LHF)`
and the real string decoding to nothing; `scripts/lib/sofa-corrections-source.test.mjs`
gains a guard that no document may be given two different builds, plus a check
that this build says `L(LHF)` on BOTH its documents. The second is the one that
catches this pair — the general guard keys on the document number and cannot see
a sales order contradicting the purchase order raised from it, which its comment
now says out loud.

Also corrected there: the round-size assertion had been RED on `main`, expecting
15 builds where the file holds 18. Three builds had been added without the number
following them, and the working-agreement workflow reports rather than blocks, so
the failure sat unread.

**Ref.** fix/5526-chaise, 2026-09-05.
