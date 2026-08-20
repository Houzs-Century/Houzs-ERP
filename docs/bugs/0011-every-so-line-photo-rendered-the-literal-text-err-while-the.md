## Every SO line photo rendered the literal text "err" while the photos were fine [high]

**Symptom** — on SO line cards, every saved photo tile showed the literal text
`err` instead of the image. Reported after 983 imported AutoCount photos landed
in R2 and none of them would display.

**Root cause (traced, not guessed)** — two independent things, and only the
second is ours to fix here.

1. `GET .../photos/<key>/signed` answers
   `500 {"error":"signing_failed","reason":"R2_ACCESS_KEY_ID not configured"}`.
   Signing needs the R2 **S3-API** credentials (`R2_ACCESS_KEY_ID` /
   `R2_SECRET_ACCESS_KEY` / `R2_ENDPOINT`), which are wrangler SECRETS that
   were never provisioned in production.
2. `PhotoThumb` treated that 500 as *the photo is broken* and rendered `err`.
   It never fell back — even though `GET .../photos/<key>` (the authed proxy,
   which streams via the Worker's **R2 binding** and needs no credentials at
   all) returned the same photo `200 image/jpeg` the whole time. Verified live
   against production on 2026-08-10: the signed route 500s and the proxy route
   serves the identical key.

So a signing failure was being reported to the operator as a missing photo. The
objects were in R2, readable, one working route away.

**Fix** — `PhotoThumb` now falls back to the authed proxy when `/signed` fails
or hands back a URL an `<img>` cannot load directly. The proxy URL **cannot**
be an `<img src>`: it is behind bearer auth and an `<img>` tag sends no
`Authorization` header — this app has no cookie session at all (0 `Set-Cookie`
in `backend/src`, 0 `credentials:` in `frontend/src`; the auth middleware reads
only the `Authorization` header). So the bytes are fetched with the token and
handed to `<img>` as a `blob:` object URL, the same mechanism `slip.ts` already
uses for payment slips — and for the same underlying reason, which that file
documents: *"Houzs prod never provisioned the R2 S3-API creds those need (every
/slips/init 500'd)"*. The blob is **revoked on unmount**; a photo grid mounts
and unmounts repeatedly, so leaking one image blob per tile per open is real.

`err` is deliberately KEPT for the genuinely-broken case — proxy 404 (missing
key) or 401/403 (refused). A missing photo must still be visible AS missing;
silently rendering nothing would be a different bug.

**Trap for the next person** — `backend/src/scm/routes/public-images.ts:5-7`
claims the SPA passes the auth gate with "its session cookie", so its `<img
src=...>` loads fine. That is **false**; there is no cookie session.
`backend/src/index.ts:282-284` states the opposite and is correct. Anyone who
trusts the `public-images.ts` comment will ship an `<img src>` fallback that
401s. Corrected in this PR.

**Not covered** — PO and consignment line photos still will not render, for a
different reason: no PO frontend component renders line photos at all
(`photoUrls` reaches the client and is discarded), and `ConsignmentOrderDetail`
never maps `photo_urls` into the `SoLineCard` draft. That is missing UI, not
this fallback.

**Ref** — PR fix/photo-tile-fallback, 2026-08-10. Test:
`frontend/src/vendor/scm/components/SoLinePhotoFallback.test.tsx`.
