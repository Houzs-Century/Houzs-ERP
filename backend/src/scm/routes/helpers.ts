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
import { nextCode, CODE_PREFIX } from '../lib/fleet-code-mint';
import { normalizeIc, INVALID_IC, NAME_MAX } from '../lib/fleet-crew-fields';

/** The next HLP- code. Global read, same reason as drivers: helper_code carries
 *  a bare UNIQUE(helper_code) and the roster is shared across companies. */
async function mintHelperCode(sb: { from: (t: string) => any }): Promise<string> {
  const { data } = await sb.from('helpers').select('helper_code');
  return nextCode(CODE_PREFIX.HELPER, ((data ?? []) as Array<{ helper_code?: string | null }>).map((r) => r.helper_code));
}

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
  const suppliedCode = String(body.helperCode ?? '').trim();
  const name = String(body.name ?? '').trim();
  const contact = String(body.contact ?? '').trim();
  if (!name) return c.json({ error: 'name_required' }, 400);
  if (name.length > NAME_MAX) return c.json({ error: 'name_too_long', reason: `Keep the name under ${NAME_MAX} characters.` }, 400);

  /* Contact is OPTIONAL, but a non-empty one that will not normalise is not a
     phone number — it used to be stored raw (`?? contact`). Blank stays blank. */
  let normalizedContact: string | null = null;
  if (contact) {
    normalizedContact = normalizePhone(contact);
    if (!normalizedContact) return c.json({ error: 'invalid_contact', reason: 'That is not a usable phone number.' }, 400);
  }

  const icNumber = normalizeIc(body.icNumber);
  if (icNumber === INVALID_IC) return c.json({ error: 'invalid_ic', reason: 'An IC / passport number is at most 20 characters.' }, 400);

  /* A helper registered under a 3PL carrier is outsource, whatever was ticked. */
  const link = carrierLinkForInsert({ threeplCompanyId: carrierOf(body), ownFlag: ownFlagOf(body) });

  const sb = c.get('supabase');
  const row = {
    company_id: activeCompanyId(c),
    name,
    contact: normalizedContact,
    ic_number: icNumber,
    in_house: link.ownFlag,
    threepl_company_id: link.carrierId,
    active: body.active === false ? false : true,
  };

  /* Codes are minted (owner 2026-08-02); an explicit one is still honoured so
     an import can carry real codes. Retry the MINT only — a 23505 on a supplied
     code is the caller's problem and retrying would spin. */
  for (let attempt = 0; attempt < 4; attempt++) {
    const helperCode = suppliedCode || await mintHelperCode(sb);
    const { data, error } = await sb.from('helpers')
      .insert({ ...row, helper_code: helperCode }).select(COLS).single();
    if (!error) return c.json({ helper: data }, 201);
    /* DEAD BRANCH -- here and at EVERY other 42501 site in this file. 42501 is
       Postgres permission-denied, i.e. RLS, and RLS cannot fire on this path: mig
       0061 enabled RLS on every scm table with NO policies, and the SCM client is
       the SERVICE-ROLE client (scm/middleware/auth.ts:93 -> db/supabase.ts
       getSupabaseService), which bypasses RLS by design. No scm function RAISEs
       42501 either -- the live tree's only ERRCODE is 22023. Do NOT read this as a
       permission check and do NOT treat it as scoping: the only boundary is this
       route's own predicate. (docs/audit-2026-08-13-ledger.md K1) */
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    if (error.code !== '23505') return c.json({ error: 'insert_failed', reason: error.message }, 500);
    if (suppliedCode) return c.json({ error: 'duplicate_code' }, 409);
  }
  return c.json({ error: 'code_mint_failed', reason: 'Could not allocate a helper code.' }, 500);
});

helpers.patch('/:id', async (c) => {
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
  /* The SAME rules the create path applies — a field validated on create and
     not on edit is validated nowhere. */
  const map: Array<[string, string]> = [
    ['helperCode', 'helper_code'], ['name', 'name'],
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
  if (body.contact !== undefined) {
    /* Blank CLEARS the optional field; a non-blank value that will not
       normalise is not a phone number and is refused, not stored raw. */
    const raw = String(body.contact ?? '').trim();
    if (!raw) {
      updates.contact = null;
    } else {
      const normalized = normalizePhone(raw);
      if (!normalized) return c.json({ error: 'invalid_contact', reason: 'That is not a usable phone number.' }, 400);
      updates.contact = normalized;
    }
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
    .from('helpers').select('threepl_company_id').eq('id', id).maybeSingle();
  if (curErr) return c.json({ error: 'load_failed', reason: curErr.message }, 500);
  if (!curRow) return c.json({ error: 'helper_not_found' }, 404);

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
  const { data, error } = await sb.from('helpers').update(updates).eq('id', id).select(COLS).single();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  return c.json({ helper: data });
});

export default helpers;
