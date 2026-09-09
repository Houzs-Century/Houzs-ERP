## The sofa probe fed the collapse a partial line and reported no problem [low]

<!-- area: Repo tooling: tests, ratchets, generators -->

**Symptom.** `check-too-long-for-the-book.mjs` was asked about five documents.
It printed the six over-long Further Descriptions correctly and then, for the
two sofa documents the queue refuses every day for exactly this, said:

```
=== SOFA BUILDS WHOSE COLLAPSED TEXT IS OVER ===
  none reported as over-length by the collapse
```

`HC-SO-012513` (113 characters) and `HC-SO-012629` (117) are refused by the
outbox with `composed Desc2 is N characters and AutoCount's field holds 100`.
The probe said there was nothing.

**Root cause, two of them, and both are the same shape.**

1. **It fed `collapseSofaLines` a PARTIAL line.** `CollapsibleLine` carries
   `linked_ac_dtlkey`, `description`, `delivery_date` and `location`; the probe
   passed six of its fields and left those out. The collapse chooses between
   ECHOING a stored Desc2 and COMPOSING a new one, and that choice reads the
   line's key — so fed a partial line it took a different branch from the one
   the write-back takes, and reached no refusal at all.

2. **The refusal filter matched nothing and that read as nothing wrong.** Only
   refusals whose reason contained `characters` were printed; every other
   refusal was skipped in silence. So even had the collapse refused, a refusal
   worded differently would have produced the same empty answer.

Both are the failure CLAUDE.md names in one line: *a verdict computed over
nothing must never read as a pass.*

**Fix.** Select and pass every field `CollapsibleLine` has, so the collapse
decides what the write-back decides; and print EVERY refusal, labelling the ones
that are not about length rather than dropping them.

**Verified.** `node --check` clean. **UNTESTED against production until
dispatched** — the previous dispatch (run 34340403272) is the evidence of the
defect, and the next one is the evidence of the fix.

**Ref.** fix/the-sofa-probe-feeds-the-collapse-a-whole-line, 2026-09-09.
