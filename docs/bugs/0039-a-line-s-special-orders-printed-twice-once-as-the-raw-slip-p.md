## A line's special orders printed twice — once as the raw slip phrase, once as the picker code the backfill derived from it [medium]

**Symptom** - `HC-SO-011733`'s lead line renders
`CH141-8-ARMY / SEAT 30 / LEG DEFAULT / SPECIAL: BACKCUSHIONCHANGE8030 + Change
8030 Backcushion + Wooden Arm`. One request, printed twice. The other five
lines of the same document are clean.

**Root cause (traced, not guessed)** - the DATA is correct and must stay.
`backfill-specials-into-variants.mjs` (PRs #1926/#1940) is deliberately
MERGE-ONLY and machine-asserts that it never drops a pre-existing entry (the
owner's 不可以删只可以 cancel rule), so a line whose slip already carried the
parser's glued `BACKCUSHIONCHANGE8030` now also carries the picker code
`Change 8030 Backcushion` the backfill mapped it to. `buildVariantSummary`
(`scm/shared/variant-summary.ts`) maps `variants.specials` 1:1 into the SPECIAL
segment with no dedupe and no validity filter, so both print.

**Fix** - display-layer only, no stored data touched. `foldRedundantSpecials`
hides an entry when another entry in the SAME list is a strictly richer twin of
it — same identity, contains it, or is a re-ordering of its parts (`skey`, the
parsers' own dedupe key: letters and digits only, nilon≡nylon, so the display
agrees with the writer about what "the same phrase" means). Deliberately narrow:
**only a SINGLE-TOKEN entry is ever hideable**, so a machine-glued artefact can
be suppressed and an operator's multi-word request never can. Ranking picks the
survivor — longer identity, then more word-parts (so the owner's spaced picker
code beats the glued form), then original order — a strict total order, so the
richest member of a twin group always survives and the segment can never be
emptied. Verified by running the SHIPPED function over production: of **1,051**
lines carrying specials, **216** rendered a redundant twin and now do not; **0**
emptied, **0** live picker codes lost.

**Where the phrase map was NOT put, and why** - folding the remaining **26**
lines needs semantics, not lexicon: `NOSTICHINGINSITTINGAREA` beside
`No notch on Seat Cushion`, `BACKRESTCHANGE8030` beside
`Change 8030 Backcushion` (backrest≡backcushion is an owner ruling). Only
`backend/scripts/data/special-order-phrase-map.json` knows that. It is a Node
script data file; the browser needs it too, because the SO detail page
(`SalesOrderDetailV2.tsx:733`) recomputes the summary client-side and PREFERS
its result over the stored `description2`. Reaching it would mean a copy in the
Worker bundle and a copy in the browser bundle — a fourth and fifth copy of a
ruling that is already implemented twice and **already drifted** (the entry at
the top of this file). Twenty-six lines is not worth that, so the residual is
measured and reported rather than guessed at. If the owner wants it, the honest
shape is: one canonical file + a mirror test, not two hand-kept copies.

**Also fixed on the way** - `backend/src/scm/shared/variant-summary.ts` and
`frontend/src/vendor/shared/variant-summary.ts` are byte-identical hand copies
with **nothing** guarding them, and this fix had to land in both. A byte-equality
test now pins them (`frontend/src/vendor/shared/variant-summary.test.ts`), which
is also the first test this module has ever had for its specials output.

**Ref** - 2026-08-11, `fix/so-list-po-and-specials-display`.
