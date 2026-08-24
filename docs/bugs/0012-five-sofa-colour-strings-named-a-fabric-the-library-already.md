## Five sofa colour strings named a fabric the library already held [medium]

**Symptom** - after the shared matcher landed and 18 missing colours were
created, `refresh-sofa-colours.mjs` still could not resolve 31 migrated sofa
lines across 13 colour strings. The create script had been run to APPLY the
same day, so the assumption was that the remaining 13 were fabrics nobody had
entered yet.

**Root cause (traced, not guessed)** - a prod `DUMP=1` dump of
`scm.fabric_colours` (probe-fabric-colours, run 31405758677) shows the library
DOES hold the fabric for 6 of the 13 strings / 19 of the 31 lines. Nothing was
missing; the document writes the identity a different way than the library
stores it, in four shapes no lexical rung can bridge:

- the colour NUMBER is absent - "Modenza-Houston Cream" vs MODENZA-01, whose
  label already reads "MODENZA-01 HOUSTON CREAM"
- the SERIES letters are absent - "141-1" vs CH141-1, "9226-13" vs
  ARMANI J9226-13 WARM GREY
- the BRAND is written instead of the series code - "Harring 02# Beige" vs
  HIRRING GD8371-02# BEIGE
- the number TRAILS the colour name instead of leading it - "Phoenix-oyster1"
  vs PHOENIX-1 OYSTER. This one is the sharpest evidence: PHOENIX-1 OYSTER was
  created by create-missing-sofa-fabrics at 14:57 and the string was STILL
  unresolved in the 15:23 dry-run, so creating it had never been the fix.

Widening a rung to cover these would have to let a query match a library key it
shares no number with, which is the exact door the digit guard closes after it
bound B0315-27 -> BO315-2 and HR805-20 -> HR805-40.

**Fix** - `COLOUR_ALIAS` in `backend/scripts/lib/fabric-colour-match.mjs`: five
named facts, each carrying its document string and live line count, resolved
against the live library at index-build time so an entry whose row is absent
goes inert rather than binding to nothing. It runs LAST, only after every
lexical pass returned null, so it cannot displace an existing answer - verified
by replaying all 61 bindings from dry-run 31403271270 against the real prod
library: 61 unchanged, 0 changed. Unresolved fell 31 -> 12 lines, 13 -> 7
strings.

The remaining 7 strings are NOT library gaps and must stay blank: "03#Straw" /
"03-Straw#" are ambiguous between HIRRING GD8371-03# STRAW and HIVE
GD2034-03# STRAW; "J9833-2" is J9883-2 with two digits transposed; "Beetex
harring gd 8371" and "ZanoLeather" name a series with no colour chosen;
"Bottom Use Nylon Fabric" is a construction instruction; "ninja - 02,03,07,09"
is a choice the salesperson never narrowed.

**Ref** - fix/unresolved-sofa-fabrics, 2026-08-10
