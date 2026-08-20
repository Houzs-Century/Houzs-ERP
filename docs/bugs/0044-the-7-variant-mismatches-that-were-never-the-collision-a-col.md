## The 7 variant mismatches that were never the collision: a colour left unresolved [low]

**Symptom** - after the collision was fully repaired, 7 migrated bedframe SO
lines still disagreed with their own AutoCount text. They had been counted since
the first diagnostic and never named, so nobody could say what they were.

**Root cause (traced, not guessed)** - one class, not seven problems. In every
one of the 7 the ONLY disagreeing axis is `colourId`, the stored value is
**NULL**, and the fabric matcher resolves the line's own text today:

```
HC-SO-009031 "Cream/Divan10/Gap13"                      -> KS-02
HC-SO-009031 "sliver/Divan10/Gap13"                     -> KS-15   (misspelt silver)
HC-SO-009614 "HC151-17/8inch+NoLeg/Gap14inch"           -> PC151-17 (HC typed for PC)
HC-SO-011289 "divan:10inch+noleg/PC151-101"             -> PC151-11
HC-SO-003154 "...Col:STAR-09"                           -> STAR-09
HC-SO-003154 "...Col:STAR-10"                           -> STAR-10 NAVY
HC-SO-010791 "...col:MB-04"                             -> MB-04
```

Every gap/divan/leg/size axis agrees. These are lines whose colour could not be
resolved when they were written and can be now, because the shared matcher and
the fabric library have both grown since (#1893, #1902). **Nothing is corrupt:
NULL means "not bound", which is honest.**

**Fix** - none applied, deliberately, and this is the finding rather than a
deferral. Two of the seven are why: `STAR-10` resolves to `STAR-10 NAVY`, one
half of the duplicate library pairs Section C censuses, so auto-filling would
bind a document to whichever spelling happened to win; and `PC151-101` resolving
to `PC151-11` MOVES A DIGIT, which is exactly what the shared matcher was
written to refuse (#1893). A 7-row backfill is not worth either risk without the
owner ruling on the duplicate pairs first.

**Ref** - 2026-08-11, PR #1964. Prod evidence: diagnostic run 31431814091,
Section B.
