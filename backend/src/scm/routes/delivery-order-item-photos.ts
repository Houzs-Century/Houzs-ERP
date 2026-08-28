// ----------------------------------------------------------------------------
// Delivery Order per-line photos — the READ path (mig 20260828T0746).
//
//   GET /api/scm/delivery-orders-mfg/:id/items/:itemId/photos/:photoKey/signed
//   GET /api/scm/delivery-orders-mfg/:id/items/:itemId/photos/:photoKey
//
// Owner 2026-08-10 rule, DO leg: a DO raised from an SO line carries that
// line's photos (送货时照片要跟着 line — the driver and the customer must see the
// same reference shot the salesperson attached), so the DO detail must be able
// to SHOW them. The keys ride on the detail row (delivery-orders-mfg.ts ITEM);
// these two routes are the exact contract the SO and PO surfaces already use
// (mfg-sales-orders.ts / mfg-purchase-orders.ts `/photos/:photoKey(/signed)`),
// so one client code path drives all three.
//
// A SEPARATE FILE, mounted at the same prefix, and that is not a style choice:
// delivery-orders-mfg.ts is already past its file-size ceiling
// (scripts/file-size-ceilings.json), a ceiling may only FALL, and this prefix
// already mounts a second router for exactly that reason
// (delivery-order-scan-token.ts; scm/index.ts also does it for /grns,
// /purchase-invoices and /mfg-sales-orders).
//
// Deliberately READ-ONLY. Photos are authored on the SO (the upload route's
// `so-items/...` keys, copied here by the SO->DO carry); nothing writes photos
// onto a DO line directly, and no prefix rule exists to lock out a future
// producer — the PO column gained the AutoCount importer's `po-items/...` keys
// after shipping with only one producer, and this column may grow the same way.
// All keys live in ONE bucket (binding SO_ITEM_PHOTOS), so both routes serve
// any listed key unchanged.
//
// AUTHZ is MEMBERSHIP, never key shape: the key must be listed in THIS line's
// photo_urls and the line must belong to THIS delivery order and to the active
// company (scopeToCompany — same predicate as the DO detail GET, so photos are
// visible exactly where the document is; the service-role client bypasses RLS,
// so this predicate is the entire boundary). A guessed key signs nothing. A
// `.thumb` sibling is authorised against its BASE key, because thumbs are never
// themselves listed in photo_urls.
//
// The /signed route falls back to the proxy payload when the R2 S3 credentials
// are unset — which is production's permanent state (2026-08-10 incident, see
// scm/lib/photoProxyFallback.ts for why the fallback is NOT returned as
// `signedUrl`). The proxy route streams from the R2 BINDING (no credential),
// but sits behind the global auth gate, so it is NOT usable as a bare
// <img src> — clients fetch it authed and hand <img> a blob: URL.
// ----------------------------------------------------------------------------
import { Hono, type Context } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { scopeToCompany } from '../lib/companyScope';
import { signSoItemPhotoUrl, soItemPhotoBindings } from '../lib/r2';
import { baseKeyOf, thumbKeyFor } from '../../services/photoThumbs';
import { proxyFallbackPayload, type PhotoUrlPayload } from '../lib/photoProxyFallback';

export const deliveryOrderItemPhotos = new Hono<{ Bindings: Env; Variables: Variables }>();
deliveryOrderItemPhotos.use('*', supabaseAuth);

type DoLinePhotoRow = { delivery_order_id: string; photo_urls: string[] | null };

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

/* One membership check for both routes. `maybeSingle`, not `single`: the
   company predicate can legitimately match zero rows, and that honest 404 must
   not surface as a 500. Returns the line or the refusal response. */
async function loadOwnedLine(c: Ctx, doId: string, itemId: string): Promise<
  { ok: true; line: DoLinePhotoRow } | { ok: false; res: Response }
> {
  const sb = c.get('supabase');
  const { data: item } = await scopeToCompany(sb
    .from('delivery_order_items')
    .select('delivery_order_id, photo_urls')
    .eq('id', itemId), c)
    .maybeSingle();
  if (!item) return { ok: false, res: c.json({ error: 'item_not_found' }, 404) };
  const line = item as DoLinePhotoRow;
  if (line.delivery_order_id !== doId) {
    return { ok: false, res: c.json({ error: 'item_doc_mismatch' }, 400) };
  }
  return { ok: true, line };
}

export const doItemPhotoSignedHandler = async (c: Ctx) => {
  /* `?? ''` — the exported-handler Context carries no param inference; an empty
     id/key simply matches no row / no listed key and 404s honestly. */
  const doId = c.req.param('id') ?? '';
  const itemId = c.req.param('itemId') ?? '';
  const photoKey = decodeURIComponent(c.req.param('photoKey') ?? '');

  const owned = await loadOwnedLine(c, doId, itemId);
  if (!owned.ok) return owned.res;
  if (!(owned.line.photo_urls ?? []).includes(photoKey)) {
    return c.json({ error: 'photo_not_in_item' }, 404);
  }

  try {
    const bindings = soItemPhotoBindings(c.env);
    const { signedUrl, expiresAt } = await signSoItemPhotoUrl(bindings, photoKey);
    // Signed thumb sibling. A photo uploaded before thumbnails existed has no
    // `.thumb` object — the URL 404s and the client falls back to signedUrl.
    const { signedUrl: thumbUrl } = await signSoItemPhotoUrl(bindings, thumbKeyFor(photoKey));
    const payload: PhotoUrlPayload = { mode: 'signed', signedUrl, thumbUrl, expiresAt };
    return c.json(payload);
  } catch (e) {
    /* R2 S3 creds unset in prod => signing throws for every photo. Fall back to
       the proxy route below (R2 binding, no creds needed) rather than 500. */
    return c.json(
      proxyFallbackPayload(
        'do-item-photo',
        `/delivery-orders-mfg/${doId}/items/${itemId}`,
        photoKey,
        e,
      ),
    );
  }
};

deliveryOrderItemPhotos.get('/:id/items/:itemId/photos/:photoKey/signed', doItemPhotoSignedHandler);

export const doItemPhotoProxyHandler = async (c: Ctx) => {
  const doId = c.req.param('id') ?? '';
  const itemId = c.req.param('itemId') ?? '';
  const photoKey = decodeURIComponent(c.req.param('photoKey') ?? '');

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Env TYPES the binding as always present, but a wrangler config without it delivers undefined at runtime; the PO proxy carries the same guard
  if (!c.env.SO_ITEM_PHOTOS) {
    return c.json({ error: 'photo_bucket_not_configured' }, 500);
  }

  const owned = await loadOwnedLine(c, doId, itemId);
  if (!owned.ok) return owned.res;
  /* Membership against the BASE key, so a `.thumb` request is authorised by the
     photo it belongs to — thumbs are never themselves listed in photo_urls. */
  if (!(owned.line.photo_urls ?? []).includes(baseKeyOf(photoKey))) {
    return c.json({ error: 'photo_not_in_item' }, 404);
  }

  const obj = await c.env.SO_ITEM_PHOTOS.get(photoKey);
  if (!obj) return c.json({ error: 'photo_not_found_in_r2' }, 404);

  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      // Keys are immutable per object (uuid-named), so a replaced photo is a
      // different key. `private` — delivery photos are not public.
      'cache-control': 'private, max-age=31536000, immutable',
    },
  });
};

deliveryOrderItemPhotos.get('/:id/items/:itemId/photos/:photoKey', doItemPhotoProxyHandler);
