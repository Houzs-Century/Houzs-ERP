// ----------------------------------------------------------------------------
// Purchase Order per-line photos — the WRITE path (owner 2026-08-28).
//
//   POST   /api/scm/mfg-purchase-orders/:id/items/:itemId/photos
//   DELETE /api/scm/mfg-purchase-orders/:id/items/:itemId/photos/:photoKey
//
// Owner: 如果我要 add on 照片在 PO 而已的话 — a purchaser must be able to attach
// photos DIRECTLY on a PO line (a supplier's counter-sample, a revised drawing)
// without routing them through the Sales Order. Until now the PO column was
// read-only by design (mig 0274: authored on the SO, carried across).
//
// TWO OWNERSHIP CLASSES now live in one photo_urls column, told apart by KEY
// PREFIX, and the split is the whole design:
//
//   so-items/...  carried from the SO line (mig 0274) — SAME R2 objects, so
//                 they stay SO-owned here: deleting one from the PO is REFUSED
//                 (403 carried_photo_readonly); delete it on the SO and the
//                 carry semantics remove it from the PO view too.
//   po-items/...  authored on the PO — this route's uploads, and the AutoCount
//                 importer's historical po-items/... keys. PO-owned: deletable
//                 here, invisible to the SO, printed on the PO PDF only.
//
// A SEPARATE FILE mounted at the same prefix, same reason as
// delivery-order-item-photos.ts: mfg-purchase-orders.ts is at its file-size
// ceiling and a ceiling may only fall. The READ routes (signed + proxy) stay
// where they are in that file — this router adds only the writes.
//
// AUTHZ mirrors the SO upload route's shape: company-scoped parent + item
// membership before any byte is uploaded (service-role client bypasses RLS —
// the predicate here is the entire boundary, on the WRITE too). A CANCELLED PO
// refuses new photos; annotations on a live document move no stock and no
// money, so no downstream (GRN) lock applies.
// ----------------------------------------------------------------------------
import { Hono, type Context } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { scopeToCompany } from '../lib/companyScope';
import { deleteThumbFor, putOptionalThumb } from '../../services/photoThumbs';

export const purchaseOrderItemPhotos = new Hono<{ Bindings: Env; Variables: Variables }>();
purchaseOrderItemPhotos.use('*', supabaseAuth);

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // 10 MB — same ceiling as the SO route

/** PO-owned keys live under this prefix; everything else in photo_urls is a
 *  carried SO key (or a future producer) and is not this route's to delete. */
export const PO_PHOTO_KEY_PREFIX = 'po-items/';

export const isPoOwnedPhotoKey = (key: string): boolean => key.startsWith(PO_PHOTO_KEY_PREFIX);

export const poItemPhotoKey = (poId: string, itemId: string, photoId: string, ext: string): string =>
  `${PO_PHOTO_KEY_PREFIX}${poId}/${itemId}/${photoId}.${ext}`;

/* Same conservative whitelist as the SO upload route — the key suffix is
   cosmetic (Content-Type lives in R2 metadata). */
const extFromMime = (mime: string): string => {
  const m = mime.toLowerCase();
  if (m === 'image/jpeg' || m === 'image/jpg') return 'jpg';
  if (m === 'image/png')                       return 'png';
  if (m === 'image/webp')                      return 'webp';
  if (m === 'image/gif')                       return 'gif';
  if (m === 'image/heic')                      return 'heic';
  if (m === 'image/heif')                      return 'heif';
  if (m === 'image/avif')                      return 'avif';
  if (m.startsWith('image/'))                  return 'bin';
  return '';
};

type PoRow = { id: string; po_number: string; status: string };
type PoItemRow = { id: string; purchase_order_id: string; item_code: string; photo_urls: string[] | null };

/* One membership check for both routes: company-scoped PO, then the line, then
   the parent match. `maybeSingle` — the company predicate can legitimately
   match zero rows and that honest 404 must not surface as a 500. */
async function loadOwned(c: Ctx, poId: string, itemId: string): Promise<
  { ok: true; po: PoRow; item: PoItemRow } | { ok: false; res: Response }
> {
  const sb = c.get('supabase');
  const { data: po, error: poErr } = await scopeToCompany(sb
    .from('purchase_orders')
    .select('id, po_number, status')
    .eq('id', poId), c)
    .maybeSingle();
  if (poErr) return { ok: false, res: c.json({ error: 'po_lookup_failed', reason: poErr.message }, 500) };
  if (!po) return { ok: false, res: c.json({ error: 'po_not_found' }, 404) };

  const { data: item, error: itemErr } = await sb
    .from('purchase_order_items')
    .select('id, purchase_order_id, item_code, photo_urls')
    .eq('id', itemId)
    .maybeSingle();
  if (itemErr) return { ok: false, res: c.json({ error: 'item_lookup_failed', reason: itemErr.message }, 500) };
  if (!item) return { ok: false, res: c.json({ error: 'item_not_found' }, 404) };
  const i = item as PoItemRow;
  if (i.purchase_order_id !== poId) {
    return { ok: false, res: c.json({ error: 'item_doc_mismatch' }, 400) };
  }
  return { ok: true, po: po as PoRow, item: i };
}

purchaseOrderItemPhotos.post('/:id/items/:itemId/photos', async (c) => {
  const poId = c.req.param('id') ?? '';
  const itemId = c.req.param('itemId') ?? '';
  const user = c.get('user');

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Env TYPES the binding as always present, but a wrangler config without it delivers undefined at runtime; the SO upload route carries the same guard
  if (!c.env.SO_ITEM_PHOTOS) {
    return c.json({ error: 'photo_bucket_not_configured' }, 500);
  }

  const owned = await loadOwned(c, poId, itemId);
  if (!owned.ok) return owned.res;
  if (owned.po.status === 'CANCELLED') {
    return c.json({ error: 'po_cancelled' }, 409);
  }

  let form: Record<string, unknown>;
  try {
    form = await c.req.parseBody();
  } catch (e) {
    return c.json({ error: 'invalid_multipart', reason: e instanceof Error ? e.message : String(e) }, 400);
  }
  const file = form.file as File | undefined;
  if (!file || typeof file === 'string') return c.json({ error: 'file_field_required' }, 400);
  if (!file.type || !file.type.toLowerCase().startsWith('image/')) {
    return c.json({ error: 'invalid_mime', got: file.type || '(none)' }, 400);
  }
  if (file.size > MAX_PHOTO_BYTES) {
    return c.json({ error: 'file_too_large', maxBytes: MAX_PHOTO_BYTES, got: file.size }, 400);
  }

  const photoId = crypto.randomUUID();
  const photoKey = poItemPhotoKey(poId, itemId, photoId, extFromMime(file.type) || 'bin');

  try {
    await c.env.SO_ITEM_PHOTOS.put(photoKey, file.stream(), {
      httpMetadata: { contentType: file.type },
      customMetadata: {
        poNumber: owned.po.po_number,
        itemId,
        itemCode: owned.item.item_code,
        uploadedBy: user.id,
      },
    });
  } catch (e) {
    return c.json({ error: 'r2_put_failed', reason: e instanceof Error ? e.message : String(e) }, 500);
  }

  /* Client-generated thumbnail from the same multipart body, stored at
     `<photoKey>.thumb`. Best-effort — but it is what the PO PDF prints
     (pdf-item-photos fetches thumbs only), so the client should always send
     one (prepareImageForUpload does). */
  await putOptionalThumb(c.env.SO_ITEM_PHOTOS, form.thumb, photoKey, {
    poNumber: owned.po.po_number,
    itemId,
    uploadedBy: user.id,
  });

  /* Append on the WRITE with the parent predicate re-stated — nothing re-checks
     between two PostgREST round trips (CLAUDE.md company-scope rule b). */
  const nextKeys = [...(owned.item.photo_urls ?? []), photoKey];
  const sb = c.get('supabase');
  const { error: updErr } = await sb
    .from('purchase_order_items')
    .update({ photo_urls: nextKeys })
    .eq('id', itemId)
    .eq('purchase_order_id', poId);
  if (updErr) {
    await c.env.SO_ITEM_PHOTOS.delete(photoKey).catch(() => {});
    await deleteThumbFor(c.env.SO_ITEM_PHOTOS, photoKey);
    return c.json({ error: 'db_update_failed', reason: updErr.message }, 500);
  }

  return c.json({ photoKey, photoUrls: nextKeys }, 201);
});

purchaseOrderItemPhotos.delete('/:id/items/:itemId/photos/:photoKey', async (c) => {
  const poId = c.req.param('id') ?? '';
  const itemId = c.req.param('itemId') ?? '';
  const photoKey = decodeURIComponent(c.req.param('photoKey') ?? '');

  const owned = await loadOwned(c, poId, itemId);
  if (!owned.ok) return owned.res;
  if (!(owned.item.photo_urls ?? []).includes(photoKey)) {
    return c.json({ error: 'photo_not_in_item' }, 404);
  }
  /* The ownership split. A carried SO key is the SAME R2 object the SO line
     lists — deleting it here would blank the Sales Order's own photo. Refuse
     with the reason named; the SO detail is where that photo is managed. */
  if (!isPoOwnedPhotoKey(photoKey)) {
    return c.json({ error: 'carried_photo_readonly', manageOn: 'sales_order' }, 403);
  }

  const nextKeys = (owned.item.photo_urls ?? []).filter((k) => k !== photoKey);
  const sb = c.get('supabase');
  const { error: updErr } = await sb
    .from('purchase_order_items')
    .update({ photo_urls: nextKeys })
    .eq('id', itemId)
    .eq('purchase_order_id', poId);
  if (updErr) return c.json({ error: 'db_update_failed', reason: updErr.message }, 500);

  /* R2 cleanup AFTER the row no longer lists the key — a failed delete leaves
     an orphan blob (harmless), never a listed key with no object. */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- same runtime-absent-binding guard as the upload route
  if (c.env.SO_ITEM_PHOTOS) {
    await c.env.SO_ITEM_PHOTOS.delete(photoKey).catch(() => {});
    await deleteThumbFor(c.env.SO_ITEM_PHOTOS, photoKey);
  }

  return c.json({ photoUrls: nextKeys });
});
