## A photo attached to prove a measurement was cropped, and blurred when zoomed [medium]

**Symptom.** The owner, 2026-08-28: 「同一时间，你确保一下，当我就算 zoom 大这个
照片，它也不会变模糊」.

**Root cause, and it is arithmetic.** `PDF_THUMB_PX` was 512 across a 52mm tile —
~250dpi. That number was chosen for PAPER and is fine there. A reader zooming the
tile to 400% on a screen is asking for ~786 device pixels, which 512 cannot
supply, so the photo softened exactly when somebody leaned in to check a detail.
That is the moment these photos exist for: a purchaser photographs a tape measure
against a panel.

**A second fault found while measuring the first.** The transcode forced a square
by cropping to the shorter side, so every PORTRAIT photo lost its top and bottom
— and a tape-measure photo is portrait BECAUSE it is a tape measure. The crop cut
off the two ends of the measurement, which is the one thing the photo was taken
to show. Nobody had reported it; it was visible in the owner's own screenshot.

**Fix.** 512 → **1536** (~750dpi at 52mm, sharp past 600% zoom), and the image
keeps its aspect ratio, letterboxed inside the still-square 52mm tile so the grid
and every height calculation below it are untouched. The encoder never UPSCALES:
a 300px source re-encoded at 1536 is the same 300px of detail in nine times the
bytes.

**The cost, stated.** Roughly 9× the pixels — a tile lands around 200-500 kB
instead of 30-70 kB. Accepted deliberately: these PDFs are read on a phone at a
workbench far more often than they are printed.

**`PdfPhotoImage` now carries `w`/`h`.** Without the encoded dimensions a
portrait photo drawn into a square tile comes out squashed, which is a worse lie
than the crop was.

**Ref.** feat/the-po-draws-the-real-compartment-art, 2026-08-28.
