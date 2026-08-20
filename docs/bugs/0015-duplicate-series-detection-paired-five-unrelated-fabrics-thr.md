## Duplicate-series detection paired five unrelated fabrics through "BR0WN" [low]

**Symptom** - the first prod run of merge-duplicate-fabric-series reported 41
duplicate fabric series pairs, among them 311 <-> A201, 311 <-> KS, 311 <->
M2402 and 311 <-> XQ#18. Those are five unrelated fabrics.

**Root cause (traced, not guessed)** - all five collided on one key, `BR0WN`.
`foldColour` maps letter-O to "0" (that is what puts BO315 and B0315 on one
key), so a colour whose label is only a NAME - "BROWN", "DARK BROWN", "WOOD
BROWN" - folds to a string containing a "0". The detector gated its keys on a
digit test run against the FOLD, which that fake zero satisfies, so a plain
colour name was admitted as a colour CODE and every series holding a BROWN
matched every other one.

**Fix** - run the digit test in MARK space (`markColour`, where letter-O is "@"
and only a written zero stays a digit), which is the space the matcher's own
digit guard already compares in. 41 pairs became 31, and all 10 that vanished
were false. The same pass added a written-tail pad before folding, because
"J9226-2" folds to "J92262" and nothing downstream can then tell the series
digits from the colour digit - which is why ARMANI J9226 / J9226, one of the
two duplicate pairs this work started from, had gone undetected. Final: 32 real
pairs, no false ones.

**Lesson** - foldColour is lossy by design and its output is not safe to ask
structural questions of. Anything deciding "is this a code or a name" must ask
markColour, not the fold.

**Ref** - fix/dup-fabric-series-detection, 2026-08-10
