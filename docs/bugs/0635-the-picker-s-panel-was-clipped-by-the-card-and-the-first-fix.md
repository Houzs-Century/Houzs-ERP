## the picker's panel was clipped by the card, and the first fix blamed the viewport [medium]

**Symptom.** The owner, typing "adver" into a PV line's account picker
(2026-09-04): 为什么我能选的这么少 / 选account 时会无法看到下面的 — eight
matching accounts existed, four were visible, and the list could not be
scrolled to the rest. After the first fix shipped (#2939): 还是一样, with
screenshots showing the panel cut at the same four rows.

**Root cause (traced).** Two layers, and the first fix only treated the
second. The SearchCombo panel rendered `position: absolute` INSIDE the form
card, and `.card` in `frontend/src/pages/scm-v2/SalesOrderDetail.module.css`
carries `overflow: hidden` (line 72 — there for the rounded corners). An
absolutely-positioned child is clipped by that ancestor at the card's edge —
its own scrollbar included — regardless of how much viewport remains below.
The first fix (#2939) added viewport-aware flip/height math, which was real
but irrelevant here: the owner's screenshots show page content still visible
BELOW the cut panel, i.e. the clip line was the card's bottom border, not the
screen's. Diagnosed by reading the screenshots against the card CSS, then
confirming `.card { overflow: hidden }` in the stylesheet.

**Fix.** The panel now PORTALS to `document.body` and positions `fixed` off
the input's live rect (re-measured on capture-phase scroll and on resize
while open), so no ancestor overflow, transform or stacking context can clip
it; the flip-up/height-cap math from #2939 is kept on top. The panel
container also `preventDefault`s mousedown so grabbing its scrollbar cannot
blur the input and close the list mid-scroll. Pinned in
`frontend/src/vendor/scm/components/SearchCombo.test.tsx`: the listbox's
parent IS `document.body` (the assertion that fails on the unfixed tree,
where the panel is a descendant of the overflow-hidden wrapper), plus the
no-row-cap and both placement directions.

**Ref.** fix/search-combo-portal, 2026-09-04.
