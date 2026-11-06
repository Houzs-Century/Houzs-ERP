// ----------------------------------------------------------------------------
// Sofa Compartment photos (PR — Commander 2026-05-28).
//
// Each compartment code (1A(LHF) / 1A(RHF) / 1NA / 2A(LHF) / 2A(RHF) / 2NA /
// CNR / L(LHF) / L(RHF) / STOOL / Console / …) gets a per-code hero photo
// commander uploads from Backend → Products & Maintenance → Sofa Compartments.
// POS Custom Builder reads the photo through these endpoints so the module
// catalogue no longer relies on the bundled /public/sofa-modules/*.png set.
//
// Storage layout — reuses the same SO_ITEM_PHOTOS R2 bucket that PR-F and
// PR #239 (product-models) use. New objects land under the
// `sofa-compartments/{code}/{uuid}.{ext}` prefix; no new bucket provisioning
// needed.
//
// Persistence — the per-code metadata lives in
// `maintenance_config_history.config.sofaCompartmentMeta[code].imageKey` on
// the master-scope row. Unlike pricing edits (which append a new effective-
// dated row), photo uploads MUTATE the current effective row's config —
// photos are metadata, not price changes, so an effective-date history for
// each upload would clutter the audit log without value. The current
// effective row is found via `effective_from <= today`.
//
// Endpoints (all routed under /maintenance-config/sofa-compartments/:code):
//   POST   /photo                    — multipart upload (auth: any signed-in staff)
//   DELETE /photo                    — delete + null the imageKey      (auth)
//   GET    /photo/:key               — proxy read for <img src>        (public:
//          mounted outside the auth gate by public-images.ts)
// ----------------------------------------------------------------------------

import { Hono, type Context } from 'hono';
import { getSupabaseService } from '../../db/supabase';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { todayMyt } from '../lib/my-time';
import { scopeToCompany } from '../lib/companyScope';
import { bumpConfigVersion } from '../../services/configCache';

export const sofaCompartmentPhotos = new Hono<{ Bindings: Env; Variables: Variables }>();

const PHOTO_MAX_BYTES = 2 * 1024 * 1024; // 2 MB — same as product-models

// Raster types only. image/svg+xml is deliberately EXCLUDED: an SVG served back
// from the public proxy as image/svg+xml executes embedded script when opened
// directly, which is a stored-XSS vector on the ERP/POS origin. The sibling public
// image routes (product-models, categories) restrict to raster for the same reason.
const photoExtFromMime = (mime: string): string | null => {
  const m = mime.toLowerCase();
  if (m === 'image/jpeg' || m === 'image/jpg') return 'jpg';
  if (m === 'image/png')                       return 'png';
  if (m === 'image/webp')                      return 'webp';
  return null;
};

// Content-types the public proxy is allowed to serve inline. Anything else
// (e.g. a legacy SVG uploaded before svg was dropped above) is served as an
// octet-stream download so it can never execute in the browser.
const RASTER_INLINE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** Encode a compartment code for use in URL paths. Codes may contain
 *  parens / dashes ("1A(LHF)", "WC-45") — encodeURIComponent handles both. */
const decodeCode = (raw: string): string => {
  try { return decodeURIComponent(raw); } catch { return raw; }
};

/** Build the R2 key for a given (code, photoId, ext) tuple. Code segment is
 *  encoded so parens / specials don't break the URL form when proxied back. */
const buildPhotoKey = (code: string, photoId: string, ext: string): string =>
  `sofa-compartments/${encodeURIComponent(code)}/${photoId}.${ext}`;

/** Guard: only let DELETE/upload-replace touch keys that live under this
 *  compartment's prefix. Stops an attacker-supplied imageKey from pointing
 *  at an unrelated R2 object. */
const isKeyInCompartmentPrefix = (key: string, code: string): boolean => {
  const prefix = `sofa-compartments/${encodeURIComponent(code)}/`;
  return key.startsWith(prefix);
};

type CompartmentMeta = {
  imageKey?: string;
  description?: string;
  defaultPriceSen?: number;
};

type MaintenanceConfig = {
  sofaCompartmentMeta?: Record<string, CompartmentMeta>;
  [key: string]: unknown;
};

/** True when `key` is the photo of `code` on some company's CURRENT master row.
 *  `rows` are master rows ordered newest effective first; the first row seen for
 *  a company is its current one, so a key from a superseded row never matches. */
export function isCurrentCompartmentPhoto(
  rows: ReadonlyArray<{ company_id: number | null; meta: Record<string, CompartmentMeta> | null }>,
  code: string,
  key: string,
): boolean {
  const seen = new Set<number | null>();
  for (const r of rows) {
    if (seen.has(r.company_id)) continue;
    seen.add(r.company_id);
    if (r.meta?.[code]?.imageKey === key) return true;
  }
  return false;
}

// ── Public photo proxy (no auth) ─────────────────────────────────────────
//
// Exported and mounted OUTSIDE the global auth gate by public-images.ts, so the
// POS and the Houzs SPA can draw compartment photos with a plain <img src>
// (which sends no bearer token). The registration below on this router is
// shadowed by that public mount. Security: the requested key must be the
// compartment's stored imageKey on a company's current master row before
// anything is streamed, so a guessed key can't leak an unrelated R2 object.
//
// No auth means no active company (an <img> sends no X-Company-Id), so this
// does not scopeToCompany: the key is a random uuid, and matching it against
// each company's current row is what picks the company.
export const compartmentPhotoProxyHandler = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  const code = decodeCode(c.req.param('code') ?? '');
  const key  = decodeCode(c.req.param('key') ?? '');

  if (!c.env.SO_ITEM_PHOTOS) {
    return c.json({ error: 'photo_bucket_not_configured' }, 500);
  }

  if (!isKeyInCompartmentPrefix(key, code)) {
    return c.json({ error: 'key_not_in_compartment' }, 404);
  }

  // getSupabaseService defaults to the scm schema, where this table lives; a
  // bare createClient would query the public schema instead.
  const { data: rows, error } = await getSupabaseService(c.env)
    .from('maintenance_config_history')
    .select('company_id, meta:config->sofaCompartmentMeta')
    .eq('scope', 'master')
    .lte('effective_from', todayMyt())
    .order('effective_from', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) return c.json({ error: 'load_failed' }, 500);

  if (!isCurrentCompartmentPhoto((rows ?? []) as never, code, key)) {
    return c.json({ error: 'photo_not_in_compartment' }, 404);
  }

  const obj = await c.env.SO_ITEM_PHOTOS.get(key);
  if (!obj) return c.json({ error: 'photo_not_found_in_r2' }, 404);

  // Clamp the served content-type to raster only. New uploads are already raster
  // (photoExtFromMime drops svg), but a legacy SVG in R2 must not be served as
  // image/svg+xml on this unauthenticated public route — that would execute script
  // on the POS/ERP origin. Fall back to octet-stream so it downloads inertly.
  const stored = (obj.httpMetadata?.contentType ?? '').toLowerCase().split(';')[0].trim();
  const safeType = RASTER_INLINE.has(stored) ? stored : 'application/octet-stream';
  return new Response(obj.body, {
    headers: {
      'content-type':  safeType,
      'x-content-type-options': 'nosniff',
      // Keys are immutable per upload — crypto.randomUUID() at :206 — so the
      // url names one fixed object and can be pinned. The hour was
      // conservatism; the proof already covered a year.
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
};
sofaCompartmentPhotos.get('/:code/photo/:key', compartmentPhotoProxyHandler);

// ── Auth gate ────────────────────────────────────────────────────────────
sofaCompartmentPhotos.use('*', supabaseAuth);

// ── POST /:code/photo ────────────────────────────────────────────────────
// Upload (or replace) the hero photo for a compartment code. Writes the new
// imageKey into the master-scope config row's sofaCompartmentMeta[code].
// The maintenance_config_history table is "append-only" by convention for
// pricing edits — photo updates mutate the current row in place (metadata,
// not pricing, so a new effective-date for each upload would just clutter).
sofaCompartmentPhotos.post('/:code/photo', async (c) => {
  const code = decodeCode(c.req.param('code'));
  const supabase = c.get('supabase');

  if (!c.env.SO_ITEM_PHOTOS) {
    return c.json({ error: 'photo_bucket_not_configured' }, 500);
  }

  // Load the current effective master-scope row.
  const today = todayMyt();
  const { data: row, error: rowErr } = await scopeToCompany(
    supabase.from('maintenance_config_history').select('id, config'),
    c,
  )
    .eq('scope', 'master')
    .lte('effective_from', today)
    .order('effective_from', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (rowErr) return c.json({ error: 'load_failed', reason: rowErr.message }, 500);
  if (!row) return c.json({ error: 'no_master_config', reason: 'Master maintenance config not seeded.' }, 404);

  // Parse + validate the multipart body before touching R2.
  let form: Record<string, unknown>;
  try {
    form = await c.req.parseBody();
  } catch (e) {
    return c.json({ error: 'invalid_multipart', reason: e instanceof Error ? e.message : String(e) }, 400);
  }
  const file = form.file as File | undefined;
  if (!file || typeof file === 'string') {
    return c.json({ error: 'file_field_required' }, 400);
  }

  const ext = file.type ? photoExtFromMime(file.type) : null;
  if (!ext) {
    return c.json({ error: 'unsupported_type', expected: 'image/jpeg | image/png | image/webp | image/svg+xml', got: file.type }, 400);
  }
  if (file.size > PHOTO_MAX_BYTES) {
    return c.json({ error: 'file_too_large', maxBytes: PHOTO_MAX_BYTES, got: file.size }, 400);
  }

  const u = c.get('user');
  if (!u?.id) return c.json({ error: 'auth_required' }, 401);

  const photoId  = crypto.randomUUID();
  const photoKey = buildPhotoKey(code, photoId, ext);

  try {
    await c.env.SO_ITEM_PHOTOS.put(photoKey, file.stream(), {
      httpMetadata:   { contentType: file.type },
      customMetadata: { compartmentCode: code, uploadedBy: u.id },
    });
  } catch (e) {
    return c.json({ error: 'r2_put_failed', reason: e instanceof Error ? e.message : String(e) }, 500);
  }

  // Merge the new imageKey into config.sofaCompartmentMeta[code]. Defensive
  // deep-clone so we don't mutate the Supabase response object in place.
  const cfg = JSON.parse(JSON.stringify(row.config as MaintenanceConfig)) as MaintenanceConfig;
  const meta = cfg.sofaCompartmentMeta ?? {};
  const prevKey = meta[code]?.imageKey ?? null;
  meta[code] = { ...(meta[code] ?? {}), imageKey: photoKey };
  cfg.sofaCompartmentMeta = meta;

  const { error: updErr } = await supabase
    .from('maintenance_config_history')
    .update({ config: cfg })
    .eq('id', row.id);
  if (updErr) {
    // Roll back the just-uploaded blob so we don't leak R2 storage.
    await c.env.SO_ITEM_PHOTOS.delete(photoKey).catch(() => {});
    return c.json({ error: 'db_update_failed', reason: updErr.message }, 500);
  }

  // The write above mutated the live master config row — orphan the
  // /maintenance-config/resolved read cache.
  await bumpConfigVersion(c.env, 'maintcfg');

  // Best-effort cleanup of the previous photo so commander doesn't leak R2
  // storage by overwriting. Only delete if the previous key sits under this
  // compartment's prefix — defensive against a manually-typed override.
  if (prevKey && prevKey !== photoKey && isKeyInCompartmentPrefix(prevKey, code)) {
    await c.env.SO_ITEM_PHOTOS.delete(prevKey).catch(() => {});
  }

  // Proxy URL the Backend Maintenance UI + POS catalog hit via <img src>.
  // Relative path keeps it portable across api.{env} domains. URL-encode
  // the code segment because it may contain parens / slashes ("1A(LHF)",
  // "Console/WC").
  const photoUrl = `/maintenance-config/sofa-compartments/${encodeURIComponent(code)}/photo/${encodeURIComponent(photoKey)}`;
  return c.json({ photoUrl, photoKey }, 201);
});

// ── DELETE /:code/photo ──────────────────────────────────────────────────
sofaCompartmentPhotos.delete('/:code/photo', async (c) => {
  const code = decodeCode(c.req.param('code'));
  const supabase = c.get('supabase');

  if (!c.env.SO_ITEM_PHOTOS) {
    return c.json({ error: 'photo_bucket_not_configured' }, 500);
  }

  const today = todayMyt();
  const { data: row, error: rowErr } = await scopeToCompany(
    supabase.from('maintenance_config_history').select('id, config'),
    c,
  )
    .eq('scope', 'master')
    .lte('effective_from', today)
    .order('effective_from', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (rowErr) return c.json({ error: 'load_failed', reason: rowErr.message }, 500);
  if (!row) return c.json({ error: 'no_master_config' }, 404);

  const cfg = JSON.parse(JSON.stringify(row.config as MaintenanceConfig)) as MaintenanceConfig;
  const meta = cfg.sofaCompartmentMeta ?? {};
  const cur  = meta[code];
  if (cur?.imageKey && isKeyInCompartmentPrefix(cur.imageKey, code)) {
    await c.env.SO_ITEM_PHOTOS.delete(cur.imageKey).catch(() => {});
  }

  if (cur) {
    // Keep the rest of the meta (description, default price) — only drop
    // the imageKey field so commander's other overrides aren't blown away.
    const { imageKey: _drop, ...rest } = cur;
    if (Object.keys(rest).length === 0) {
      delete meta[code];
    } else {
      meta[code] = rest;
    }
    cfg.sofaCompartmentMeta = meta;
  }

  const { error: updErr } = await supabase
    .from('maintenance_config_history')
    .update({ config: cfg })
    .eq('id', row.id);
  if (updErr) return c.json({ error: 'db_update_failed', reason: updErr.message }, 500);

  // Same as the upload path — the master config row changed.
  await bumpConfigVersion(c.env, 'maintcfg');

  return c.json({ ok: true });
});
