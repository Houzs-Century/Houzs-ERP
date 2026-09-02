## The mobile floor-plan tiles were view-only, so a wrong Display floor plan could not be removed or replaced [medium]

<!-- area: Projects + PMS + fair report -->

**Symptom.** Owner, 2026-08-26: "display floorplan i cant remove existing file
using mobile. fix it."

**Root cause (traced).** Two rules that are each defensible met in a place where
they leave no exit:

1. `MobilePMS.tsx` `FloorPlans` renders the Display / 3D / 2D / Unfilled /
   Filled plan tiles with exactly ONE interaction — the whole tile is a
   `role="button"` that calls `openPlan(files, label)` and shows the lightbox.
   Only the Filled tile ever had an upload button; NO tile had a remove.
2. The tasklist rows — which DO carry the file chips and their `×`, gated on
   `canRemoveFile = canAttach && can("projects.manage")` — are hidden for every
   mobile cohort. `TasklistSectionView` renders behind
   `!isSalesExecMgr && !(isDriverCrew || isStorekeeper) && !cohortOps &&
   !cohortMgmt && !isPurchaserView`, described in its own comment as "a safety
   fallback that shouldn't occur in practice".

And "Display Floor Plan" matches no tile in `SALES_DOC_TILES` or
`CREW_DOC_TILES`, so the `DocTiles` card — the one component that has
`canDeleteFiles` — never renders it either. Every surface that can delete the
file is hidden on a phone; the one surface that shows it cannot.

**Fix.** The plan tiles get the same per-file chip + `×` the tasklist and the
stock-transfer rows already use, hitting the same
`DELETE /api/projects/checklist/attachments/:attId`, so all three surfaces stay
one file. Gated `canDeleteFiles = canWrite && can("projects.manage")` — the PC
rule and `DocTiles`' rule, unchanged, and `canWrite` already folds in
`!archived`. Chips render only for real task attachments (`taskPlanAtts`), never
for the legacy project-level plans the Unfilled/Filled tiles fall back to: those
live in a different store and this endpoint would not find them. The Display
tile also gains the Upload / "+ Add / replace" button the Filled tile had, since
removing a wrong plan with no way to upload the right one is half a fix; it
auto-submits for review like every other reviewable doc.

Both new controls `stopPropagation()` — without it the tap bubbles to the tile
and opens the lightbox instead.

**Ref.** fix/mobile-floorplan-remove, 2026-08-26.
