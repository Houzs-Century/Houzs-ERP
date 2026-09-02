## A backfill replayed the round-1 photo key log without asking R2, attaching 64 addresses with no object [medium]

**Symptom.** 53 rows on 50 documents show a broken photo tile next to a working
one — the same photograph twice, one of which will not open. Nine further rows
show only the broken tile and nothing else: `HC-SO-009031`, `HC-SO-012907`,
`HC-PO-008483`, `HC-PO-008461`, `HC-PO-008944`, `HC-PO-009018`, `HC-PO-009024`,
`HC-PO-009034`, `HC-PO-009709`.

**Root cause (traced).** `backend/scripts/backfill-photo-urls-from-keys.mjs`
re-attaches the round-1 (2026-08-10) photo addresses after the 2026-08-28
re-import replaced every ERP row id. It reads them from
`backend/scripts/data/r2-so-photo-keys-2026-08-10.txt` and
`r2-po-photo-keys-2026-08-10.txt`, which are the round-1 ATTACH log — a record
of what was planned, not a receipt from the bucket — and appends each address
verbatim without ever asking R2 whether the object is there. Its own header
calls them "the round-1 attach-run logs", and its only miss reason is "no line
with that doc_no + linked_ac_dtlkey".

Measured on prod 2026-09-03. Every `so-items/` + `po-items/` key was listed via
the Cloudflare R2 REST API (2,149 objects) and cross-checked against all 1,368
addresses on company-1 SO and PO lines: 1,304 resolve, **64 do not**, and all 64
are round-1 shape. All 64 appear in those two key-log files. Each of the 64 was
then probed individually — `GET .../r2/buckets/houzs-erp/objects/<key>` returned
**404 `{"code":10007}` for 64 of 64**, and the 63 live addresses on the same rows
returned **200 `image/jpeg` for 63 of 63**. The listing and the per-object probe
agree.

Nothing is wrong with the ROUND-1 KEY SHAPE itself, and that is worth writing
down because it looks like the culprit: 686 addresses naming a row id that no
longer exists open perfectly well today, because the read routes authorise by
MEMBERSHIP of `photo_urls`, never by key shape
(`mfg-purchase-orders.ts`, `poItemPhotoSignedHandler`).

**Fix.** `backend/scripts/prune-dead-line-photo-keys.mjs` lists the bucket at run
time and removes a dead address only when THE SAME ROW still carries a working
address for THE SAME AutoCount line — so a prune can never be the last copy of a
picture. A dead address whose row would be left blank is printed under
`WOULD GO BLANK` and deliberately left alone: turning a broken tile into no tile
is the owner's call, not a repair. Plan run on prod 2026-09-03:
`55 address(es) would be removed from 53 row(s)`, with the 9 blanks named.

The decision is pinned in `backend/scripts/lib/line-photo-keys.test.mjs` —
"prune NEVER drops the last copy" fails if the guard is loosened.

The nine blanks are the SAME defect as
`docs/bugs/0622-autocount-line-photos-were-matched-by-item-code-so-a-repeate.md`:
their photograph is in R2 under a sibling row's path, so
`repoint-line-photos-to-owning-line.mjs` recovers all nine with no upload.

**Not fixed here, and deliberately.** The backfill still trusts the key log. It
has already run and there is nothing left for it to attach, so hardening it now
would be a change with no observable effect to verify. The re-usable guard is
`scripts/lib/r2-object-index.mjs`: any future attach pass should filter its key
list through `listObjectKeys` before writing.

**Ref.** `fix/line-photo-repair`, 2026-09-03.
