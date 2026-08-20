## Two authors could not pick a migration number without racing each other [medium]

<!-- area: Deploy, CI, migrations -->

**Symptom.** `0300` was taken twice inside thirty minutes on 2026-08-18, then
`0302` was taken while the rename was still in review. Three renames for one
change. The duplicate-number test caught each one — it is a good gate and it
worked — but catching a collision is not the same as not having one.

**Root cause.** A sequential number is CLAIMED at merge and CHOSEN at authoring
time. With ~10 PRs open at once, every branch picks the same "next free" number
off `ls *.sql`, and all but the first must rename. The renames are not free
either: pg-migrate matches by FULL filename, so it must be a rename and nothing
else — an edited body reads to it as an orphaned tracker row plus an unknown
file to apply.

**Fix.** New migrations are named by UTC timestamp — `npm run migration:new --
<slug>` mints `20260818T0345_<slug>.sql`. A timestamp is chosen at authoring
time and is already unique, so there is nothing to race. It needs no runner
change: pg-migrate reads the directory, `.sort()`s by filename and keys its
tracker on the full name, and `2026…` sorts after every `0…` file, so ordering
is preserved. Rails, Django and Flyway all moved to timestamps for this reason.

**Existing numbered files are NOT renamed and must never be** — the rename would
re-run their SQL. The numbering test now skips timestamp names (a bare `\d{3,4}`
would file every one of them under a phantom number "2026") and still enforces
uniqueness on everything numbered.

**Same PR, the other half of the friction.** `docs/generated/*` is regenerated
per PR and tracked, so any two PRs conflict on it: measured across the 97 live
branches, 21 conflict on `bug-index.md` and 13 conflict on nothing else at all,
and nineteen commits in that backlog exist only to regenerate after a merge. A
generated file has no merge — `union` duplicates rows and picking a side leaves
a stale file — so a `regen` merge driver takes either side and rebuilds from
source, which is the only correct answer.

Ref: 2026-08-18.
