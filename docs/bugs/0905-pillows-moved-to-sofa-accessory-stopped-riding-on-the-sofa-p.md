## Pillows moved to Sofa Accessory stopped riding on the sofa PO in MRP [high]

**Symptom.** None reported yet — found when the owner asked, the same day as the
move, that Sofa Accessory "park under sofa ... under same SO ... open the same PO"
(2026-09-14). From the recategorisation run (34847145059) onwards, SQUARE PILLOW,
LONG PILLOW and the seven cushion / arm-rest models were FABRIC_ACCESSORY, and on
the MRP page they no longer appeared under their sofa order or joined its PO; they
fell into the Others tab.

**Root cause (traced).** The Sofa tab pulls a sofa order's covers in two places in
`frontend/src/pages/scm-v2/Mrp.tsx` — the visible riders and `gatherSofa`, which
builds the Proceed PO batch — and both filtered `category === 'ACCESSORY'`. The
engine reports the catalogue category (`mrp.ts`, `prod?.category ?? catFromGroup`),
which for those SKUs became `FABRIC_ACCESSORY`, so neither matched.
`rowBelongsToView` then claimed them for Others by exclusion. On the server,
`groupKeyFor` fell to its default branch, which under Per-SO splits every
non-sofa category off the sofa's PO.

**Fix.** `mrp-sofa-accessory.ts` cuts FABRIC_ACCESSORY SKUs per SO and adds them to
the Sofa tab, so `groupBySo` puts each under its order's row and Proceed PO sends
it with the sofa; Others no longer claims them. `groupKeyFor` keys
`fabric_accessory` as `sofa` in both modes. Tests: `mrpSofaAccessory.test.ts`,
`mrpSofaAccessoryPage.test.tsx`, `poGrouping.test.ts` (Sofa Accessory block).

**Lesson.** A new category is also a new value for every `category === X` on the
MRP page. `docs/bugs/0894-sofa-accessory-lines-would-refuse-to-post-the-category-had-n.md`
was the accounting half of the same move.

**Ref.** feat/mrp-sofa-accessory, 2026-09-14.
