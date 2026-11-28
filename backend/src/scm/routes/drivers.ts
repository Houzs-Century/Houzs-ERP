
import { idOrNull } from '../lib/lorry-warehouses';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { normalizePhone } from '../shared';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { activeCompanyId } from '../lib/companyScope';
import { carrierLinkForInsert, resolveCarrierLink } from '../lib/threepl-link';
import { nextCode, CODE_PREFIX } from '../lib/fleet-code-mint';
import { normalizeIc, INVALID_IC, NAME_MAX } from '../lib/fleet-crew-fields';
import { driverProfilePatch } from '../lib/driver-profile-fields';
import { avatarCacheControl } from '../../lib/avatar-cache';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

async function mintDriverCode(sb: { from: (t: string) => any }): Promise<string> {
  const { data } = await sb.from('drivers').select('driver_code');
  return nextCode(CODE_PREFIX.DRIVER, ((data ?? []) as Array<{ driver_code?: string | null }>).map((r) => r.driver_code));
}

export const drivers = new Hono<{ Bindings: Env; Variables: Variables }>();
drivers.use('*', supabaseAuth);

const COLS = 'id, driver_code, name, phone, ic_number, vehicle, in_house, threepl_company_id, active, created_at, warehouse_id, photo_r2_key, license_no, license_expiry, address, emergency_contact_name, emergency_contact_phone';

const PHOTO_MAX_BYTES = 5 * 1024 * 1024;

const ownFlagOf = (body: Record<string, unknown>): boolean | undefined =>
  body.inHouse === undefined ? undefined : body.inHouse !== false;
const carrierOf = (body: Record<string, unknown>): string | null | undefined =>
  body.threeplCompanyId as string | null | undefined;

export const listDriversHandler = async (c: Ctx) => {
  const sb = c.get('supabase');
  const onlyActive = c.req.query('active') !== 'false';
  let q = sb.from('drivers').select(COLS).order('driver_code');
  if (onlyActive) q = q.eq('active', true);
  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ drivers: data ?? [] });
};

export const createDriverHandler = async (c: Ctx) => {
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const suppliedCode = String(body.driverCode ?? '').trim();
  const name = String(body.name ?? '').trim();
  const phone = String(body.phone ?? '').trim();
  if (!name) return c.json({ error: 'name_required' }, 400);
  if (name.length > NAME_MAX) return c.json({ error: 'name_too_long', reason: `Keep the name under ${NAME_MAX} characters.` }, 400);
  if (!phone) return c.json({ error: 'phone_required' }, 400);

  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return c.json({ error: 'invalid_phone', reason: 'That is not a usable phone number.' }, 400);

  const icNumber = normalizeIc(body.icNumber);
  if (icNumber === INVALID_IC) return c.json({ error: 'invalid_ic', reason: 'An IC / passport number is at most 20 characters.' }, 400);

  const home = idOrNull(body.warehouseId ?? null);
  if (!home.ok) return c.json({ error: 'invalid_id', reason: 'warehouseId must be a warehouse id or blank' }, 400);

  const profile = driverProfilePatch(body);
  if (!profile.ok) return c.json({ error: profile.error, reason: profile.reason }, 400);

  const link = carrierLinkForInsert({ threeplCompanyId: carrierOf(body), ownFlag: ownFlagOf(body) });

  const sb = c.get('supabase');

  /* Codes are MINTED, not typed (owner 2026-08-02). An explicit code is still
     honoured so an import can carry real ones, but the UI no longer sends the
     field and the placeholder that produced DRV-05 beside DRV-050 is gone.

     Read scope is GLOBAL and that is deliberate: driver_code carries a bare
     UNIQUE(driver_code), and this roster is one shared list across companies
     (see the list handler). Minting per company would collide across tenants. */
  const row = {
    company_id: activeCompanyId(c),
    name,
    phone: normalizedPhone,
    ic_number: icNumber,
    vehicle: (body.vehicle as string) ?? null,
    in_house: link.ownFlag,
    threepl_company_id: link.carrierId,
    active: body.active === false ? false : true,
    warehouse_id: home.value,
    ...profile.fields,
  };

  for (let attempt = 0; attempt < 4; attempt++) {
    const driverCode = suppliedCode || await mintDriverCode(sb);
    const { data, error } = await sb.from('drivers')
      .insert({ ...row, driver_code: driverCode }).select(COLS).single();
    if (!error) return c.json({ driver: data }, 201);
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    if (error.code !== '23505') return c.json({ error: 'insert_failed', reason: error.message }, 500);
    if (suppliedCode) return c.json({ error: 'duplicate_code' }, 409);
  }
  return c.json({ error: 'code_mint_failed', reason: 'Could not allocate a driver code.' }, 500);
};

export const patchDriverHandler = async (c: Ctx) => {
  // company-scope: UNIFIED FLEET — deliberate, not an oversight. lorries.ts:132
  // and drivers.ts:24-26,48 declare one shared fleet/roster across ALL companies
  // ("every company's TMS page shows the same lorries/drivers"), and driver_code
  // carries a bare UNIQUE so per-company minting would collide across tenants.
  // scm.lorry_service_records' own DDL (mig 0121) spells out the consequence:
  // company_id is stamped on insert but "NOT used to scope reads", because a
  // lorry's history must be visible wherever the lorry is. Verified 2026-08-13
  // against the DDL and both route declarations before deciding NOT to change
  // this handler.
  const id = c.req.param('id');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  const updates: Record<string, unknown> = {};
  if (body.warehouseId !== undefined) {
    const home = idOrNull(body.warehouseId);
    if (!home.ok) return c.json({ error: 'invalid_id', reason: 'warehouseId must be a warehouse id or blank' }, 400);
    updates.warehouse_id = home.value;
  }
  const map: Array<[string, string]> = [
    ['driverCode', 'driver_code'], ['name', 'name'], ['vehicle', 'vehicle'],
  ];
  for (const [from, to] of map) {
    if (body[from] === undefined) continue;
    updates[to] = body[from];
  }
  if (typeof updates.name === 'string') {
    const n = updates.name.trim();
    if (!n) return c.json({ error: 'name_required' }, 400);
    if (n.length > NAME_MAX) return c.json({ error: 'name_too_long', reason: `Keep the name under ${NAME_MAX} characters.` }, 400);
    updates.name = n;
  }
  if (body.phone !== undefined) {
    const normalized = normalizePhone(String(body.phone ?? ''));
    if (!normalized) return c.json({ error: 'invalid_phone', reason: 'That is not a usable phone number.' }, 400);
    updates.phone = normalized;
  }
  if (body.icNumber !== undefined) {
    const ic = normalizeIc(body.icNumber);
    if (ic === INVALID_IC) return c.json({ error: 'invalid_ic', reason: 'An IC / passport number is at most 20 characters.' }, 400);
    updates.ic_number = ic;
  }
  const profile = driverProfilePatch(body);
  if (!profile.ok) return c.json({ error: profile.error, reason: profile.reason }, 400);
  Object.assign(updates, profile.fields);
  /* The Fleet grid's Outsource tick-box posts only the flag, so the current
     link has to come from the row — resolveCarrierLink cannot see it otherwise
     and the two fields silently disagree (owner, 2026-08-02). */
  const sbCur = c.get('supabase');
  const { data: curRow, error: curErr } = await sbCur
    .from('drivers').select('threepl_company_id').eq('id', id).maybeSingle();
  if (curErr) return c.json({ error: 'load_failed', reason: curErr.message }, 500);
  if (!curRow) return c.json({ error: 'driver_not_found' }, 404);

  const link = resolveCarrierLink({
    threeplCompanyId: carrierOf(body),
    ownFlag: ownFlagOf(body),

    currentCarrierId: (curRow.threepl_company_id ?? null) as string | null,
  });
  if (link.conflict === 'own_flag_while_linked') {
    return c.json({
      error: 'linked_to_carrier',
      reason: 'This row belongs to a 3PL company. Detach it from the carrier first, then mark it in-house.',
    }, 409);
  }
  if (link.carrierId !== undefined) updates.threepl_company_id = link.carrierId;
  if (link.ownFlag !== undefined) updates.in_house = link.ownFlag;
  if (body.active !== undefined) updates.active = Boolean(body.active);

  if (Object.keys(updates).length === 0) return c.json({ error: 'no_changes' }, 400);

  const sb = c.get('supabase');
  const { data, error } = await sb.from('drivers').update(updates).eq('id', id).select(COLS).single();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  return c.json({ driver: data });
};

export const getDriverPhotoHandler = async (c: Ctx) => {
  // company-scope: unified fleet roster — scm.drivers is one shared list across
  // all companies (see the list handler and the PATCH handler's note), so, like
  // every by-id access here, the photo is read by id with no company predicate.
  const id = c.req.param('id');
  const sb = c.get('supabase');
  const { data: row, error } = await sb
    .from('drivers').select('photo_r2_key').eq('id', id).maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!row?.photo_r2_key) return c.json({ error: 'No photo' }, 404);
  const obj = await c.env.POD_BUCKET.get(row.photo_r2_key as string);
  if (!obj) return c.json({ error: 'Image missing' }, 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('cache-control', avatarCacheControl(c.req.query('k'), row.photo_r2_key as string));
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(obj.body, { headers });
};

export const postDriverPhotoHandler = async (c: Ctx) => {
  // company-scope: unified fleet roster — the photo is set by id exactly as the
  // PATCH handler above sets a driver's other fields; scm.drivers is one shared
  // list across companies, so there is no company predicate to apply on this write.
  const id = c.req.param('id');
  const filename = c.req.query('name') || `driver-${Date.now()}.bin`;
  const contentType = c.req.header('content-type') || 'application/octet-stream';
  const buf = await c.req.arrayBuffer();
  if (!buf.byteLength) return c.json({ error: 'Empty body' }, 400);
  if (buf.byteLength > PHOTO_MAX_BYTES) return c.json({ error: 'Image must be under 5 MB' }, 413);

  const key = `driver/${id}/${Date.now()}-${filename.replace(/[^\w.\-]+/g, '_')}`;
  await c.env.POD_BUCKET.put(key, buf, { httpMetadata: { contentType } });

  const sb = c.get('supabase');
  const { error } = await sb
    .from('drivers').update({ photo_r2_key: key }).eq('id', id).select('id').single();
  if (error) {
    if (error.code === 'PGRST116') return c.json({ error: 'driver_not_found' }, 404);
    return c.json({ error: 'update_failed', reason: error.message }, 500);
  }
  return c.json({ ok: true, photo_r2_key: key });
};

drivers.get('/', listDriversHandler);
drivers.post('/', createDriverHandler);
drivers.patch('/:id', patchDriverHandler);
drivers.get('/:id/photo', getDriverPhotoHandler);
drivers.post('/:id/photo', postDriverPhotoHandler);

export default drivers;
