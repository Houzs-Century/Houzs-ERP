## The file-size gate told you to "re-baseline", and there is no such operation [low]

**Symptom.** The inherited-debt block ends *"Whoever grows a file owns its
ceiling. Fix these where they were grown, or re-baseline."* Every reader who
took the second option went looking for a command that does not exist.

**Root cause.** `--update` calls `lowerCeilings`, which is
`Math.min(current, lines)` — it can only LOWER a ceiling, and only for a file
that already got smaller. Editing a number upward by hand is caught by
`findRaisedCeilings` and fails CI. Both behaviours are correct and both are unit
tested (`--update lowers a ceiling but will NOT raise one to clear a violation`,
`scripts/check-file-size-ratchet.mjs`). So there is exactly ONE way to clear this
debt — shrink the file — and the message named a second one that cannot be done.

**Measured, and it is why this is worth fixing rather than shrugging at.** Every
crossing happened between 2026-08-12 and 2026-08-14 — the ceilings were baselined
by #2139 on 2026-08-12, so the whole debt is three days old.

**Do not quote a total from here; run `node scripts/check-file-size.mjs`.** It
prints the aggregate now, which is the point of this change. Two readings taken
while writing this entry, hours apart, gave *14 files / 1,430 lines* and then
*13 files / 1,391*, and `frontend/src/pages/Projects.tsx` moved
14,996 -> 15,053 -> 14,987 -> 14,990 -> 15,056 -> 15,128 across six commits on a
single day. A number typed here would have been wrong before the PR merged —
which is the rule this repo already has about numbers in prose, applied to
itself.

`file-size` is not a required status check, so a PR that trips it merges, and the
next author inherits it. That is the mechanism; the total is just today's reading
of it.

Attribution to a specific PR was ATTEMPTED and is not reliable: most
first-crossings land on MERGE commits (one `merge: take origin/main (7 commits)`
crosses five files at once), which is where two histories joined, not where the
lines were written. **UNKNOWN**, recorded rather than dressed up — "fix these
where they were grown" is not currently answerable by this repo's history.

**Fix.** The message now names the real remedy and prints the aggregate, so the
debt carries a number every time the gate runs instead of being a list you scroll
past.

**NOT fixed here, and it is the owner's call.** Whether `file-size` should become
a required status check. It is the only thing that would stop this accumulating —
and it would also block merges on a ratchet that 14 files currently fail, so it
is a judgement about cost, not a defect to fix unilaterally.

**Ref.** 2026-08-15. Lesson: **an error message is part of the tool.** This one
sent readers to an escape hatch that the same repo's own unit test proves cannot
exist.
