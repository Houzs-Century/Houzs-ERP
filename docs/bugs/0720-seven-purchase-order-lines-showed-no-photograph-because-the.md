## Seven purchase-order lines showed no photograph because the object was never uploaded, and the obvious remedy would have written 15 dead addresses [high]

<!-- area: Purchasing -->
<!-- status: fixed -->

**Symptom.** The owner, the night the sales-order photographs were finished:
「PO的照片也进完」. `docs/bugs/0717-…` had closed the sales side to
**MISSING 0** and left the purchase side explicitly unfinished — 233 of 240
lines arrived, **7 did not**. On a sofa the photograph IS the build instruction,
so each of those 7 is a purchase order somebody has to go and look up before the
factory can start.

**Root cause (traced), and it is not the same cause as the sales side.** The
sales-order gap was a photograph sitting on the wrong row of the right document
— a re-point, no upload needed. These 7 are a different failure: **the object
was never in the bucket at all.** Measured on the operator machine, 2026-09-08,
asking R2 directly for each address rather than asking a log:

```
present: 0   missing: 15   of 15      (the addresses a blanket re-import would add)
present: 13  missing:  0   of 13      (positive control, known-good keys)
```

The 11 source JPEGs were exported and sat on the operator machine the whole
time. What did not happen was their upload. The signature is in the local
done-list: `.ac-photos/po/.uploaded.txt` held **12** keys where the batch was
about 28, and the ones it holds are interleaved with the ones it does not —
`HC-PO-010145`, `-010147`, `-010148`, `-010149`, `-010162` uploaded, while
`-010146`, `-010150`, `-010151`, `-010160` did not. That is the failure
`upload-line-photos-r2.mjs`'s own header records: *"sixteen keys failed and
every one logged `!! <key>: ` with nothing after the colon"* — a `spawnSync`
that never started or was killed reports `status === null` with both streams
empty, so sixteen different failures printed as the same empty message. The
carrying of `r.error` / `r.signal` was added afterwards; the sixteen photographs
were not re-driven.

**The obvious remedy was measured before it was trusted, and it was wrong.**
`import-po-line-photos.mjs APPLY=1` is the shipped attach path and it would have
looked like it worked. Asked what it would actually WRITE, against prod,
company 1:

```
resolve plan entries: 262
ALREADY attached: 237
WOULD BE WRITTEN by a full APPLY=1: 25
```

**25, where the gap needed 10.** The other 15 sit on lines that already show
their picture — they did not appear as MISSING because the line arrived through
a round-1 key and this is a *second, different* address for it — and R2 holds
none of those 15 objects. Writing them is
`docs/bugs/0625-a-backfill-replayed-the-round-1-photo-key-log-without-asking.md`
and `docs/bugs/0668-…` a third time: an address that names nothing, written onto
a line that was working. The importer cannot prevent this — it runs in Actions
and has no R2 token, because this repository is PUBLIC and that token reads
every photograph the company owns.

**Fix — the upload, then a third repair that did not exist.**

1. **The upload.** `upload-line-photos-r2.mjs` MODE=apply against the 10 planned
   keys: `uploaded: 10; already in R2: 0; failed: 0`. Then MODE=verify, a
   separate invocation on fresh wrangler processes that DOWNLOADS each object
   and compares its sha256 to the export manifest:
   `VERIFY: 10 byte-identical to the manifest; 0 present but unverifiable; 0 missing; 0 wrong`.
   A count of objects is not a shape — an empty object and a truncated one both
   "exist".

2. **`attach-uploaded-line-photos.mjs`, the third line-photo repair.** PRUNE
   drops an address whose object is gone; RE-POINT moves an address already on
   the document onto the line that owns it. A line whose photograph was never in
   the bucket has nothing to drop and nothing to move, so neither could do this
   and the gap had no narrow path — only the blanket re-import measured above.
   It mints no key of its own: it reads the importer's OWN resolve output, so
   there is still exactly one answer to "where does this photograph live". It
   crosses to the writer through the same plan file as the other two
   (`docs/bugs/0638-…`) — 120-minute ceiling, digest over the header as well as
   the operations, per-row precondition, fresh-connection shape check — and it
   is wired into *Apply line photo repair (from a plan file)* as a third choice.

   Three refusals, each of which independently excludes all 15:
   **the object must be in R2**; **the line must show nothing today**; **the
   group must be one model** (`isOneModel`, `docs/bugs/0672`/`0690` — a sofa
   build's compartments carry different item codes, so the MODEL is the test).
   Run against prod it found the 7 by itself and skipped 233 as already
   showing.

**Pinned, and proved RED on the unfixed tree.**
`backend/tests/attachUploadedLinePhotos.test.ts` — 17 tests. The guard that
excludes the 15 was disabled to check the test can see it fail:

```
× skipped when the FIRST piece already carries a live address
× skipped when a SIBLING compartment carries it — the line is what shows, not the row
Tests  2 failed | 15 passed (17)
```

**Why it cannot put a picture on the wrong line.** The match is on the AutoCount
line key `(doc_no, linked_ac_dtlkey)` — never position, never item code
(`docs/bugs/0690` measured that position-paired photo groups cannot be told
apart by colour). The address must name the target row, the target is
`firstRow(group)`, and the sibling compartments stay blank on purpose: one
build, one photograph, on the first piece (owner, 2026-08-10,
「每个 SKU 的照片都一样，留第一个就可以了」).

**The apply**, run `34227185119`, prod, *Apply line photo repair (from a plan
file)*, plan digest `sha256:c219d36f…`, one minute old when it was accepted:

```
PURCHASE ORDER: APPLIED — 7 line(s) updated, 10 address(es) attached
SALES ORDER: no operation in this plan
=== VERIFIED ON A FRESH CONNECTION ===
  PURCHASE ORDER: 7 line(s) re-read; each now lists the attached address
                  and it carries that row's own AutoCount line: true
APPLIED 7 line(s), REFUSED 0 line(s), SHAPE PROBLEMS 0.
```

**Verified — the owner's number, before and after, on production.**
`probe-line-photo-gap.mjs`, company 1, run `34227291924` (after) against the
before-run in this session:

| purchase order, per AutoCount LINE | before | after |
|---|---|---|
| in the ERP | 240 lines / 434 rows | 240 lines / 434 rows |
| **ARRIVED — the line shows its picture** | 233 | **240** |
| **MISSING — no row of the line shows one** | **7** | **0** |
| sibling rows carrying none BY DESIGN | 175 | **177** |

**Every purchase-order line the ERP holds a book photograph for now carries it.**

**One figure DID move that a repair of 7 lines might not be expected to move,
and it is named rather than absorbed.** The BY DESIGN row count went 175 → 177.
That is not a reclassification and it is not drift — it is arithmetic, and it
closes exactly. The 7 repaired lines were held as **9** ERP rows (`HC-PO-010085`
and `HC-PO-010160` are two compartments each; the other five are one row each).
The photograph goes on the first piece, so 7 of those 9 rows gained one and the
other **2** are sibling compartments that carry none by design. While those rows
belonged to a MISSING line they were not counted in that figure at all; now
their line has ARRIVED, they are. `175 + 2 = 177`, and the ARRIVED count rose by
exactly the 7 lines repaired.

**The controls held.** No sales-order figure moved — 637 in the ERP, 637
ARRIVED, 0 MISSING, 430 by-design siblings, all identical before and after; the
plan carried 10 operations, every one on the `PURCHASE ORDER` arm, and the run
log reads `SALES ORDER: no operation in this plan`. The purchase-order
population did not move underneath the measurement either (240 lines / 434 rows
both times), unlike the sales-order repair the night before, which had a
concurrent lane inserting compartments under it.

**What is still open, said plainly.** The other 15 addresses are NOT a defect
and were deliberately not written: their lines already show their photograph
through a working address, and the book holds no second picture that is missing
from the ERP. What they are is 15 *plan entries whose object was never uploaded*
— the same interrupted batch — and they will keep reappearing in any resolve
output. They are now refused by name rather than being a trap for the next
person who reaches for `APPLY=1`.

**Ref.** `fix/po-line-photos-upload`, 2026-09-08. Apply run `34227185119`,
after-probe run `34227291924`. The plan file
`backend/scripts/data/photo-repair-plans/po-attach-2026-09-08.json` is SPENT —
its per-row precondition now refuses every one of its own operations, which is
the guard working, and it is kept only as the record of what was applied.
