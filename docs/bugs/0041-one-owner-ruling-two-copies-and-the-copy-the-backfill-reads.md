## One owner ruling, two copies, and the copy the backfill reads had drifted [low]

**Symptom** - `NO HOLES ON STICHING` (and `NO STICHING`) arrived at
`backfill-specials-into-variants.mjs` as UNMAPPED and reached the ERP as no
picker tick at all, while `NO STICHING IN SITTING AREA` on the next slip mapped
fine. Both are verbatim from `data/ac-outstanding-so.json.gz`.

**Root cause (traced, not guessed)** - the `No notch on Seat Cushion` ruling is
implemented TWICE. `backend/scripts/lib/sofa-special-map.mjs:50-53` tests three
INDEPENDENT predicates - a negation, a stitch/hole/notch word, and a
seat/cushion word in which a stitch word ALSO counts:

```
yes: (s) => /\bno\b/.test(s) && /\bstitch\w*|\bstich\w*|\bholes?\b|\bnotch\b/.test(s)
  && /\bsit\w*|\bseat\w*|\bcushion\b|\bstitch\w*|\bstich\w*/.test(s)
```

`backend/scripts/data/special-order-phrase-map.json` - the copy the backfill and
the price audit read - expressed the same rule as ordered alternatives,
`\bno\b.*(stitch|stich|holes?|notch).*(sit|seat|cushion)` plus its reverse, and
dropped the stitch words from the third group. Two consequences: the phrase had
to contain three DISTINCT tokens in sequence, and a stitching word could no
longer stand in for the seat part. `no holes on stiching` satisfies the negation
and the hole word, then has nothing left for the seat group; `no stiching`
cannot satisfy both word groups from one token. The lib matched both, the JSON
matched neither, and only the JSON is wired to the backfill.

**Fix** - the family's `yes` becomes three independent lookaheads, which is the
lib's semantics written in one regex, with the stitch words restored to the
seat-part group. Measured over every `/`- and newline-delimited fragment of the
three AutoCount exports (2,902 distinct): **2 phrases gained, 0 lost, and the
JSON and the lib now agree on all 2,902** - the disagreement count is the real
assertion, because the drift is the bug and a same-answer count of zero is what
"one ruling" looks like.

**Regression test** - `backend/tests/parseSofaGrammar.test.ts` gains a
`special-order phrase map: the notch family` block: eight real slip phrases that
must map, five that must not (the `plane`/`plain` veto, an AKEMI pillow SKU
whose name contains "7 HOLES", the glued `Nostiching` the parser cannot split),
and a case asserting the JSON and the lib give the same answer for every one of
them. Confirmed to FAIL on the pre-fix map (3 red) and pass after.

**The class, for next time** - when one ruling is implemented twice, the test
that matters is not "does copy A behave" but "do A and B agree". The two copies
here were written days apart by the same reasoning and still diverged on a
detail nobody would think to re-check: whether the same TOKEN may satisfy two
conditions. Ordered `a.*b.*c` is not the same predicate as `a AND b AND c`, and
turning one into the other silently narrows it.

**Ref** - 2026-08-11, PR #1952 (fix/specials-phrase-map-stiching).
