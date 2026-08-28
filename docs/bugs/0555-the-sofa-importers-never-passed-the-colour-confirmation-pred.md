## The sofa importers never passed the colour-confirmation predicate [low]

**Symptom.** A colour-first sofa Desc2 whose code the fabric library DOES hold
— `BO315-21 (PEARL)/28"/2L` shape — imported with no colour at all, while the
same string handed to the sofa variant backfill read `BO315-21` correctly.

**Root cause (traced).** PR #1998 (2026-08-11) added `opts.knownColour` to
`parseSofa` — an unlabelled colour code is read only when the library confirms
it — and wired it into `backfill-sofa-variants-from-desc2.mjs`. The three
importers (`import-ac-outstanding-so.mjs:250`,
`import-ac-outstanding-po.mjs:204`, `import-ac-so-linked-pos.mjs:219/:222`)
kept calling `parseSofa(d2, model, reclOK)` with no fourth argument, so the
confirmed-unlabelled path never ran at import time. Invisible in August
because the old corpus almost always labelled the colour (`COL: …`); the
2026-08 staff entries write colour FIRST with no label, which made the gap
visible on the re-import dry-run.

**Fix.** Each importer builds `knownColour` from the `fabric_colours` index it
already loads and passes `{ knownColour }` at every `parseSofa` call site (4
sites across the three files). The #1998 contract is untouched — an
unconfirmed code still imports blank, pinned by
`tests/parseSofaUnlabelledColour.test.ts` (a colour-by-position shortcut was
attempted in this same branch and REMOVED when those tests refused it). The
same PR teaches the grammar the 2026-08 new-style piece spelling
(`1A(LHF)+C+2A(RHF)`, bare-end `2A+1A` chains) — real snapshot lines pinned in
`tests/parseSofaGrammar.test.ts`, probed RED before the grammar change (all
held as `token "1A"`) and green after.

**Ref.** feat/sofa-parser-colour-first, 2026-08-28.
