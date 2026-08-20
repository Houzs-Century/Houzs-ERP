## The transfer re-send rebuilt a dedupe key that one op does not use [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** No operator ever saw this one — it was caught by re-reading #2330
after it merged, and it is logged because it shipped to `main` and because the
thing it disarms is a guard, which fails silently by definition.

**Root cause (traced, not guessed).** `transferVerdict` queued the replacement
row with a RECONSTRUCTED key, `` `${raw.op}:${raw.doc_id ?? raw.doc_no}` ``. That
is `enqueueConvert`'s formula (`autocount-outbox.ts:869`) and it is correct for
the four conversions. It is wrong for the fifth transfer op: a `so_to_po` row is
written by `enqueuePoCreate`, which keys it `` `create_po:${poId}` `` (`:772`) —
deliberately, because the transfer is the alternative to a plain create for that
purchase order and the two must never both sit in the queue. A reconstructed
`so_to_po:<poId>` matches NEITHER, so `autocount_outbox_dedupe_idx` (mig 0277,
unique on `dedupe_key` where `status = 'pending'`) would have stopped covering
that one shape. Not a live duplicate — the ladder's own live-row probe still
refuses a `pending` or `sent` row first — but the index exists for the race the
probe cannot see, and a backstop that is quietly absent is worse than one that
was never claimed.

**Fix.** Stop deriving it. The row already carries the key it was queued under,
and a `failed` row still holds it because the unique index covers only
`status = 'pending'`, so the re-send reads `raw.dedupe_key` — the same
recorded-intent argument the payload rests on, one column over, and one that
cannot drift from whichever enqueue wrote the row. `dedupe_key` joined
`REQUEUE_ROW_COLS` so both entry points select it.

**Proven, not read.** A test asserts the key survives the re-send AND that the
index really refuses a competing `create_po` afterwards; it fails when the key is
rebuilt (`× a so_to_po keeps the key enqueuePoCreate gave it, which is NOT its
own op name`, 1 failed / 68 passed).

**Lesson, and it is the general one.** A key that several writers share is a
CONTRACT, not a formula. Re-deriving it in a sixth place makes the derivation
correct-by-inspection for the cases the author had in mind and silently wrong for
the one that differs — which is the same shape as this repo's mirrored-rule
class, where the copy is right on the day it is written.

**Ref.** PR #2331, 2026-08-16. Follows #2330.
