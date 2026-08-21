## The photographs came OUT of AutoCount at the cutover and nothing sent them back [medium]

**Symptom.** A sales-order line that carries reference photographs in the ERP
shows nothing in AutoCount. The pictures were pulled out of AutoCount's own
`FurtherDescription` field during the cutover and uploaded to R2; the owner's
rule for the write-back is that whatever the cutover extracted must go back, and
this half never did.

**Root cause.** Not a defect — an unbuilt half, and worth logging because the
OTHER half looked finished. `AcSyncService` has taken `Photos: [{ Jpeg,
Caption? }]` per line on `/edit` since 2026-08-15 and it was proven against the
live book that day (scratch order `ERP-FDPROBE-1`: rendered on the entry screen
and in the printed preview, read back `truncated=False`, `wmetafile8=1`, bytes
unchanged). `grep FurtherDescription backend/src` returned nothing: neither
`autocount-writeback.ts` nor `autocount-outbox.ts` had ever mentioned it.

**Fix.** `composeSoState` reads `photo_urls` off the SO line rows and the edit
payload carries `photos: [{ dtlKey, keys }]`. `dispatchOne` fetches each key
from the `SO_ITEM_PHOTOS` bucket and attaches `Photos` as base64.

**KEYS in the payload, bytes at send time.** `scm.autocount_outbox` is
append-only, so storing base64 would write tens of KB per save of every
photographed order for ever. The snapshot records what the save MEANT and the
drain materialises it — the division `fromDoc` already runs under.

**A picture the bucket cannot answer sends NO `Photos` key.** Not a short list:
the service REPLACES `FurtherDescription` with what it is given, so three of five
pictures would delete two from a live account book. And it never fails the edit —
a photograph must not cost a price change its trip to the ledger.

**Tests.** Two: an edit carries the photographs as base64, fetched at send time;
a missing object sends no key and the edit still goes. The first proven red
against `if (false && row.op === 'edit' …)`. Both assert on the LAST request of
the dispatch, not the first — an edit pre-flights `/ensure-masters`, and the
first version of the test read that payload and failed on `Lines` being
undefined.

**Ref.** 2026-08-18, `fix/ac-sync-close-gaps`. AutoCount half: #2254.
