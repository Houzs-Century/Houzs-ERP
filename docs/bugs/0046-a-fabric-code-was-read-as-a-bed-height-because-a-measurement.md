## A fabric code was read as a bed height, because a measurement rule had no left boundary [high]

**Symptom** - `HC-GR-005122-PO-009576` recorded `divanHeight 151"` and
`totalHeight 160"`. No bed is 151 inches tall. The same row carries
`colourId PC151-01`.

**Root cause (traced, not guessed)** - the parse rules of the shape *number,
then keyword* in `lib/parse-bedframe.mjs` began with a bare `(\d+)`. `\d+` will
start in the MIDDLE of a token, so the digits of a fabric code qualified as a
measurement:

```
"PC151 divan"     -> divan 151"     (the code's series number)
"PC151-01 divan"  -> divan 1"       (the code's colour suffix)
"PC151 LEG 4"     -> leg 151"       (instead of the 4" actually written)
```

The `-01` form is the dangerous one: it yields a perfectly plausible 1", so a
range check can never see it. Reachable by every consumer of the parser - both
importers and both refresh scripts - not by one arm.

**The attribution that did NOT hold.** The handover recorded this row as that
parser bug. It is not: the parent PO line's text is
`"Hydraulic2pcs12”inner/PC151-01/gap9"`, and BOTH the pre-fix and post-fix
parsers read it as divan 14" (inner + 2, per the owner's #1883 rule). The 151
cannot be produced from that text by either. Its origin is **unproven** - most
likely an earlier parser generation, this module having drifted twice before
(a808bf36, 60125216). The correction stands on different evidence: the value is
physically impossible and the parent PO line agrees with its own AutoCount text.
Two true findings, one false link between them.

**Fix** - a number now qualifies as a measurement two ways: it starts cleanly
after a delimiter, OR it carries an explicit inch marker. The second alternative
is load-bearing, not defensive - `HC-SO-012781` carries `Hydraulic2pcs12”inner`,
a real 12" inner depth glued to the word before it, and a plain left-boundary
guard silently dropped it. A fabric code satisfies neither. Eight rule sites.

Scale, measured after the fix: **1** GRN line out of 442 holds an out-of-range
axis. The SO arm reports 149 and the PO arm 42 lines whose axis equals a digit
run of their own colour, and those are **coincidence, not corruption** -
`legHeight 1"` beside `PC151-01` is a real 1" leg. The proof they are sound is
Section B: every SO mismatch against its own text is accounted for by the
collision (71) or by an unresolved colour (7), and none is a height.

**Ref** - 2026-08-11, PR #1964 (fix/variant-collision-remainder). Prod evidence:
diagnostic run 31431814091. Tests in `tests/bedframeVariantLineIdentity.test.ts`.
