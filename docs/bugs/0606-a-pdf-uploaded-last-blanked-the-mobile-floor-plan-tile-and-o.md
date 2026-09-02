## A PDF uploaded last blanked the mobile floor-plan tile and opened as an empty box [medium]

**Symptom.** Owner, 2026-09-01, on a phone: sales "cannot view floorplan" — the
Unfilled-plan tile showed the hatched empty placeholder even though files were
attached, and tapping through opened a white box with nothing in it.

**Root cause (traced).** Two independent causes with the same appearance, both
read out of the source at the sites below.

1. The tile cover was `files[files.length - 1]` — the NEWEST file of any type
   (`frontend/src/mobile/MobilePMS.tsx`, in `SalesDocsCard` and `FloorPlans`).
   A PDF uploaded after the photos became the cover, and a PDF has no thumbnail,
   so the tile rendered the hatched "nothing here" placeholder over a tile that
   was in fact full.
2. `MediaLightbox` rendered every PDF in an `<iframe>`
   (`frontend/src/components/MediaLightbox.tsx`). Android Chrome has no inline
   PDF viewer, so the iframe paints an empty box rather than falling back — the
   white screen the owner saw after tapping the tile.

**Fix.** The cover is now the newest file whose `content_type` starts with
`image/`, falling back to the newest file of any type when there is no image at
all, in both tile grids. The lightbox computes `pdfInline` from
`matchMedia("(min-width: 768px)")` plus a mobile user-agent test and shows the
file card (name + Open / Download) instead of the iframe on phones. Verified by
the owner on the deployed build (worker 601de1e1 + pages 95fbeeca) before this
PR was raised; no automated test pins the user-agent branch, which is the gap
this entry records.

**Ref.** fix/sd-viewall-tiles (PR #2842), 2026-09-02.
