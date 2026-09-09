## The photo attach run wrote 30 keys when only 21 objects had been uploaded [high]

**Symptom.** Nine company-1 sales-order lines — `HC-SO-013497`, `HC-SO-013499`
(two lines), `HC-SO-013501`, `HC-SO-013502`, `HC-SO-013503`, `HC-SO-013506`,
`HC-SO-013507`, `HC-SO-013508` — carry a single `photo_urls` address that names
no object in R2. The line shows the `err` tile the strip renders for an
unreachable key, and it is the row's ONLY address, so there is nothing else to
fall back to.

**It is `high` and not cosmetic, for the reason `0625` already established.**
The write-back materialiser reads `photo_urls` verbatim and throws on the first
key the bucket cannot answer (`photosOf`, `scm/lib/autocount-outbox.ts`), so
`line.Photos` is never set and the line sends NO photographs to AutoCount at
all. `scm.autocount_writeback` is ON for company 1. These are live outstanding
orders.

**Root cause (traced, and it was this session's own doing.)** The go-live photo
pipeline is three separate steps — decode out of the book, upload the JPEG to
R2, attach the key to the line — and only the third one runs in Actions.
`backend/scripts/import-so-line-photos.mjs` computes its plan from
`data/ac-photo-manifest.json.gz` alone: a manifest row is enough for it to mint
a key and, under `APPLY=1`, to write that key onto the line. It never asks
whether the OBJECT exists, and it cannot — this repository is public, so the R2
token can never be an Actions secret.

On 2026-09-07 the manifest held 30 undelivered SO images. Twenty-one of the
corresponding JPEGs were present in `C:\Users\User\Desktop\.ac-photos\so` and
were uploaded and byte-verified (`MODE=verify`: 21 of 21 byte-identical, 0
missing, 0 wrong). The other nine have no JPEG anywhere on the operator machine
— proved by a `find` of the whole user profile, and by the repo manifest
carrying 12 rows whose `file` is absent from `.ac-photos/so`. Dispatching
`import-so-line-photos.yml` with `apply=1` then attached all **30**: run
34134582487, `DONE. lines updated: 30; keys attached: 30`. An R2 listing taken
straight after showed SO addresses `1166 resolve / 9 dead`, up from `1145 / 0`
before. The PO side is unaffected — 12 of 12 objects existed, run 34134592716
attached 12, and PO measured `376 / 0` after.

So the defect is structural and predates the run that exposed it: **the attach
step's authority is the manifest, and the manifest is a record of what was
DECODED, not of what was UPLOADED.** `0625` is the same sentence with a
different source file — there the authority was a stale attach LOG.

**Fix.** Two parts, and only the first is code.

1. `backend/scripts/prune-dead-line-photo-keys.mjs` gains `INCLUDE_BLANKS=1`.
   The prune deliberately refuses to drop a dead address that would leave the
   row blank, because turning a broken tile into no tile is the owner's call.
   That rule is right for a picture that was lost; it is wrong for one that was
   never there, where the row showed nothing before the address was attached
   and removing it only restores that. The flag is **plan-only** — it refuses
   `MODE=apply` and refuses to run without `PLAN_OUT` — so a blank-leaving drop
   can only reach the database through the reviewed plan-file handoff, never
   through a local apply. Default off, so `planDeadKeyPrune`'s "never the last
   copy" promise and its pinned test are untouched.
   Both refusals were executed, not asserted:
   `INCLUDE_BLANKS=1 is a PLAN-mode input …` and `INCLUDE_BLANKS=1 needs
   PLAN_OUT …`, and a default plan run still printed
   `dead addresses that are the row's ONLY one — LEFT ALONE, owner decides: 9`
   with `0 address(es) would be removed`.
   `tests/photoRepairPlanHandoff.test.ts` 18 passed and
   `node --test scripts/lib/line-photo-keys.test.mjs` 8 passed on this tree.

2. **The nine pictures still have to be fetched.** They are in the book's
   `FurtherDescription` and nowhere else. `export-ac-line-photos.py`'s
   `DTLKEY_FILE` mode exists for exactly this (see `0655`) — it reads only the
   named DtlKeys, in bounded `IN` chunks, so it is safe to run while the
   write-back is up. The keys are 926847, 926851, 926852, 926859, 926865,
   926872, 927031, 927060, 927063. That run is NOT part of this branch: another
   agent holds AutoCount SQL access, and an unbounded read of that column is
   what starved `SalesOrder.InternalSave()` earlier the same day.

**What this does NOT fix, and should.** `import-*-line-photos.mjs` will do this
again the next time the manifest runs ahead of the uploads — which it will,
because the AutoCount delta sync keeps bringing in documents after the photo
batch has run. The durable fix is to drive the attach from an UPLOADED-keys
list rather than from the manifest. Recorded here rather than done here because
it changes the go-live pipeline on go-live day.

**Ref.** fix/photo-coverage-audit, 2026-09-07.
