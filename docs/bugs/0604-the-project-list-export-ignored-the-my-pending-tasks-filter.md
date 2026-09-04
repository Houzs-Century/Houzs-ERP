## The Project List export ignored the My pending tasks filter [high]

<!-- area: Projects + PMS + fair report -->

**Symptom.** Owner 2026-09-02, with a screenshot of each side: the Project List
filtered to Task = `SETUP & DISMANTLE DOCUMENTS`, status Confirmed and **My
pending tasks** ticked shows **10 rows / 10 records**; EXPORT hands back a
spreadsheet of the whole confirmed book, hundreds of rows out to 2027, most with
zeroed costing columns. *"it should export out list pending on this task not
list costing all. if i didnt filter anything and export u set will export all
costing as usual, but if have filter please follow filter"*.

**Root cause (traced).** `exportProjects` in `frontend/src/pages/Projects.tsx`
rebuilds the list query by hand instead of sharing it, and one line of that copy
read:

```ts
// my_pending intentionally OMITTED — export is the full filtered list.
```

So the export sent brand / year / month / from / to / section / task_pending /
phase / assigned_to_me / exclude_done / search / status — every chip except the
one the owner had ticked. With `my_pending` dropped, the server answered with
every Confirmed event that still owed Setup & Dismantle work rather than the ten
the screen had narrowed to. Diffing the two parameter objects out of the source
confirmed `my_pending` was the ONLY key present in the list query and absent
from the export; nothing else had drifted.

The comment is the whole bug: "export is the full filtered list" treats the
pending checkbox as a view preference rather than a filter, but on screen it
sits in the same toolbar as the rest and reads as one. An export that disagrees
with the screen it was taken from is a wrong document — worse than an obviously
empty one, because it looks complete.

**Fix.** The export sends `my_pending` like every other chip. The rule is now
the one the owner stated: the export is whatever the toolbar says, and an
unfiltered toolbar still exports everything.

Pinned by `frontend/src/auth/projectActionGates.test.ts`, which extracts both
parameter blocks from the source and asserts every key the list sends is also
sent by the export — so the next filter added to one cannot be forgotten in the
other. **Proved RED against `origin/main`** (`export drops: my_pending`) and
green on the fixed tree.

**Not changed:** the export still writes the full costing column set regardless
of the on-screen Columns selection, which is the owner's stated "export all
costing as usual" for the unfiltered case. Whether a filtered export should also
narrow its COLUMNS (e.g. to the picked section's outstanding tasks) is a
separate question, raised with the owner rather than assumed.

**Ref.** `fix/export-follows-filters`, 2026-09-02.
