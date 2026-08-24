## Photos still rendered "err" after the bucket-name fix — the SAME symptom, a SECOND missing config [high]

**Symptom** — the entry below ("Every SO line photo rendered as `err`") was fixed
on 2026-08-10 by adding `SO_ITEM_PHOTOS_BUCKET_NAME`, and photos still showed
`err` in production. The 983 imported AutoCount photos remained invisible.

**Root cause (traced live, not guessed)** — `soItemPhotoBindings()` validates
FOUR values one at a time and throws on the first missing one. Fixing the bucket
name simply advanced the failure to the next line. Hit from the owner's
authenticated browser session:

```
GET /api/scm/mfg-sales-orders/HC-SO-002609/items/<id>/photos/<key>/signed
  -> 500 {"error":"signing_failed","reason":"R2_ACCESS_KEY_ID not configured"}
GET /api/scm/mfg-sales-orders/HC-SO-002609/items/<id>/photos/<key>
  -> 200 image/jpeg 7036 bytes          <- the SAME photo, via the PROXY route
```

`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_ENDPOINT` are wrangler SECRETS
and were never provisioned. The photos were never missing and the R2 *binding*
could read them the whole time — only the SigV4 URL-minting path was broken.

**Fix** — the read path no longer depends on a credential it does not need.
SO / PO / consignment `/signed` fall back to the proxy path (`200
{ mode:'proxy', proxyPath, … }`) instead of 500ing. The PO surface had ONLY a
`/signed` route, so a proxy was added for it, carrying the PO route's own authz
INCLUDING `scopeToCompany` — the SO proxy omits company scoping because its
`/signed` twin does too, but omitting it on the PO side would have made the
fallback strictly more permissive than the route it backs up. Signing is still
tried first, so the fallback never becomes the default read path.

**The trap this fix had to avoid** — the obvious "fix" is to return the proxy URL
as `signedUrl`. It does not work, and it fails INVISIBLY. A signed R2 URL carries
its signature in the query string, so it works as a bare `<img src>`; the proxy
sits behind the global auth gate, which reads the bearer token from the
`Authorization` HEADER only (`middleware/auth.ts`). There is no cookie session in
this app — `Set-Cookie` appears nowhere in `backend/src`. A browser sends no
header on an `<img src>`, so that "fix" trades a visible 500 for a silent 401 and
the tile stays blank while the code looks correct. The response therefore carries
a `mode` discriminator and leaves `signedUrl` undefined in the proxy branch, so
the value cannot be misused; the client fetches it as a Blob and uses
`URL.createObjectURL`. A comment in `public-images.ts` asserting the opposite
("the same-origin SPA passes that with its session cookie") was false and is
corrected in this PR.

**The class, for next time** — a config validator that throws on the FIRST
missing variable turns one outage into N sequential outages, each looking like a
new bug. When a check reports a missing setting, enumerate the rest before
declaring it fixed. And a read path should degrade to a slower route that works
rather than fail, when one exists at zero configuration.

**Ref** — 2026-08-10, PR fix/photo-proxy-fallback.
