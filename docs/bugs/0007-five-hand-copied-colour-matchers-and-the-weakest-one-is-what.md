## Five hand-copied colour matchers, and the weakest one is what production stored [high]

**Symptom** — 138 migrated sofa/bedframe lines carry no resolved fabric while
their AutoCount Desc2 names one. A live prod scan on 2026-08-10 put it at 223
lines / 92 distinct colour strings that the writers could not bind, against a
library that already holds 133 series / 724 colours.

**Root cause (traced, not guessed)** — `findColour` existed FIVE times, one
hand-written copy per script, and they had drifted apart.
`import-ac-outstanding-so.mjs` had grown a typo-fold index, a transposition
pass and an edit-distance pass; `refresh-so-variants.mjs`,
`refresh-po-variants.mjs`, `import-ac-outstanding-po.mjs` and
`import-ac-so-linked-pos.mjs` were still exact-index-only, and
`repair-leaked-sofa-lines.mjs` matched the raw name. **The refresh scripts are
what WRITE the migrated lines**, so the weakest copy decided what production
holds — every improvement made to the importer's copy since #1806 never reached
the rows. Exactly the class `CLAUDE.md` and the `parse-sofa` entry below already
name: "Extracted verbatim" that was not verbatim.

**And the fuzzy tail was silently swapping fabrics.** Measured against the live
library, the inherited transposition / edit-distance / prefix passes bound
`B0315-27` -> `BO315-2`, `B0315-29` -> `BO315-2`, `HR805-20` -> `HR805-40`,
`Chantic141-5` -> `CHANTIC-141-2`, `GD8371-03` -> `GD8371-02` and `STAR-10` ->
`STAR 01`. Every one is a real fabric replaced by a DIFFERENT real fabric, at
`high` confidence, with nothing on the order to say so — worse than a blank,
because a blank gets fixed by a human and this gets upholstered.

**Fix** — one `backend/scripts/lib/fabric-colour-match.mjs`, imported by all
six. Its ladder is purely lexical (drop a parenthesised name, treat `#` as a
separator, drop the trailing colour NAME, drop spaces, pull SERIES+NUMBER out of
prose, pad a one-digit tail, fold typos) and every rung only ADDS a spelling
with the untouched original tried first. Two rules carry the weight:

1. **Collapse doubled letters BEFORE reading letter-O as zero.** O->0 first
   turns `BOO315` into `B00315`, whose doubled character is a ZERO, so the
   collapse yields `B0315` and every `BOO*` spelling misses.
2. **The fuzzy passes may correct LETTERS and may never move a DIGIT.** Digits
   are compared in a mark space where letter-O is neither letter nor digit, so
   `BO315` and `B0315` still agree while `10` and `01` do not. A library LABEL
   under three characters is no longer matchable either — the SF series labels
   its colours `"01".."19"`, so a bare `"03"` was claiming `SF-AT 03`.

`tests/fabricColourMatch.test.ts` is the golden test: real document strings
against a faithful slice of the real library, with every mis-bind above pinned
as an explicit null.

**The class, for next time** — when a rule is copied into a second script,
copy the FILE, not the lines. Five copies of one parser means the surface a fix
lands on is whichever copy you happened to open, and the one nobody opened is
usually the one that writes.

**Ref** — 2026-08-10, PR #1893 (fix/sofa-colour-matching).
