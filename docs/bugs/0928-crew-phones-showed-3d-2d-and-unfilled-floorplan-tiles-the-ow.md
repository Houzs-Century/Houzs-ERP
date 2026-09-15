## Crew phones showed 3D, 2D and Unfilled floorplan tiles the owner wants gone [low]

<!-- area: Frontend + mobile -->
<!-- status: fixed -->

**Symptom.** Owner, 2026-09-15, with a screenshot of a helper's phone on
"Selangor [Akemi] Bighome @ Sunway Pyramid" — the Floor plans & layout card
showing Display floor plan / 3D Design / 2D Design / Unfilled plan: *"untuk part
ni nk ada display flooprlan and stock out saja lain remove from helper storekeeper
and driver mobilepms"*. Crew are meant to see the Display floor plan and the
stock-out record and nothing else in that card.

**Root cause (traced).** Not a bug in the old sense — the card did exactly what
the previous rule said. `frontend/src/mobile/MobilePMS.tsx` `FloorPlans` built
five tiles and filtered them inline:

```
!(hideFilledPlan && t.key === "Filled") &&
!(hidePlanTiles && (t.key === "Unfilled" || t.key === "Filled"))
```

`hideFilledPlan` was the crew flag (`isDriverCrew || isStorekeeper`, owner
2026-07-21) and it hid ONE tile, Filled. 3D Design and 2D Design were added to
this card for every viewer on 2026-07-23 (the card respec) and Unfilled had
always shown, so a driver / helper / storekeeper saw four tiles. Nothing was
wrong on the wire; the owner's rule for crew changed.

**Fix.** The per-cohort tile rule moves out of the JSX into
`frontend/src/mobile/MobilePmsFloorPlanTiles.ts` (`floorPlanTileVisible`) so it
can be tested without rendering the 4,500-line component, and the crew arm now
returns `key === "Display"`: crew keep the Display tile (with its upload / remove
/ review controls) and the stock-transfer records listed under the grid, which
are not tiles and are untouched. The ops/office + purchaser rule (`hidePlanTiles`
→ no Unfilled / Filled) and the sales / mgt / BD rule (all five) are unchanged.
The `hideFilledPlan` prop is gone — `crewPlanView` replaces it at the one call
site. `MobilePMS.tsx` is at its file-size ceiling (4,491), so the edit was made
net-negative (4,490).

Pinned by `frontend/src/mobile/MobilePmsFloorPlanTiles.test.ts`, four cases (crew
= Display only; crew wins over the ops gate; ops loses only Unfilled / Filled;
no gate = all five). **Proved RED on the unfixed rule**: with the module holding
the previous semantics, `npx vitest run src/mobile/MobilePmsFloorPlanTiles.test.ts`
→ `expected [ 'Display', '3D Design', '2D Design', 'Unfilled' ] to deeply equal
[ 'Display' ]`, 2 failed / 2 passed; with the fix, 4 passed. `tsc -b` clean;
lint at or under ceiling.

**Ref.** fix/crew-floorplan-card-display-stockout-only, 2026-09-15.
Guide: `docs/modules/projects-pms.md` — "Desktop and mobile files that must
change together" gained the tile-rule row.
