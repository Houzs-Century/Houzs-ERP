
import { idOrNull, lorryWarehouseColumns } from '../lib/lorry-warehouses';
import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { activeCompanyId } from '../lib/companyScope';
import { normalizePlate } from '../lib/plate-normalize';
import { carrierLinkForInsert, resolveCarrierLink } from '../lib/threepl-link';
import { costSen, kmFromFixes, myDayWindow, oneTracker, type Fix } from '../lib/lorry-km';
import { loadDrops } from '../lib/lorry-drops';
import { daysInRange, kmForDay, KM_MAX_DAYS } from '../lib/lorry-km-range';
import { mapBounded } from '../lib/concurrency';
import { paginateAll } from '../lib/paginate-all';
import { roadTrack, type ChunkCache, type Point } from '../lib/gps-road-track';

export const lorries = new Hono<{ Bindings: Env; Variables: Variables }>();
lorries.use('*', supabaseAuth);

const COLS = [
  'id', 'plate', 'type', 'is_internal', 'warehouse_id', 'warehouse_ids', 'capacity_m3', 'capacity_kg',
  'active', 'notes', 'created_at', 'updated_at',
  'model', 'purchase_date', 'purchase_price_sen',
  'purchase_invoice_key', 'purchase_invoice_name', 'purchase_invoice_mime', 'purchase_invoice_size',
  'road_tax_expiry', 'insurance_expiry', 'puspakom_expiry',
  'max_sets', 'max_revenue_sen', 'capacity_layer',
  'length_ft', 'width_ft', 'height_ft',
  'threepl_company_id',
  'manufacture_date', 'registration_date', 'in_service_date',
  'cost_per_km_sen',
  'usual_driver_id', 'usual_helper_id',
].join(', ');

const CAPACITY_LAYERS = new Set(['SETS', 'REVENUE', 'BOTH']);

const FT3_TO_M3 = 0.0283168;
export function boxCapacityM3(len: number | null, wid: number | null, hei: number | null): number | null {
  if (len == null || wid == null || hei == null) return null;
  return Math.round(len * wid * hei * FT3_TO_M3 * 100) / 100;
}

function toCapacityOrNull(v: unknown): { ok: true; value: number | null } | { ok: false } {
  if (v === null || v === undefined || v === '') return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}

const LORRY_TYPES = new Set([
  'LORRY_10FT', 'LORRY_14FT', 'LORRY_17FT', 'LORRY_21FT', 'VAN', 'OUTSOURCE', 'OTHER',
]);

function toNumericOrNull(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const warehouseColumns = lorryWarehouseColumns;

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

function toIntOrNull(v: unknown): { ok: true; value: number | null } | { ok: false } {
  if (v === null || v === undefined || v === '') return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}

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
  const onlyActive = c.req.query('active') !== 'false';
  const fleet = c.req.query('fleet');
  let q = sb.from('lorries').select(COLS).order('plate');
  if (onlyActive) q = q.eq('active', true);
  if (fleet === 'internal') q = q.eq('is_internal', true);
  if (fleet === 'outsourced') q = q.eq('is_internal', false);
  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ lorries: data ?? [] });
});

lorries.post('/', async (c) => {
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
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

  const lengthFt = toNumericOrNull(body.lengthFt);
  const widthFt = toNumericOrNull(body.widthFt);
  const heightFt = toNumericOrNull(body.heightFt);
  const derivedM3 = boxCapacityM3(lengthFt, widthFt, heightFt);
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
  }).select(COLS).single();
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_plate' }, 409);
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
    const plate = normalizePlate(body.plate as string | null | undefined);
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

export type LatestFix = {
  lorry_id: string; lat: number; lng: number; speed_kmh: number | null; heading: number | null;
  ignition: boolean | null; street: string | null; recorded_at: string; received_at: string | null;
};

export async function latestFixPerLorry(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- scm-scoped supabase-js client
  sb: any,
  since: string,
): Promise<{ data: LatestFix[]; error: string | null; truncated: boolean }> {
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

lorries.get('/km-cost', async (c) => {
  const date = c.req.query('date') ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const day = ISO_DATE.test(date) ? myDayWindow(date) : null;
  if (!day) return c.json({ error: 'invalid_date', reason: 'date must be YYYY-MM-DD' }, 400);
  const sb = c.get('supabase');
  const d = await kmForDay(sb, date);
  if (d.error) return c.json({ error: 'load_failed', reason: d.error }, 500);
  if (d.truncated) return c.json({ error: 'too_many_fixes', reason: `Too many GPS fixes on ${date} to read in full.` }, 500);
  if (!d.km.size) return c.json({ date, lorries: [] });
  const { data: rows, error: lErr } = await sb.from('lorries')
    .select('id, plate, cost_per_km_sen').in('id', [...d.km.keys()]);
  if (lErr) return c.json({ error: 'load_failed', reason: lErr.message }, 500);
  const out = rows.map((l) => {
    const km = d.km.get(l.id as string) ?? 0;
    const rate = (l.cost_per_km_sen ?? null) as number | null;
    return { lorry_id: l.id as string, plate: l.plate as string, km, cost_per_km_sen: rate, cost_sen: costSen(km, rate) };
  }).sort((a, b) => a.plate.localeCompare(b.plate));
  return c.json({ date, lorries: out });
});

lorries.get('/km-daily', async (c) => {
  // company-scope: UNIFIED FLEET — one shared fleet across all companies (lorries.ts:132), same as /km-cost.
  const from = c.req.query('from') ?? '';
  const to = c.req.query('to') ?? '';
  const days = ISO_DATE.test(from) && ISO_DATE.test(to) ? daysInRange(from, to) : [];
  if (!days.length || days.some((d) => !myDayWindow(d))) return c.json({ error: 'invalid_range', reason: 'from and to must be real YYYY-MM-DD dates, from <= to' }, 400);
  if (days.length > KM_MAX_DAYS) return c.json({ error: 'range_too_long', reason: `at most ${KM_MAX_DAYS} days` }, 400);
  const sb = c.get('supabase');
  const perDay = await mapBounded(days, 4, (day) => kmForDay(sb, day));
  for (let i = 0; i < perDay.length; i++) {
    const d = perDay[i]!;
    if (d.error) return c.json({ error: 'load_failed', reason: d.error }, 500);
    if (d.truncated) return c.json({ error: 'too_many_fixes', reason: `Too many GPS fixes on ${days[i]} to read in full.` }, 500);
  }
  const ids = [...new Set(perDay.flatMap((d) => [...d.km.keys()]))];
  if (!ids.length) return c.json({ days, lorries: [] });
  const { data: rows, error } = await sb.from('lorries').select('id, plate').in('id', ids);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const out = rows.map((l) => ({ id: l.id as string, plate: l.plate as string, km: perDay.map((d) => d.km.get(l.id as string) ?? null) }))
    .sort((a, b) => a.plate.localeCompare(b.plate));
  return c.json({ days, lorries: out });
});

lorries.get('/:id/track', async (c) => {
  // company-scope: UNIFIED FLEET — one shared fleet across all companies (lorries.ts:132), same as /positions/latest and /km-cost.
  const date = c.req.query('date') ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const day = ISO_DATE.test(date) ? myDayWindow(date) : null;
  if (!day) return c.json({ error: 'invalid_date', reason: 'date must be YYYY-MM-DD' }, 400);
  const { data, error } = await paginateAll<Fix & { device_id: string | null; speed_kmh: number | null; street: string | null }>((f, t) => c.get('supabase').from('lorry_positions')
    .select('device_id, lat, lng, recorded_at, speed_kmh, street')
    .eq('lorry_id', c.req.param('id'))
    .gte('recorded_at', day.from).lt('recorded_at', day.to)
    .order('recorded_at').order('id')
    .range(f, t));
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const fixes = oneTracker(data ?? []).map(({ device_id: _d, ...f }) => f);
  const { drops, error: dErr } = await loadDrops(c.get('supabase'), c, c.req.param('id'), date);
  return c.json({ date, km: kmFromFixes(fixes), fixes, drops, dropsError: dErr });
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
      } catch { }
    },
  };
}

lorries.get('/:id/track/road', async (c) => {
  // company-scope: UNIFIED FLEET — one shared fleet across all companies (lorries.ts:132), same as /:id/track.
  const date = c.req.query('date') ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const day = ISO_DATE.test(date) ? myDayWindow(date) : null;
  if (!day) return c.json({ error: 'invalid_date', reason: 'date must be YYYY-MM-DD' }, 400);
  const { data, error } = await paginateAll<Fix & { device_id: string | null }>((f, t) => c.get('supabase').from('lorry_positions')
    .select('device_id, lat, lng, recorded_at')
    .eq('lorry_id', c.req.param('id'))
    .gte('recorded_at', day.from).lt('recorded_at', day.to)
    .order('recorded_at').order('id')
    .range(f, t));
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const track = await roadTrack(c.env, oneTracker(data ?? []), edgeChunkCache(new URL(c.req.url).origin));
  return c.json({ date, ...track });
});

export default lorries;
