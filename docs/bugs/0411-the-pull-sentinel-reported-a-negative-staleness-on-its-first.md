## The pull sentinel reported a NEGATIVE staleness on its first live run [low]

**Symptom.** The AutoCount pull sentinel's first production dispatch
(2026-08-19, run 32255847872) printed:

    pull_checkpoint = 2026-08-19T20:35:34.723 (-1d behind)

A checkpoint cannot be minus one day behind.

**Root cause.** `system_settings.pull_checkpoint` is a NAIVE timestamp — no
offset, no `Z`. The sentinel appended `"Z"` and read it as UTC. It is MYT
(UTC+8): 20:35 local is 12:35 UTC, and UTC then was 13:03, so the value is half
an hour old — but read as UTC it looks **7.5 hours in the future**, and
`Math.floor(-0.31)` is `-1`. A third of a day of timezone offset became a whole
negative day.

**Why it mattered little, and why it was still fixed.** The alarm was correct
either way (`-1 > 2` is false, so no false alarm), but the threshold silently
gained 8 hours of slop, and "-1d behind" is exactly the sort of output that
costs somebody twenty minutes at 3am.

**Fix.** The zone is NOT hardcoded — one observation is not a timezone. Instead
`normaliseBehind()` absorbs any offset in the real range (-12..+14): a value
reading up to 14h ahead cannot be stale and clamps to zero; further ahead than
that is its OWN alarm, because the next `getSince()` would ask for a window
starting in the future and skip everything before it. `daysSince` no longer
floors, since the floor is what turned a fraction into a day. The cost is stated
in the code and the guide: staleness carries up to 14h of slop, so the 2-day
limit really fires between ~1.4 and ~2.6 days — noise against a five-minute pull.

**How it was found.** By dispatching the workflow once against production, per
the CLAUDE.md rule that a `workflow_dispatch` workflow is not shipped until it
has run once and reported success. Reading the code would not have shown it; the
data had to.

**Ref.** `fix/sentinel-checkpoint-timezone`, 2026-08-19.
