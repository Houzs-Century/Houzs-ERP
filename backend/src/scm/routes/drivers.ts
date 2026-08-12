// ----------------------------------------------------------------------------
// /drivers — CRUD for the scm.drivers table. Used to populate the DO driver
// picker so we stop relying on free-text names.
//
// Houzs adaptation: ported from 2990's apps/api/src/routes/drivers.ts. Same
// plumbing as the sibling SCM routes — supabaseAuth bridge + scm-scoped service
// client via c.get('supabase'). The only change vs 2990 is the normalizePhone
// import: @2990s/shared/phone → ../shared (the vendored shared barrel). The
// scm.drivers table already exists (2990s-full-schema.sql) with the same shape:
// id / driver_code / name / phone / ic_number / vehicle / active / created_at.
//
// Mounted at '/drivers' in scm/index.ts.
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { normalizePhone } from '../shared';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { activeCompanyId } from '../lib/companyScope';
import { carrierLinkForInsert, resolveCarrierLink } from '../lib/threepl-link';
import { nextCode, CODE_PREFIX } from '../lib/fleet-code-mint';
import { normalizeIc, INVALID_IC, NAME_MAX } from '../lib/fleet-crew-fields';

/** The next DRV- code. Read scope is GLOBAL because driver_code carries a bare
 *  UNIQUE(driver_code) and the roster is one shared list across companies —
 *  minting per company would collide across tenants. */
async function mintDriverCode(sb: { from: (t: string) => any }): Promise<string> {
  const { data } = await sb.from('drivers').select('driver_code');
  return nextCode(CODE_PREFIX.DRIVER, ((data ?? []) as Array<{ driver_code?: string | null }>).map((r) => r.driver_code));
}

export const drivers = new Hono<{ Bindings: Env; Variables: Variables }>();
drivers.use('*', supabaseAuth);

const COLS = 'id, driver_code, name, phone, ic_number, vehicle, in_house, threepl_company_id, active, created_at';

/* The caller's in_house as a tri-state: absent stays absent (see threepl-link). */
const ownFlagOf = (body: Record<string, unknown>): boolean | undefined =>
  body.inHouse === undefined ? undefined : body.inHouse !== false;
const carrierOf = (body: Record<string, unknown>): string | null | undefined =>
  body.threeplCompanyId as string | null | undefined;

drivers.get('/', async (c) => {
  const sb = c.get('supabase');
  const onlyActive = c.req.query('active') !== 'false';   // default: active only
  let q = sb.from('drivers').select(COLS).order('driver_code');
  if (onlyActive) q = q.eq('active', true);
  // UNIFIED FLEET: the driver roster is one shared list across ALL companies —
  // every company's TMS page shows the same drivers regardless of the viewer's
  // company grants. company_id on a row is only a "created-by" stamp, not an
  // isolation boundary. So we deliberately do NOT scope this read by company.
  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ drivers: data ?? [] });
});

drivers.post('/', async (c) => {
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const suppliedCode = String(body.driverCode ?? '').trim();
  const name = String(body.name ?? '').trim();
  const phone = String(body.phone ?? '').trim();
  if (!name) return c.json({ error: 'name_required' }, 400);
  if (name.length > NAME_MAX) return c.json({ error: 'name_too_long', reason: `Keep the name under ${NAME_MAX} characters.` }, 400);
  if (!phone) return c.json({ error: 'phone_required' }, 400);

  /* Task #91 — store driver phone in E.164. It used to fall back to the RAW
     string when normalisation failed (`?? phone`), so "abc" was stored as
     "abc" and the field silently stopped being a phone number. A value that
     cannot be normalised is not a phone; say so instead of keeping it. */
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return c.json({ error: 'invalid_phone', reason: 'That is not a usable phone number.' }, 400);

  const icNumber = normalizeIc(body.icNumber);
  if (icNumber === INVALID_IC) return c.json({ error: 'invalid_ic', reason: 'An IC / passport number is at most 20 characters.' }, 400);

  /* A driver registered under a 3PL carrier is outsource, whatever was ticked. */
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
  };

  /* Retry the MINT, never the whole create: the only thing that can race is the
     number, and re-reading the highest is exactly what settles it. A 23505 that
     is NOT the code is the caller's problem and must not be retried. */
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
});

drivers.patch('/:id', async (c) => {
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
  /* The SAME rules the create path applies. They used to differ — create
     normalised the phone and PATCH did too, but both fell back to the raw
     string, and neither touched the IC or capped the name. A field validated
     on create and not on edit is validated nowhere. */
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
});

export default drivers;
