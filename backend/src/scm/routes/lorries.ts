// ----------------------------------------------------------------------------
// /lorries — CRUD for the lorries table (TMS fleet master, migration 0053).
// Cloned from drivers.ts. is_internal is the In-house / Outsource marker
// (Houzs parity); the list accepts a ?fleet=internal|outsourced filter.
//
// Houzs adaptation of 2990's apps/api/src/routes/lorries.ts — same plumbing as
// the sibling SCM routes (supabaseAuth bridge + scm-scoped client via
// c.get('supabase')). scm.lorries already exists (migration 0053). Mounted at
// '/lorries' in scm/index.ts.
// ----------------------------------------------------------------------------

import { idOrNull, lorryWarehouseColumns } from '../lib/lorry-warehouses';
import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { activeCompanyId } from '../lib/companyScope';
import { normalizePlate } from '../lib/plate-normalize';
import { carrierLinkForInsert, resolveCarrierLink } from '../lib/threepl-link';
import { costSen, kmFromFixes, myDayWindow, type Fix } from '../lib/lorry-km';
import { paginateAll } from '../lib/paginate-all';
import { roadTrack, type ChunkCache, type Point } from '../lib/gps-road-track';

export const lorries = new Hono<{ Bindings: Env; Variables: Variables }>();
lorries.use('*', supabaseAuth);

// Migration 0121 added the purchase record + the three compliance expiries.
// They are NOT a revival of the old public.lorries columns (mig 0015): that
// table was DROPPED by mig 0055, which explicitly discarded model /
// road_tax_expiry / insurance_expiry / puspakom_expiry on the way out. These
// are new columns on the table this route actually reads.
//
// No extra finance gate on purchase_price_sen, deliberately and by precedent:
// this router is already behind scmAreaGuard('scm.transportation.drivers'), and
// the sibling lorry-capacity route serves delivery revenue (revenue_sen) to
// that same audience. Fleet money is visible to the fleet audience. If that
// ruling ever changes it changes for both routes together, not just this one.
const COLS = [
  'id', 'plate', 'type', 'is_internal', 'warehouse_id', 'warehouse_ids', 'capacity_m3', 'capacity_kg',
  'active', 'notes', 'created_at', 'updated_at',
  'model', 'purchase_date', 'purchase_price_sen',
  'purchase_invoice_key', 'purchase_invoice_name', 'purchase_invoice_mime', 'purchase_invoice_size',
  'road_tax_expiry', 'insurance_expiry', 'puspakom_expiry',
  // Fleet A1 (mig 0205) — per-lorry delivery capacity ceilings the auto-propose
  // packer reads. NULL max_* => the packer uses its config default (10 sets /
  // RM30k). capacity_layer picks which ceiling(s) bind: SETS | REVENUE | BOTH.
  'max_sets', 'max_revenue_sen', 'capacity_layer',
  // WS3 (mig 0209) — cargo-box dimensions (ft); capacity_m3 is derived from them.
  'length_ft', 'width_ft', 'height_ft',
  // WS4a (mig 0210) — the 3PL carrier company this lorry belongs to (NULL = own
  // fleet / not attached).
  'threepl_company_id',
  /* Mig 0245 — the three dates a lorry's life is measured from, none of which
     is purchase_date: when it was BUILT, when it was REGISTERED with JPJ (what
     the road-tax / insurance / PUSPAKOM cycles anchor to), and the first day it
     worked FOR US (the denominator for cost-per-day). */
  'manufacture_date', 'registration_date', 'in_service_date',
  // Own-lorry running cost (km x this); NULL = not set.
  'cost_per_km_sen',
  // The crew usually on it (mig 20261107T2000).
  'usual_driver_id', 'usual_helper_id',
].join(', ');

const CAPACITY_LAYERS = new Set(['SETS', 'REVENUE', 'BOTH']);

// WS3: derive the box capacity in m3 from L x W x H (ft). ft3 -> m3 = 0.0283168.
// Returns null unless all three dimensions are present, so a partial box never
// fabricates a capacity. Rounded to 2 dp to match the NUMERIC display.
const FT3_TO_M3 = 0.0283168;
export function boxCapacityM3(len: number | null, wid: number | null, hei: number | null): number | null {
  if (len == null || wid == null || hei == null) return null;
  return Math.round(len * wid * hei * FT3_TO_M3 * 100) / 100;
}

/** An integer >= 0 or null (a capacity ceiling). Rejects a negative for a clean
 *  field-named 400 rather than a raw constraint 500. */
function toCapacityOrNull(v: unknown): { ok: true; value: number | null } | { ok: false } {
  if (v === null || v === undefined || v === '') return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}

// Mirrors the lorry_type enum in migration 0053. Reject anything else so a bad
// client can't write a value Postgres would 22P02 on.
const LORRY_TYPES = new Set([
  'LORRY_10FT', 'LORRY_14FT', 'LORRY_17FT', 'LORRY_21FT', 'VAN', 'OUTSOURCE', 'OTHER',
]);

/** numeric(.,.) capacity — accept a number/string, store null when blank/invalid. */
function toNumericOrNull(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* A `date` column — accept YYYY-MM-DD, store null when blank. Anything that is
   not that exact shape is REJECTED rather than coerced: these are compliance
   dates, and a silently-mangled road-tax expiry is worse than a 400. Postgres
   would 22007 on garbage anyway; this turns that 500 into an honest 400. */
const warehouseColumns = lorryWarehouseColumns;

/* usualDriverId / usualHelperId: undefined = untouched, else a uuid or a clear. */
function crewColumns(body: Record<string, unknown>): { ok: true; cols: Record<string, string | null> } | { ok: false; field: string } {
  const cols: Record<string, string | null> = {};
  for (const [wire, col] of [['usualDriverId', 'usual_driver_id'], ['usualHelperId', 'usual_helper_id']] as const) {
    if (body[wire] === undefined) continue;
    const v = idOrNull(body[wire]);
    if (!v.ok) return { ok: false, field: wire };
    cols[col] = v.value;
  }
  return { ok: true, cols };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function toDateOrNull(v: unknown): { ok: true; value: string | null } | { ok: false } {
  if (v === null || v === undefined || v === '') return { ok: true, value: null };
  const s = String(v).slice(0, 10);
  return ISO_DATE.test(s) ? { ok: true, value: s } : { ok: false };
}

/* An integer cents / km field. Rejects a negative (the table CHECKs cost_sen
   >= 0 and odometer_km >= 0 — reject here so the operator gets a field-named
   400 instead of a raw constraint-violation 500). */
function toIntOrNull(v: unknown): { ok: true; value: number | null } | { ok: false } {
  if (v === null || v === undefined || v === '') return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}

/* The date columns a client may set on a lorry, and the wire name each maps
   from. Kept as an explicit list rather than a generic loop-over-body: this
   repo's BUG-HISTORY logs a generic client-field map as the exact mechanism
   that made a server-owned column client-writable (the paid_sen back-door,
   2026-07-16). Every entry here is genuine operator-entered data. */
const LORRY_DATE_FIELDS: [wire: string, col: string][] = [
  ['purchaseDate', 'purchase_date'],
  ['manufactureDate', 'manufacture_date'],
  ['registrationDate', 'registration_date'],
  ['inServiceDate', 'in_service_date'],
  ['roadTaxExpiry', 'road_tax_expiry'],
  ['insuranceExpiry', 'insurance_expiry'],
  ['puspakomExpiry', 'puspakom_expiry'],
];

lorries.get('/', async (c) => {
  const sb = c.get('supabase');
  const onlyActive = c.req.query('active') !== 'false';   // default: active only
  const fleet = c.req.query('fleet');                     // 'internal' | 'outsourced' | undefined (=all)
  let q = sb.from('lorries').select(COLS).order('plate');
  if (onlyActive) q = q.eq('active', true);
  if (fleet === 'internal') q = q.eq('is_internal', true);
  if (fleet === 'outsourced') q = q.eq('is_internal', false);
  // UNIFIED FLEET: one shared lorry fleet across ALL companies (see drivers.ts).
  // Not scoped by company — every company's TMS page shows the same lorries.
  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ lorries: data ?? [] });
});

lorries.post('/', async (c) => {
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  /* Plates are stored CANONICAL (letters+digits, uppercase). `AKF 8100` and
     `AKF8100` were two rows for one lorry in production because the UNIQUE index
     is over the raw string - normalising on the way in is what stops the next
     one. See scm/lib/plate-normalize.ts. */
  const plate = normalizePlate(body.plate as string | null | undefined);
  if (!plate) return c.json({ error: 'plate_required' }, 400);
  const type = String(body.type ?? 'OTHER').trim();
  if (!LORRY_TYPES.has(type)) return c.json({ error: 'invalid_type' }, 400);

  const dates: Record<string, string | null> = {};
  for (const [wire, col] of LORRY_DATE_FIELDS) {
    const d = toDateOrNull(body[wire]);
    if (!d.ok) return c.json({ error: 'invalid_date', reason: `${wire} must be YYYY-MM-DD` }, 400);
    dates[col] = d.value;
  }
  const price = toIntOrNull(body.purchasePriceSen);
  if (!price.ok) return c.json({ error: 'invalid_amount', reason: 'purchasePriceSen must be a non-negative integer (cents)' }, 400);
  const perKm = toIntOrNull(body.costPerKmSen);
  if (!perKm.ok) return c.json({ error: 'invalid_amount', reason: 'costPerKmSen must be a non-negative integer (cents) or blank' }, 400);

  const maxSets = toCapacityOrNull(body.maxSets);
  if (!maxSets.ok) return c.json({ error: 'invalid_capacity', reason: 'maxSets must be a non-negative integer or blank' }, 400);
  const maxRevenue = toCapacityOrNull(body.maxRevenueSen);
  if (!maxRevenue.ok) return c.json({ error: 'invalid_capacity', reason: 'maxRevenueSen must be a non-negative integer (cents) or blank' }, 400);
  const layerRaw = body.capacityLayer === undefined || body.capacityLayer === null || body.capacityLayer === ''
    ? 'SETS' : String(body.capacityLayer).toUpperCase();
  if (!CAPACITY_LAYERS.has(layerRaw)) return c.json({ error: 'invalid_layer', reason: 'capacityLayer must be SETS, REVENUE or BOTH' }, 400);

  // WS3: box dimensions -> derived capacity_m3. When all three dims are given the
  // derived value wins; otherwise fall back to an explicit capacityM3.
  const lengthFt = toNumericOrNull(body.lengthFt);
  const widthFt = toNumericOrNull(body.widthFt);
  const heightFt = toNumericOrNull(body.heightFt);
  const derivedM3 = boxCapacityM3(lengthFt, widthFt, heightFt);
  /* A lorry registered under a 3PL carrier is outsource, whatever was ticked. */
  const link = carrierLinkForInsert({
    threeplCompanyId: body.threeplCompanyId as string | null | undefined,
    ownFlag: body.isInternal === undefined ? undefined : body.isInternal !== false,
  });

  const crew = crewColumns(body);
  if (!crew.ok) return c.json({ error: 'invalid_id', reason: `${crew.field} must be a driver / helper id or blank` }, 400);

  const sb = c.get('supabase');
  const { data, error } = await sb.from('lorries').insert({
    ...crew.cols,
    company_id: activeCompanyId(c),
    plate,
    type,
    is_internal: link.ownFlag,
    ...warehouseColumns(body),
    threepl_company_id: link.carrierId,
    length_ft: lengthFt,
    width_ft: widthFt,
    height_ft: heightFt,
    capacity_m3: derivedM3 ?? toNumericOrNull(body.capacityM3),
    capacity_kg: toNumericOrNull(body.capacityKg),
    notes: (body.notes as string) ?? null,
    active: body.active === false ? false : true,
    model: (body.model as string) || null,
    purchase_price_sen: price.value,
    cost_per_km_sen: perKm.value,
    max_sets: maxSets.value,
    max_revenue_sen: maxRevenue.value,
    capacity_layer: layerRaw,
    ...dates,
    // The purchase invoice is NOT settable here — it arrives as a file via
    // PUT /lorries/:id/purchase-invoice, so the R2 key is server-minted and a
    // client can never point the row at an arbitrary bucket key.
  }).select(COLS).single();
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_plate' }, 409);
    /* DEAD BRANCH -- here and at EVERY other 42501 site in this file. 42501 is
       Postgres permission-denied, i.e. RLS, and RLS cannot fire on this path: mig
       0061 enabled RLS on every scm table with NO policies, and the SCM client is
       the SERVICE-ROLE client (scm/middleware/auth.ts:93 -> db/supabase.ts
       getSupabaseService), which bypasses RLS by design. No scm function RAISEs
       42501 either -- the live tree's only ERRCODE is 22023. Do NOT read this as a
       permission check and do NOT treat it as scoping: the only boundary is this
       route's own predicate. (docs/audit-2026-08-13-ledger.md K1) */
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  return c.json({ lorry: data }, 201);
});

lorries.patch('/:id', async (c) => {
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
  if (body.plate !== undefined) {
    const plate = normalizePlate(body.plate as string | null | undefined);   // canonical on the way in - see POST
    if (!plate) return c.json({ error: 'plate_required' }, 400);
    updates.plate = plate;
  }
  if (body.type !== undefined) {
    const type = String(body.type).trim();
    if (!LORRY_TYPES.has(type)) return c.json({ error: 'invalid_type' }, 400);
    updates.type = type;
  }
  if (body.warehouseIds !== undefined || body.warehouseId !== undefined || body.homeWarehouseId !== undefined) Object.assign(updates, warehouseColumns(body));
  const crew = crewColumns(body);
  if (!crew.ok) return c.json({ error: 'invalid_id', reason: `${crew.field} must be a driver / helper id or blank` }, 400);
  Object.assign(updates, crew.cols);
  if (body.capacityM3 !== undefined) updates.capacity_m3 = toNumericOrNull(body.capacityM3);
  if (body.capacityKg !== undefined) updates.capacity_kg = toNumericOrNull(body.capacityKg);
  // WS3: box dimensions (ft). When the edit carries all three, capacity_m3 is
  // re-derived from them (the edit form always sends the trio together), so the
  // stored capacity stays in sync with the box the user typed.
  if (body.lengthFt !== undefined) updates.length_ft = toNumericOrNull(body.lengthFt);
  if (body.widthFt !== undefined) updates.width_ft = toNumericOrNull(body.widthFt);
  if (body.heightFt !== undefined) updates.height_ft = toNumericOrNull(body.heightFt);
  if (body.lengthFt !== undefined && body.widthFt !== undefined && body.heightFt !== undefined) {
    updates.capacity_m3 = boxCapacityM3(
      toNumericOrNull(body.lengthFt), toNumericOrNull(body.widthFt), toNumericOrNull(body.heightFt),
    );
  }
  if (body.notes !== undefined) updates.notes = (body.notes as string) || null;
  /* The Fleet grid's Outsource tick-box posts only the flag, so the current
     link has to come from the row — resolveCarrierLink cannot see it otherwise
     and the two fields silently disagree (owner, 2026-08-02). */
  const sbCur = c.get('supabase');
  const { data: curRow, error: curErr } = await sbCur
    .from('lorries').select('threepl_company_id').eq('id', id).maybeSingle();
  if (curErr) return c.json({ error: 'load_failed', reason: curErr.message }, 500);
  if (!curRow) return c.json({ error: 'lorry_not_found' }, 404);

  const link = resolveCarrierLink({
    threeplCompanyId: body.threeplCompanyId as string | null | undefined,
    ownFlag: body.isInternal === undefined ? undefined : body.isInternal !== false,

    currentCarrierId: (curRow.threepl_company_id ?? null) as string | null,
  });
  if (link.conflict === 'own_flag_while_linked') {
    return c.json({
      error: 'linked_to_carrier',
      reason: 'This row belongs to a 3PL company. Detach it from the carrier first, then mark it in-house.',
    }, 409);
  }
  if (link.carrierId !== undefined) updates.threepl_company_id = link.carrierId;
  if (link.ownFlag !== undefined) updates.is_internal = link.ownFlag;
  if (body.active !== undefined) updates.active = Boolean(body.active);
  if (body.model !== undefined) updates.model = (body.model as string) || null;
  for (const [wire, col] of LORRY_DATE_FIELDS) {
    if (body[wire] === undefined) continue;
    const d = toDateOrNull(body[wire]);
    if (!d.ok) return c.json({ error: 'invalid_date', reason: `${wire} must be YYYY-MM-DD` }, 400);
    updates[col] = d.value;
  }
  if (body.purchasePriceSen !== undefined) {
    const price = toIntOrNull(body.purchasePriceSen);
    if (!price.ok) return c.json({ error: 'invalid_amount', reason: 'purchasePriceSen must be a non-negative integer (cents)' }, 400);
    updates.purchase_price_sen = price.value;
  }
  if (body.costPerKmSen !== undefined) {
    const perKm = toIntOrNull(body.costPerKmSen);
    if (!perKm.ok) return c.json({ error: 'invalid_amount', reason: 'costPerKmSen must be a non-negative integer (cents) or blank' }, 400);
    updates.cost_per_km_sen = perKm.value;
  }
  if (body.maxSets !== undefined) {
    const m = toCapacityOrNull(body.maxSets);
    if (!m.ok) return c.json({ error: 'invalid_capacity', reason: 'maxSets must be a non-negative integer or blank' }, 400);
    updates.max_sets = m.value;
  }
  if (body.maxRevenueSen !== undefined) {
    const m = toCapacityOrNull(body.maxRevenueSen);
    if (!m.ok) return c.json({ error: 'invalid_capacity', reason: 'maxRevenueSen must be a non-negative integer (cents) or blank' }, 400);
    updates.max_revenue_sen = m.value;
  }
  if (body.capacityLayer !== undefined) {
    const layer = String(body.capacityLayer ?? 'SETS').toUpperCase();
    if (!CAPACITY_LAYERS.has(layer)) return c.json({ error: 'invalid_layer', reason: 'capacityLayer must be SETS, REVENUE or BOTH' }, 400);
    updates.capacity_layer = layer;
  }
  // purchase_invoice_* are server-owned (minted by the upload route). NOT in
  // this map on purpose — a client-writable R2 key would let any caller point a
  // lorry row at another tenant's object, and all four R2 bindings share ONE
  // physical bucket (wrangler.toml:72-102), so the key IS the only boundary.
  // Touch updated_at on any edit (the master has an updated_at column).
  if (Object.keys(updates).length === 0) return c.json({ error: 'no_changes' }, 400);
  updates.updated_at = new Date().toISOString();

  const sb = c.get('supabase');
  const { data, error } = await sb.from('lorries').update(updates).eq('id', id).select(COLS).single();
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_plate' }, 409);
    return c.json({ error: 'update_failed', reason: error.message }, 500);
  }
  return c.json({ lorry: data });
});

/* Delete a lorry that never worked (owner 2026-11-07). A lorry with runs, positions,
   documents, repairs or service records keeps its history: it is stopped, not deleted.
   One shared fleet across companies, as PATCH /:id above. */
lorries.delete('/:id', async (c) => {
  // company-scope: UNIFIED FLEET — the lorry master is one roster across companies (see PATCH /:id).
  const id = c.req.param('id');
  const sb = c.get('supabase');
  const { data: row, error: rowErr } = await sb.from('lorries').select('id').eq('id', id).maybeSingle();
  if (rowErr) return c.json({ error: 'load_failed', reason: rowErr.message }, 500);
  if (!row) return c.json({ error: 'lorry_not_found' }, 404);
  for (const table of ['trips', 'lorry_positions', 'lorry_service_records', 'lorry_compliance_documents', 'lorry_work_orders']) {
    const { count, error } = await sb.from(table).select('lorry_id', { count: 'exact', head: true }).eq('lorry_id', id);
    if (error) return c.json({ error: 'load_failed', reason: `${table}: ${error.message}` }, 500);
    if ((count ?? 0) > 0) return c.json({ error: 'lorry_has_history', reason: 'This lorry has runs or records. Stop using it instead, so its history stays.' }, 409);
  }
  const { error } = await sb.from('lorries').delete().eq('id', id);
  if (error) {
    if (error.code === '23503') return c.json({ error: 'lorry_has_history', reason: 'This lorry is still referenced. Stop using it instead.' }, 409);
    return c.json({ error: 'delete_failed', reason: error.message }, 500);
  }
  return c.json({ ok: true });
});

// DEV-42: each lorry's latest Velocity fix in the last 24 h (scm/lib/velocity-poll.ts
// writes them every 5 min). Unified fleet like GET / — not scoped by company.
export type LatestFix = {
  lorry_id: string; lat: number; lng: number; speed_kmh: number | null; heading: number | null;
  ignition: boolean | null; street: string | null; recorded_at: string; received_at: string | null;
};

/* Newest fix per lorry since `since`. PAGED: a moving lorry writes 12 fixes an
   hour, so the newest 1,000 rows (all one plain select returns) covered only the
   last few hours of a 4+ lorry fleet, and a lorry parked since the morning
   silently dropped off the map. `truncated` = more than 50,000 fixes in the
   window (about 170 lorries), reported, not hidden. */
export async function latestFixPerLorry(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- scm-scoped supabase-js client
  sb: any,
  since: string,
): Promise<{ data: LatestFix[]; error: string | null; truncated: boolean }> {
  // ponytail: reads 24 h of rows (288 per tracked lorry); a DISTINCT ON view if the fleet grows large.
  const { data, error, truncated } = await paginateAll<LatestFix>((f, t) => sb.from('lorry_positions')
    .select('lorry_id, lat, lng, speed_kmh, heading, ignition, street, recorded_at, received_at')
    .gte('recorded_at', since)
    .order('recorded_at', { ascending: false }).order('id')
    .range(f, t));
  if (error) return { data: [], error: error.message, truncated: false };
  const latest = new Map<string, LatestFix>();
  for (const r of data ?? []) if (!latest.has(r.lorry_id)) latest.set(r.lorry_id, r);
  return { data: [...latest.values()], error: null, truncated };
}

lorries.get('/positions/latest', async (c) => {
  const sb = c.get('supabase');
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data: fixes, error, truncated } = await latestFixPerLorry(sb, since);
  if (error) return c.json({ error: 'load_failed', reason: error }, 500);
  if (truncated) return c.json({ error: 'too_many_fixes', reason: 'More GPS fixes in 24 hours than one read can take; the map would miss lorries.' }, 500);
  const latest = new Map(fixes.map((r) => [r.lorry_id, r]));
  if (!latest.size) return c.json({ positions: [] });
  const { data: plates, error: pErr } = await sb.from('lorries').select('id, plate').in('id', [...latest.keys()]);
  if (pErr) return c.json({ error: 'load_failed', reason: pErr.message }, 500);
  const plateById = new Map(plates.map((l) => [l.id as string, l.plate as string]));
  const positions = [...latest.values()]
    .map((r) => ({ ...r, plate: plateById.get(r.lorry_id) ?? '' }))
    .sort((a, b) => a.plate.localeCompare(b.plate));
  return c.json({ positions });
});

// Own-lorry running cost for one Malaysia day: km from the Velocity fixes x
// cost_per_km_sen. Unified fleet like /positions/latest. Fixes exist from
// 15 Oct 2026 only (the poller's start), so earlier days return no rows.
lorries.get('/km-cost', async (c) => {
  const date = c.req.query('date') ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const day = ISO_DATE.test(date) ? myDayWindow(date) : null;
  if (!day) return c.json({ error: 'invalid_date', reason: 'date must be YYYY-MM-DD' }, 400);
  const { from, to } = day;
  const sb = c.get('supabase');
  // ~288 fixes per lorry per day, so this is several pages past the 1000-row cap.
  const { data, error } = await paginateAll<Fix & { lorry_id: string }>((f, t) => sb.from('lorry_positions')
    .select('lorry_id, lat, lng, recorded_at')
    .gte('recorded_at', from).lt('recorded_at', to)
    .order('recorded_at').order('id')
    .range(f, t));
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const byLorry = new Map<string, Fix[]>();
  for (const r of data ?? []) {
    const list = byLorry.get(r.lorry_id) ?? [];
    list.push(r);
    byLorry.set(r.lorry_id, list);
  }
  if (!byLorry.size) return c.json({ date, lorries: [] });
  const { data: rows, error: lErr } = await sb.from('lorries')
    .select('id, plate, cost_per_km_sen').in('id', [...byLorry.keys()]);
  if (lErr) return c.json({ error: 'load_failed', reason: lErr.message }, 500);
  const out = rows.map((l) => {
    const km = kmFromFixes(byLorry.get(l.id as string) ?? []);
    const rate = (l.cost_per_km_sen ?? null) as number | null;
    return { lorry_id: l.id as string, plate: l.plate as string, km, cost_per_km_sen: rate, cost_sen: costSen(km, rate) };
  }).sort((a, b) => a.plate.localeCompare(b.plate));
  return c.json({ date, lorries: out });
});

// One lorry's driven track for a Malaysia day — its Velocity fixes in time order
// (Fleet Health's lorry page draws them as the route it actually drove), plus the
// km they add up to. Unified fleet like /positions/latest.
lorries.get('/:id/track', async (c) => {
  // company-scope: UNIFIED FLEET — one shared fleet across all companies (lorries.ts:132), same as /positions/latest and /km-cost.
  const date = c.req.query('date') ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const day = ISO_DATE.test(date) ? myDayWindow(date) : null;
  if (!day) return c.json({ error: 'invalid_date', reason: 'date must be YYYY-MM-DD' }, 400);
  const { data, error } = await paginateAll<Fix & { speed_kmh: number | null; street: string | null }>((f, t) => c.get('supabase').from('lorry_positions')
    .select('lat, lng, recorded_at, speed_kmh, street')
    .eq('lorry_id', c.req.param('id'))
    .gte('recorded_at', day.from).lt('recorded_at', day.to)
    .order('recorded_at').order('id')
    .range(f, t));
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const fixes = data ?? [];
  return c.json({ date, km: kmFromFixes(fixes), fixes });
});

// The same day's fixes drawn along the roads (owner 2026-11-10), for the live map and
// the lorry page. Each chunk's road is kept in the edge cache by its own points, so the
// 5-min poll asks Google only for a chunk it has not seen. Unified fleet like /:id/track.
const ROAD_CACHE_DAYS = 30;
function edgeChunkCache(origin: string): ChunkCache {
  const url = (key: string) => `${origin}/__gps-road-cache/v1?${encodeURIComponent(key)}`;
  return {
    async get(key) {
      try {
        const hit = await caches.default.match(url(key));
        return hit ? ((await hit.json()) as Point[] | null) : undefined;
      } catch {
        return undefined;
      }
    },
    async put(key, road) {
      try {
        await caches.default.put(url(key), new Response(JSON.stringify(road), {
          headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${ROAD_CACHE_DAYS * 86_400}` },
        }));
      } catch { /* best effort: a miss only costs one more Directions call */ }
    },
  };
}

lorries.get('/:id/track/road', async (c) => {
  // company-scope: UNIFIED FLEET — one shared fleet across all companies (lorries.ts:132), same as /:id/track.
  const date = c.req.query('date') ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const day = ISO_DATE.test(date) ? myDayWindow(date) : null;
  if (!day) return c.json({ error: 'invalid_date', reason: 'date must be YYYY-MM-DD' }, 400);
  const { data, error } = await paginateAll<Fix>((f, t) => c.get('supabase').from('lorry_positions')
    .select('lat, lng, recorded_at')
    .eq('lorry_id', c.req.param('id'))
    .gte('recorded_at', day.from).lt('recorded_at', day.to)
    .order('recorded_at').order('id')
    .range(f, t));
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const track = await roadTrack(c.env, data ?? [], edgeChunkCache(new URL(c.req.url).origin));
  return c.json({ date, ...track });
});

export default lorries;
