## The phone SO detail received every line photo and drew none of them [medium]

**Symptom.** Open `HC-SO-013411` on the desktop site: three of its six lines
show a photo thumbnail in the PHOTOS column, and tapping one opens the
customer's hand-drawn mattress slip. Open the SAME order on the phone
(`?mobile=1`, `MobileSODetail`) and the LINE ITEMS card shows those three lines
with the code, the variant, the remark, the UOM, the stock pill, the source PO
and the price — and no photograph anywhere. Observed on prod 2026-09-07, both
surfaces, same order, same login.

**Root cause (traced).** `photo_urls` is in the `ITEM` column list the SO detail
endpoint selects (`backend/src/scm/routes/mfg-sales-orders.ts`, "PR-F —
per-line photo keys (migration 0076)"), so the phone has been receiving the keys
on every request since that migration. `MobileSODetail.tsx` simply had no
renderer: its `SoItem` type did not declare the field, and the line card at
`items.map(...)` drew every other column of the desktop row and not this one.
`grep -n photo MobileSODetail.tsx` returns only the scan-flow slip/receipt
images (`slip_image_key`, `receipt_image_key`, migrations 0033 + 0034), which
are a different thing: proof photos of the ORDER, not the reference shot on a
LINE.

This is the third instance of one shape in this file's history and the second
on this exact field: the desktop V2 detail carried `photo_urls` on the wire and
rendered nothing until 2026-08-10 (see the header of
`components/scm-v2/SoLinePhotoStrip.tsx`), and `remark` was "served by GET
/:docNo all along and rendered on neither platform until 2026-08-11" — its own
comment, four lines above where this field now sits.

It matters more than usual right now: the AutoCount cutover has just put the
imported reference photograph on 677 company-1 SO lines, and the phone is the
surface the floor actually carries.

**Fix.** `MobileLinePhotos` + `MobileLinePhoto` in `MobileSODetail.tsx`, rendered
in the line card under `MobileLineRemark`.

ONE LOGIC LAYER, TWO PRESENTATIONS — the owner's standing rule. Loading is
`useScmLinePhoto` from `vendor/scm/lib/so-line-photo`, the identical state
machine the desktop tile runs (signed URL -> authed proxy -> thumb tier, attempt
state scoped per effect run). Viewing is `MediaLightbox`, already the phone's
full-screen previewer on `MobilePMS`. Only the chrome differs: 64px tiles,
because a 32px table-cell thumbnail is not a finger target. Hand-mirroring the
resolver instead is exactly what made an earlier desktop draft render nothing
in production, and the three regressions that have lived in that state machine
were each found on screen rather than in CI.

Two details carried across deliberately rather than rediscovered: the lightbox
re-fetches the FULL object instead of reusing a tile's `src` (under the proxy
arm that is a blob: URL holding THUMB bytes, scoped to the tile's current effect
run), and the key is `encodeURIComponent`-ed for `MediaLightbox` so its slashes
survive as one path segment and Hono's `:photoKey` matches.

`err` is kept for the genuinely-broken case: if the proxy also fails a missing
photo must read AS missing rather than silently rendering nothing.

**Verified.** `tsc --noEmit` clean; `npm run lint` at ceiling (3,196 warnings,
none added). The rendered-DOM check could not be done against the local dev
server — it is a different origin from `erp.houzscentury.com`, so the session
does not carry, and entering the owner's password is not something an agent may
do. It is therefore verified on PROD after this merges, on the same order used
to find it.

**Ref.** fix/photo-coverage-audit, 2026-09-07.
