// ----------------------------------------------------------------------------
// /helpers — CRUD for the helpers table (TMS fleet master, migration 0053).
// Cloned from drivers.ts. A helper is a delivery crew member (not a driver);
// in_house flags in-house staff vs an outsourced/3rd-party helper.
//
// Houzs adaptation of 2990's apps/api/src/routes/helpers.ts — the only change
// is the normalizePhone import: @2990s/shared/phone → ../shared (the vendored
// shared barrel). scm.helpers already exists (migration 0053). Mounted at
// '/helpers' in scm/index.ts.
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { normalizePhone } from '../shared';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { activeCompanyId } from '../lib/companyScope';
import { carrierLinkForInsert, resolveCarrierLink } from '../lib/threepl-link';

export const helpers = new Hono<{ Bindings: Env; Variables: Variables }>();
helpers.use('*', supabaseAuth);

const COLS = 'id, helper_code, name, contact, ic_number, in_house, threepl_company_id, active, created_at';

/* The caller's in_house as a tri-state: absent stays absent (see threepl-link). */
const ownFlagOf = (body: Record<string, unknown>): boolean | undefined =>
  body.inHouse === undefined ? undefined : body.inHouse !== false;
const carrierOf = (body: Record<string, unknown>): string | null | undefined =>
  body.threeplCompanyId as string | null | undefined;

helpers.get('/', async (c) => {
  const sb = c.get('supabase');
  const onlyActive = c.req.query('active') !== 'false';   // default: active only
  let q = sb.from('helpers').select(COLS).order('helper_code');
  if (onlyActive) q = q.eq('active', true);
  // UNIFIED FLEET: one shared helper roster across ALL companies (see drivers.ts).
  // Not scoped by company — every company's TMS page shows the same helpers.
  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ helpers: data ?? [] });
});

helpers.post('/', async (c) => {
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const helperCode = String(body.helperCode ?? '').trim();
  const name = String(body.name ?? '').trim();
  const contact = String(body.contact ?? '').trim();
  if (!helperCode) return c.json({ error: 'code_required' }, 400);
  if (!name)       return c.json({ error: 'name_required' }, 400);
  /* Store helper contact in E.164 (mirrors drivers.phone). Contact is optional. */
  const normalizedContact = contact ? (normalizePhone(contact) ?? contact) : null;
  /* A helper registered under a 3PL carrier is outsource, whatever was ticked. */
  const link = carrierLinkForInsert({ threeplCompanyId: carrierOf(body), ownFlag: ownFlagOf(body) });

  const sb = c.get('supabase');
  const { data, error } = await sb.from('helpers').insert({
    company_id: activeCompanyId(c),
    helper_code: helperCode,
    name,
    contact: normalizedContact,
    ic_number: (body.icNumber as string) ?? null,
    in_house: link.ownFlag,
    threepl_company_id: link.carrierId,
    active: body.active === false ? false : true,
  }).select(COLS).single();
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_code' }, 409);
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  return c.json({ helper: data }, 201);
});

helpers.patch('/:id', async (c) => {
  const id = c.req.param('id');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  const updates: Record<string, unknown> = {};
  const map: Array<[string, string]> = [
    ['helperCode', 'helper_code'], ['name', 'name'], ['contact', 'contact'],
    ['icNumber', 'ic_number'],
  ];
  for (const [from, to] of map) {
    if (body[from] === undefined) continue;
    /* Normalize contact to E.164 on PATCH (mirrors drivers.phone). */
    if (from === 'contact' && typeof body[from] === 'string') {
      const raw = body[from] as string;
      updates[to] = raw ? (normalizePhone(raw) ?? raw) : null;
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
  const { data, error } = await sb.from('helpers').update(updates).eq('id', id).select(COLS).single();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  return c.json({ helper: data });
});

export default helpers;
