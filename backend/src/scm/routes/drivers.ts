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
  const driverCode = String(body.driverCode ?? '').trim();
  const name = String(body.name ?? '').trim();
  const phone = String(body.phone ?? '').trim();
  if (!driverCode) return c.json({ error: 'code_required' }, 400);
  if (!name)       return c.json({ error: 'name_required' }, 400);
  if (!phone)      return c.json({ error: 'phone_required' }, 400);
  /* Task #91 — store driver phone in E.164. */
  const normalizedPhone = normalizePhone(phone) ?? phone;
  /* A driver registered under a 3PL carrier is outsource, whatever was ticked. */
  const link = carrierLinkForInsert({ threeplCompanyId: carrierOf(body), ownFlag: ownFlagOf(body) });

  const sb = c.get('supabase');
  const { data, error } = await sb.from('drivers').insert({
    company_id: activeCompanyId(c),
    driver_code: driverCode,
    name,
    phone: normalizedPhone,
    ic_number: (body.icNumber as string) ?? null,
    vehicle: (body.vehicle as string) ?? null,
    in_house: link.ownFlag,
    threepl_company_id: link.carrierId,
    active: body.active === false ? false : true,
  }).select(COLS).single();
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_code' }, 409);
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  return c.json({ driver: data }, 201);
});

drivers.patch('/:id', async (c) => {
  const id = c.req.param('id');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  const updates: Record<string, unknown> = {};
  const map: Array<[string, string]> = [
    ['driverCode', 'driver_code'], ['name', 'name'], ['phone', 'phone'],
    ['icNumber', 'ic_number'], ['vehicle', 'vehicle'],
  ];
  for (const [from, to] of map) {
    if (body[from] === undefined) continue;
    /* Task #91 — normalize phone to E.164 on PATCH. */
    if (from === 'phone' && typeof body[from] === 'string') {
      const raw = body[from] as string;
      updates[to] = normalizePhone(raw) ?? raw;
    } else {
      updates[to] = body[from];
    }
  }
  const link = resolveCarrierLink({ threeplCompanyId: carrierOf(body), ownFlag: ownFlagOf(body) });
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
