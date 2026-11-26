
import { Hono, type Context } from 'hono';
import { getSupabaseService } from '../../db/supabase';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { todayMyt } from '../lib/my-time';
import { scopeToCompany } from '../lib/companyScope';
import { bumpConfigVersion } from '../../services/configCache';

export const sofaCompartmentPhotos = new Hono<{ Bindings: Env; Variables: Variables }>();

const PHOTO_MAX_BYTES = 2 * 1024 * 1024;

const photoExtFromMime = (mime: string): string | null => {
  const m = mime.toLowerCase();
  if (m === 'image/jpeg' || m === 'image/jpg') return 'jpg';
  if (m === 'image/png')                       return 'png';
  if (m === 'image/webp')                      return 'webp';
  return null;
};

const RASTER_INLINE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const decodeCode = (raw: string): string => {
  try { return decodeURIComponent(raw); } catch { return raw; }
};

const buildPhotoKey = (code: string, photoId: string, ext: string): string =>
  `sofa-compartments/${encodeURIComponent(code)}/${photoId}.${ext}`;

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

export const compartmentPhotoProxyHandler = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  const code = decodeCode(c.req.param('code') ?? '');
  const key  = decodeCode(c.req.param('key') ?? '');

  if (!c.env.SO_ITEM_PHOTOS) {
    return c.json({ error: 'photo_bucket_not_configured' }, 500);
  }

  if (!isKeyInCompartmentPrefix(key, code)) {
    return c.json({ error: 'key_not_in_compartment' }, 404);
  }

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

  const stored = (obj.httpMetadata?.contentType ?? '').toLowerCase().split(';')[0].trim();
  const safeType = RASTER_INLINE.has(stored) ? stored : 'application/octet-stream';
  return new Response(obj.body, {
    headers: {
      'content-type':  safeType,
      'x-content-type-options': 'nosniff',
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
};
sofaCompartmentPhotos.get('/:code/photo/:key', compartmentPhotoProxyHandler);

sofaCompartmentPhotos.use('*', supabaseAuth);

sofaCompartmentPhotos.post('/:code/photo', async (c) => {
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
  if (!row) return c.json({ error: 'no_master_config', reason: 'Master maintenance config not seeded.' }, 404);

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
    await c.env.SO_ITEM_PHOTOS.delete(photoKey).catch(() => {});
    return c.json({ error: 'db_update_failed', reason: updErr.message }, 500);
  }

  await bumpConfigVersion(c.env, 'maintcfg');

  if (prevKey && prevKey !== photoKey && isKeyInCompartmentPrefix(prevKey, code)) {
    await c.env.SO_ITEM_PHOTOS.delete(prevKey).catch(() => {});
  }

  const photoUrl = `/maintenance-config/sofa-compartments/${encodeURIComponent(code)}/photo/${encodeURIComponent(photoKey)}`;
  return c.json({ photoUrl, photoKey }, 201);
});

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

  await bumpConfigVersion(c.env, 'maintcfg');

  return c.json({ ok: true });
});
