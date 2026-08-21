## Three files described a Houzs delivery population that does not exist [low]

**Symptom.** A census of proof-of-delivery evidence reported `drawn = 0` and was
read as "the capture path is broken for Houzs". Three files in the tree told
that reader the same story in prose: that Houzs delivery orders had been closed
through screens that skipped the capture, and that the Houzs AutoCount
carry-overs had been inserted as literal `DELIVERED`. Both sentences are about a
production population, and both were written from reasoning rather than from a
query.

**Root cause (traced).** There are no Houzs delivery orders. Measured against
production with `backend/scripts/check-pod-evidence.mjs`, dispatched on
`do-integrity-check.yml`, run 32457160124 (2026-08-21): `scm.delivery_orders`
holds 39 rows, every one of them company 2 (`2990 - 2990's Home`), and not one
row carries `migrated_no_stock`. The twelve closed rows were not carried in
already-closed either — they were created `DISPATCHED` over four weeks and
flipped to `DELIVERED` inside a single minute on 2026-07-24 by
`backend/scripts/backfill-2990-delivered-dos.mjs`, whose own header records the
owner ruling behind it.

A fourth sentence was stale rather than invented: `MobilePOD.tsx`'s SignaturePad
JSDoc still ended "when a backend field to persist them exists (none today)".
That stopped being true on 2026-07-14, when `patchDeliveryOrderStatusHandler`
began persisting `signature_data` — so the file told the next reader the capture
was decorative and there was nothing to protect.

**Fix.** Comments only, no behaviour change: the census header, the
`doCloseWithoutEvidenceWarning` rationale in
`frontend/src/vendor/scm/lib/do-next-step.ts`, and the SignaturePad JSDoc now
say what was measured and cite the run. The census itself gained the sections
that produce the evidence, so the next reader does not have to believe the
prose.

The related capture chain — pad to latch to payload — had no test at all, and it
now does: `frontend/src/mobile/MobilePodSignatureCapture.test.tsx`. Proved RED
twice on a deliberately broken tree before being trusted: restoring the pre
2026-08-14 `sig ? …` read failed 2 of 3 (an untouched pad sent a blank PNG), and
removing the pad's `onChange(true)` latch failed a different 2 of 3 (a drawn
signature reached nothing).

**Ref.** chore/pod-evidence-reality-check, 2026-08-21.
