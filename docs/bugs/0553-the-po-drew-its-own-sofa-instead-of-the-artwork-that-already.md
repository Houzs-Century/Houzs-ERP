## The PO drew its own sofa instead of the artwork that already existed [medium]

**Symptom.** The owner, 2026-08-28, looking at a Purchase Order: 「今天有的 PR
commit 是把 PO 的 compartment 照片换成我的真的 sofa compartment 的照片的，可是看
起来还是有点不像」. #2754 and #2758 had added the ability to draw real compartment
art on the PO, and the sheet still showed the crude drawn schematic.

**Root cause — the loader knew ONE of the THREE shapes an imageKey takes.**

| key | who writes it | Maintenance list & POS | the PDF |
|---|---|---|---|
| `sofa-compartments/…` | an upload | API proxy | ✅ |
| **`sofa-modules/<code>.svg`** | **the seed — the DEFAULT** | `/public`, a static file | ❌ **sent to the API → 404** |
| `https://…` | an external URL | used as-is | ❌ |

`loadSofaCompartmentPhotos` sent EVERY key to the uploaded-photo endpoint. The
seeded default is bundled art, so every default compartment 404'd, the
per-compartment `catch` swallowed it, and the engine fell back to its schematic
— which is exactly what the owner was looking at. Nothing logged, nothing
failed: the sheet simply drew a worse picture.

**Second cause, which would have survived fixing the first.** The art is
1024×1024 **with the drawing padded inside**. Filling a cell with the raw file
renders every module small with gaps between them. POS solved this before us and
its comment names the scar: *"to tile modules tightly we measure each
silhouette's alpha bbox once and scale/offset the img so the silhouette fills its
cm footprint"* — and calls the failure "the 2WC card bug, 2026-05-24".

**Fix — POS's method, ported, at the owner's instruction** (「你自己去检查好整个
POS 系统的做法，然后把我们的照片跟着 POS 系统的做法做完」). Source:
`wenwei4046/2990s`. The artwork is confirmed identical: all 63 files in
`frontend/public/sofa-modules/` checksum-match POS's, so this is the owner's own
hand-drawn set in both places, not a redraw.

1. `sofa-compartment-art.ts` resolves all three key shapes and crops the art to
   its alpha bbox — POS's 2px sampling stride and alpha>16 threshold, so both
   surfaces crop identically. Rotation is baked into the bitmap because jsPDF has
   no rotate-about-centre this repo can rely on; POS rotates the DOM box instead.
2. `sofa-corner-pdf.ts` is POS's connected-L renderer, re-emitted as jsPDF
   primitives. Its reason is not cosmetic: *"tiling the three per-module PNGs
   leaves a STEP + an INTERNAL ARM"* — on a supplier's sheet that step reads as a
   real gap and that arm as a real arm, on the one document whose job is to stop
   the sofa being built in the wrong pieces. The L outline could not be copied
   verbatim (POS emits an SVG path); the same shape is drawn with `lines()`,
   converting each quadratic to a cubic exactly rather than by eye.

**PNG, not SVG, and that is POS's choice too:** jsPDF embeds raster only, and POS
tiles from `${id}.png` for the same reason. 25 of the 63 bundled files are PNG.

**WHAT IS STILL NOT PORTED, stated rather than left to be discovered.** POS's
`renderSeamlessSofa` (476 lines) joins a straight run into one continuous sofa
when it contains a power seat or a wide-arm 1B/2B. The 13 SVG-only codes — the
`(P)`/`(R)`/`(L)` variants and Console-WC — are exactly the ones POS says the
tile path "would render blank". Here they fall back to the drawn schematic: a
drawing is visibly a drawing, a blank cell looks like a missing module.

**Ref.** feat/the-po-draws-the-real-compartment-art, 2026-08-28.
