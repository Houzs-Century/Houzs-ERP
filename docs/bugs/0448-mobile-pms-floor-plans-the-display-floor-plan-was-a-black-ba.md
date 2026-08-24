## Mobile PMS Floor Plans: the Display floor plan was a black banner with no preview, and every stock-transfer record showed a file name with no picture [low]

<!-- area: Projects + PMS + fair report -->

**白话.** 手机版「Floor Plans」卡里，Display 楼面图跟其他图不一样：它是一条黑色横幅，
只写「几个档」，看不到图本身；3D、2D、Unfilled、Filled 四张都有缩图，就它没有。
下面「Stock transfer record」那一排也一样，只有档名。现在 Display 变成一张正常的图砖
（跨满一行、自带预览），顺序改成 Display -> 3D + 2D -> Unfilled + Filled，库存转移纪录
每一列也加了可点的缩图。

**Symptom.** In the mobile Floor Plans card, the Display floor plan alone showed
no preview of what had been uploaded. It rendered as a dark full-width row
(`background: "#15161a"`) carrying an icon, a title and the text
`N files - tap to view / download`, while the four sibling tiles (Unfilled,
Filled, 3D Design, 2D Design) each rendered an 80px `R2Thumb` of the actual file.
The Display document is the one staff look at most, and it was the only one you
had to open to see. The `Stock transfer record` rows below had the same gap:
badge + file name + a View button, no image.

**Root cause (traced in source, not guessed).** Not a regression — three
independently-grown renderers inside `FloorPlans` in
`frontend/src/mobile/MobilePMS.tsx`. Display was written as a standalone
list-row (the banner) with its own `ReviewBadge` / `ReviewButtons` block beneath
it, before the tile grid existed; the tile grid arrived later for
Unfilled/Filled and gained the 3D/2D tiles on 2026-07-23. Nothing ever moved
Display into the grid, so it never inherited the grid's preview. `stockOutAtts`
is a third renderer again and never had one.

**Fix.** Display becomes a normal tile in the same grid, spanning
`gridColumn: "1 / -1"` with a 140px preview so the 3D + 2D pair keeps its own
row; order is Display -> 3D + 2D -> Unfilled + Filled. The standalone banner and
its separate review block are gone — Display now takes the same `ReviewBadge` /
`checklistReviewVisible` -> `ReviewButtons` path the 3D/2D tiles already used.
That fold is behaviour-preserving, and it was verified by reading both guards
rather than assumed: `checklistReviewVisible` opens with
`if (!item || !hasFiles) return false`, and `ReviewBadge` returns `null` when
`review_status` is empty and `hasFiles` is false. Those are exactly the cases the
old outer guard `displayItem && (displayItem.review_status ||
displayPlanFiles.length > 0)` excluded, so neither badge nor button can appear
anywhere it did not before. Each `stockOutAtts` row gains a 54x44 tappable
thumbnail opening the same viewer as its View button; non-images keep the hatched
placeholder.

**Desktop twin: none needed, checked.** `frontend/src/pages/Projects.tsx` has no
floor-plan card and no tile grid — it renders each checklist document as one
uniform row of its `DocumentTable`. Grepped over `frontend/src`, the identifiers
this change depends on — `R2Thumb`, `FloorPlans`, `stockOutAtts` and `mediaH` —
resolve to a single file, `frontend/src/mobile/MobilePMS.tsx`. "Display Floor
Plan", "3D Design" and "2D Design" reach desktop only as `REVIEWABLE_TITLES`
members. Tile width, tile order and previews are concepts the desktop surface
does not express, so this is presentation-only and one-sided by construction,
not by omission.

**Also in this PR.** Two comments this change made false — the ones deciding
`hideFilledPlan` and `hidePlanTiles` — still called Display a "banner" after the
banner was deleted. Corrected in the same diff.

**Ref.** `fix/floorplan-card`, PR #2349, 2026-08-20.
