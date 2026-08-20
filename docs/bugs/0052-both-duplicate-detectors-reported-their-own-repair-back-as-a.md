## Both duplicate detectors reported their own repair back as a fresh defect [low]

**Symptom** - immediately after the owner's two 2026-08-11 decisions were
applied and verified, the read-only detectors that had found the problems
reported them as still outstanding:

- `diag-so-po-variant-divergence.mjs` Section D (run **31454888561**) printed
  "1 documents, 4 surplus lines" on `HC-DO-007525` - a document whose five
  duplicate lines had just been retired;
- `merge-duplicate-fabric-series.mjs` (run **31454890568**) still counted **32**
  duplicate pairs and offered to merge 29 of them, minutes after merging exactly
  those 29.

**Root cause (traced, not guessed)** - both detectors census a table that the
"nothing is deleted, only cancelled" rule deliberately leaves populated, and
neither had been taught what a retired row looks like.

1. Option B retires a delivery line by setting `qty = 0` and keeping the row.
   Section D groups by `(delivery_order_id, item_code, qty, so_item_id)`, so the
   five retired `HC-DO-007525` rows - formerly five separate `qty = 1` rows -
   **now group with each other at quantity 0** and satisfy `HAVING COUNT(*) > 1`.
   The repair manufactured a new duplicate group out of its own output.
   (`zero-duplicate-do-lines.mjs` already carried `qty <> 0` for exactly this
   reason; the older diagnostic did not.)
2. A merged fabric series is superseded, not deleted, and its colours stay
   attached to it - so they still collide by colour code with the winner that
   absorbed them, and a census reading the whole `fabric_library` re-proposes
   every pair it just merged, forever.

**Fix** - `qty <> 0` at all four grouping sites in Section D, and the fabric
census now reads only ACTIVE series, printing the superseded count separately so
a completed merge reads as **done** rather than as outstanding.

**Lesson** - a soft-retire rule has a second half nobody writes down: every
detector that counts the retired thing has to learn the tombstone. "Nothing is
deleted" means the rows are still there to be miscounted, and a detector that
cries wolf after a repair is worse than one that never fired - it teaches the
next person that the repair did not work.

**Ref** - 2026-08-11, PR #1980 (fix/detectors-stop-crying-wolf). Prod evidence:
runs 31454888561 and 31454890568, both taken as post-state verification of
#1971 and #1972.
