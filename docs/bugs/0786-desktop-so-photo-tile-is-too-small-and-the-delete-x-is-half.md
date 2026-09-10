## Desktop SO photo tile is too small and the delete X is half hidden by the tile overflow [medium]

**Symptom.** Owner, 2026-09-10 (WhatsApp screenshot): 「That photo size make
it bigger and the x logo got blocked half already can fix on this」. On the
desktop SO amendment screen a line's photo thumbnail is rendered at 40px
square — barely legible on a desktop rail — and its red delete X is
clipped in half by the tile itself, so the salesperson cannot reliably
remove a photo they attached by mistake.

**Root cause (traced).** Two CSS choices in
`frontend/src/vendor/scm/components/SoLineCard.module.css`:

- `.photoTile` at line 498 declared `width: 40px; height: 40px;
  overflow: hidden;`. The 40px sizing came from the July mobile-first
  pass; on desktop, where the rail has plenty of horizontal room, it
  reads as an icon rather than a photo.
- `.photoDelete` at line 533 positioned itself at `top: -6px; right: -6px`
  — deliberately outside the tile bounds so the red pip visually
  overhangs the corner. Combined with `overflow: hidden` on the parent
  tile, the browser was clipping the half of the button that sat outside
  the tile — leaving only a red crescent the operator cannot hit.

**Fix.** `SoLineCard.module.css`:

- `.photoTile` — `width: 40px → 64px`, `height: 40px → 64px`, and
  `overflow: hidden → visible`. The tile's `<img>` still fills exactly
  the tile because it already carries `width: 100%; height: 100%;
  object-fit: cover;`, and now also `border-radius: var(--radius-sm)` so
  the image's own corners round with the tile without needing the parent
  to clip. The pending stripe stays inside the tile as before (it
  positions itself with `bottom: -1px`, well within bounds).
- `.photoDelete` — grown to `22 × 22px` (from 18), border 1 → 2 for
  contrast against a photo, offset nudged out to `-8px / -8px` so the
  visible corner still overhangs cleanly against the new bigger tile,
  and a `z-index: 2` + `box-shadow` so the button reads above whatever
  is in the corner of the image.
- `.photoAddBtn` — matched to the new tile size (40 → 64) so the "+"
  affordance sits flush with its siblings on the rail.

Verified in Chromium: the delete X is fully visible on both a saved
thumbnail (PhotoThumb) and a pending draft photo, and the whole tile is
comfortable to click on a desktop pointer.

**Ref.** `fix/so-desktop-photo-and-date`, 2026-09-10.
