## SO-readiness check over-counted by ignoring the processing-date gate and FIFO contention [medium]

**Symptom.** Once the enum crashes ([[0804]], [[0805]]) were fixed, the check ran
green (run 34558471557, 2026-09-11) and SECTION 2 reported **8,328** company-1
pooled mattress/accessory lines as "PENDING but stock already covers" — 81% of
the 10,298 live pooled lines. Taken at face value that reads as a near-total
readiness-engine failure. It is not; the number is a measurement artifact.

**Root cause (traced).** SECTION 2 compared ONE line's `remaining` against the
TOTAL blank-variant on-hand for its (warehouse, item_code) bucket, and modelled
NEITHER of the two gates the real allocator applies
(`scm/lib/so-stock-allocation.ts`):

1. **Processing-date gate.** The allocator builds `allocGated` from
   `processing_date IS NULL` and never allocates or shows READY for those orders
   — the owner's 2026-08-10 go-live rule ("有 processing date 才来分配"). The check
   counted every such line as "should be ready", when by design it must not be.
2. **FIFO contention.** On-hand is shared; the allocator fills the earliest-due
   lines first. A line needing 1 in a warehouse holding 484 is NOT owed READY if
   500 older lines also draw that item. The check compared per-line, so it
   flagged every line in an over-subscribed bucket.

This is the CLAUDE.md "a check that answers a different question" trap: the query
was green and the count was real, but it answered "is there gross stock for this
line?" not "should the allocator have flipped this line?".

**Fix.** SECTION 2 now flags a defect only when the line is non-gated (its SO has
a processing date), non-special, in a selling warehouse, AND its bucket is
NON-CONTENDED — on-hand covers the bucket's ENTIRE non-gated demand, so FIFO
order cannot leave it short. Gated / contended / non-selling / no-warehouse /
special lines move to SECTION 3 as the correct reasons they wait. Bucket demand
is summed over the lines that actually draw the blank pool (live, non-gated,
non-special, warehoused), keyed per-warehouse to match the allocator's buckets.
Verified by re-run against production (result in the PR); `node --check` clean.

**Ref.** fix/so-readiness-processing-gate, 2026-09-11.
