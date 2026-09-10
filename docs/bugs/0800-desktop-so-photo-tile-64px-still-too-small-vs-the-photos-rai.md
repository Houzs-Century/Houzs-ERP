## Desktop SO photo tile 64px still too small vs the PHOTOS rail [medium]

**Symptom.** Owner 2026-09-11 on desktop SO Detail edit mode: the PHOTOS rail
sits along the right column of every line and is wide (~200px+), but the
photo thumbnails inside it were tiny 64×64 squares. Reading a scanned slip
required opening a lightbox — a stamp-size preview does not do the job the
rail exists for. The delete X in the tile's top-right was 22×22 with a -8/-8
offset, which put half of it back inside the image and made it painful to
hit — the owner reported "delete 掉照片 也很难" the same day PR #3546 had
raised those exact numbers from earlier smaller values.

**Root cause (traced).** Sizing tuple in
`frontend/src/vendor/scm/components/SoLineCard.module.css`:

- `.photoTile { width: 64px; height: 64px; }` (L498)
- `.photoDelete { width: 22px; height: 22px; top: -8px; right: -8px; }` (L543)
- `.photoAddBtn { width: 64px; height: 64px; }` (L566)

The 64 came from an earlier round tuned to a narrower rail; the rail has
since grown. The number is pure sizing — no cascade, no data — so the fix is
new numbers.

**Fix.** Bump the three sizes together so tile + add button stay flush:

- `.photoTile` and `.photoAddBtn` -> **100 × 100**. Two per row still fits in
  a ~200px rail (2 × 100 + 6px `.photosStrip` gap = 206px, and the strip's
  own `flex-wrap: wrap` handles narrower widths cleanly).
- `.photoDelete` -> **28 × 28** with a -10/-10 offset, so the whole button
  sits outside the tile's corner instead of half-overlapping the image.

Nothing else in the file touches these classes, and the mobile SO uses a
separate inline `photoTile` (`frontend/src/mobile/MobileNewSO.tsx:3239`)
that is not affected — mobile sizing is handled in the M4+M5 rework
(`docs/bugs/` will get its own entry when that ships).

Not touching `SoLinePhotoStrip.tsx` (Tailwind `h-8 w-8` = 32px thumbs, used
in the READ-ONLY V2 detail view). That surface is a click-to-open lightbox
grid, not an edit surface — different affordance, different sizing job. If
the owner wants those bigger too, that's a separate entry.

**Verification.** Pure CSS number change; the rail's own `.photosStrip
{ flex-wrap: wrap; gap: 6px }` handles the reflow. No JS or DOM changes.

**Ref.** `fix/desktop-photo-tile-and-x-bigger`, 2026-09-11.
