## One physical fabric series, two library rows, and a merge that would have deleted the better half [med]

**Symptom** - the fabric picker offered the same series twice (`HR805` and
`FABRIC HR805`, `ARMANI J9226` and `J9226`), and any report grouping by
`fabric_id` split one series' history down the middle. 32 duplicate pairs across
a 140-series library.

**Root cause (traced, not guessed)** - `refresh-sofa-colours.mjs` bound
`HR805-90` to `FABRIC HR805` and `HR805-30` to `HR805` in the same run: the
library already held both spellings, and nothing forced a writer to pick one.
Detection is by shared colour CODE, never by series name - naming alone misses
`AVANI` / `AVANI 01` and proves nothing the colours do not already prove.

**Fix** - the owner decided on 2026-08-11: "合并，按引用数多的那边" - merge, and
the side production references more survives.
`backend/scripts/merge-duplicate-fabric-series.mjs` gained a `MODE=apply` path
it deliberately did not have before.

**The trap the implementation had to avoid, and this is the entry.** A merge
that removes the losing `fabric_library` row is a DELETE, and the owner's rule
is that nothing is deleted, only cancelled. So the loser is **superseded**:
`active = false`, its label stamped with what absorbed it, its colour rows left
attached so a historical document still resolves.

That alone is not enough. Superseding also hides every colour hanging off the
loser from the picker, and **reference count does not know which side is better
curated**. `GD8371` wins over `HIRRING GD8371` on 14 live lines to 9 - but
`GD8371` holds ONE colour, labelled literally `FABRIC`, while `HIRRING GD8371`
holds TEN properly named ones, and only one colour code is shared. A naive
"follow the reference count" merge would have removed nine named colours from
the picker and repointed the live lines sitting on them to a series that cannot
express them.

So every pair is classified from the data before anything is written: `LOSSLESS`
(every losing colour has a counterpart on the winner) applies; `REFUSED-LOSSY`
(the loser holds colours the winner does not) is **held and reported**, and only
merges under an explicit `MOVE_COLOURS=1` that re-parents those colours onto the
winner first. The repoint reaches every arm that can name a series - four at the
time of this entry (SO, PO, GRN, DO) - because a merge that writes two of them
leaves the other two pointing at a superseded row, which is the same unswept-arm
shape #1964 found in the GRN snapshot. *(Corrected 2026-08-13: the arm list is
`ARMS` in `backend/scripts/lib/fabric-write.mjs` and is fifteen now. The "four"
above is what this PR shipped, kept as the record; do not read it as the current
count - read `ARMS`.)*

**What is NOT in the 32, and is not being guessed at** - `CH141` vs `CHANTIC`
and `NX` vs `NX016` share ZERO colour codes, so a colour-code detector is
structurally blind to them. Folding them in on a naming hunch is exactly the
"let a query match a key it shares no number with" move the digit guard exists
to prevent. They are printed as STILL OPEN on every run and left to the owner.

**Lesson** - "the side with more references wins" is a rule about *documents*,
and it says nothing about which row a human curated better. When a tie-break
optimises one axis, check what it silently trades away on another before you let
it write.

**Ref** - 2026-08-11, PR #1972 (fix/fabric-series-merge). Prod evidence:
read-only run 31450029537, PLAN 31452278722, APPLY 31452408610 (29 of 32 pairs
merged, 28 lines repointed, 140 -> 111 active series, 3 pairs HELD as lossy).
Full numbers in `docs/duplicate-fabric-series-merge.md`.
