## Two fabric tools would have undone each other forever, and the loop had no fixed point [medium]

**Symptom** — `normalize-fabric-codes` merged six LAMB VELVET colours into the
HYPHEN form on production on 2026-08-14 (`VERIFY PASS`). The very next plan from
`merge-duplicate-fabric-series` proposed moving the same series back to the
SPACE form:

```
KEEP  "LAMB VELVET"  0 live lines, 7 colours
DROP  "LAMB-VELVET"  0 live lines, 6 colours
  LAMB2002: "LAMB-VELVET-2002" -> "LAMB VELVET-2002"   (0 live lines move)
```

Applying it would have undone the colour merge, and the next colour run would
have undone that. Two tools, one library, **no fixed point**.

**Root cause — and NOT a bug in either tool.** The series merger picks the side
production references more, which is the owner's ruling of 2026-08-11:
*合并，按引用数多的那边*. Both sides of this pair carry **zero** live lines, so
the rule ties, and the tie-break below it — *the series holding more colours* —
answered a question the owner's rule never addressed. Colour count is a
heuristic; it happened to point away from the one thing that IS defined, which
is what `lib/fabric-code.mjs` says the series is called. Asked directly, the
parser is unambiguous: **both spellings parse to series `LAMB-VELVET`**, and
`seriesToken("LAMB VELVET")` returns `"LAMB-VELVET"`.

**Fix** — one tie-break inserted, and the owner's rule untouched above it: most
live references first, **then the side already spelled the way the parser spells
it**, then colour count, then shorter id. This is the rule the COLOUR merger has
always carried — *"the row already carrying the canonical id wins outright"* —
which the series merger never got.

**A near miss.** The first version asked `parse(seriesId)`, which wants a full
code (series + number) and answers `null` for a bare series id — so the
tie-break would have been dead on every pair and the script would have kept
behaving exactly as before. Nothing would have looked wrong. Caught by running
it against the real ids rather than reading it.

**Pinned by** `backend/tests/seriesMergeCanonicalTiebreak.test.mjs`: the owner's
reference rule still wins when references differ, the canonical side wins on a
tie either way round, colour count still decides when neither side is canonical,
and — the property that matters — whatever the merger keeps on a tie is what the
canonicaliser would have written.

**Class** — *the same rule in two places, disagreeing quietly.* Same family as
the twelve catalogue series that only one of two derivers knew about, fixed the
same day.

**Ref** - `fix/series-merge-canonical-tiebreak`, 2026-08-14
