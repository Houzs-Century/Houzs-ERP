// ----------------------------------------------------------------------------
// /delivery-zones — Fleet Module A1: postcode -> zone map admin, the AUTO-PROPOSE
// delivery-date action, and reversible day locks.
//
// THREE surfaces, one router:
//   1. CRUD over scm.delivery_zone_postcodes (mig 0205) — the company-editable
//      postcode-prefix -> area-zone map. Ships empty; until the owner customises
//      (or runs seed-delivery-zones.mjs) classification falls back to the in-code
//      DEFAULT_ZONE_PREFIX_MAP (zone-classify.ts), so the map always resolves.
//   2. POST /propose — the auto-propose action. Takes the PENDING_SCHEDULE orders
//      the dispatcher picked (their SO doc numbers) + a depot warehouse, derives
//      each order's ZONE (postcode) + SET count (SO lines), and PACKS them into
//      lorry-days under each lorry's capacity ceiling (first-ceiling-wins; far
//      zones dedicated + accumulate). Returns a REVERSIBLE, DISPLAY-ONLY proposal
//      grouped day -> group -> lorry. Writes NOTHING; it is not a scheduler. The
//      owner reviews it and the established schedule write-path (PATCH
//      /delivery-planning/so/:id/schedule -> amended_delivery_date) persists the
//      accepted dates. We never touch customer_delivery_date.
//   3. Day locks (scm.delivery_day_locks) — freeze / unfreeze a (warehouse, date)
//      proposed schedule. Reversible: unlock = DELETE.
//
// Mounted at '/delivery-zones' in scm/index.ts behind
// scmAreaGuard('scm.transportation.drivers') — same area as the rest of TMS.
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { paginateAll } from '../lib/paginate-all';
import {
  scopeToCompany,
  scopeToCompanyId,
  scopeToAllowedCompanies,
  requireActiveCompanyId,
  NOT_THIS_COMPANY,
} from '../lib/companyScope';
import {
  ZONE_SET,
  DEFAULT_ZONE_PREFIX_MAP,
  KLANG_VALLEY_ZONES,
  zoneForAddress,
  type ZonePrefixRule,
} from '../lib/zone-classify';
import { deriveSetCount, type SetLineCategory } from '../lib/set-count';
import { packProposals, type PackOrder, type PackLorry, type CapacityLayer } from '../lib/capacity-pack';
import { composeAddress, geocodeAddressCached } from '../lib/geocode';
import { travelTimeMatrix, type LatLngPoint } from '../lib/maps';
import { timeToMinutes, minutesToTime } from '../lib/propose-route';
import { buildSequenceProposal, type SequenceStopInput } from '../lib/sequence-stops';
import { loadAvailableLorries } from '../lib/fleet-availability';
import { assignFleet, type AssignGroup } from '../lib/fleet-assign';
import { loadDriverLeave } from '../lib/driver-availability';

export const deliveryZones = new Hono<{ Bindings: Env; Variables: Variables }>();
deliveryZones.use('*', supabaseAuth);

const MAP_COLS = 'id, zone, prefix_start, prefix_end, label, is_active, created_at, updated_at';

type MapRow = {
  id: string;
  zone?: string | null;
  prefix_start?: number | null; prefixStart?: number | null;
  prefix_end?: number | null;   prefixEnd?: number | null;
  label?: string | null;
  is_active?: boolean | null;   isActive?: boolean | null;
  created_at?: string | null;   createdAt?: string | null;
  updated_at?: string | null;   updatedAt?: string | null;
};

function mapOut(r: MapRow) {
  return {
    id:          r.id,
    zone:        String(r.zone ?? ''),
    prefixStart: Number(r.prefixStart ?? r.prefix_start ?? 0),
    prefixEnd:   Number(r.prefixEnd ?? r.prefix_end ?? 0),
    label:       r.label ?? null,
    isActive:    (r.isActive ?? r.is_active ?? true) !== false,
    createdAt:   r.createdAt ?? r.created_at ?? null,
    updatedAt:   r.updatedAt ?? r.updated_at ?? null,
  };
}

/** Company map rows -> ZonePrefixRule[]; the in-code default when there are none. */
function toPrefixMap(rows: MapRow[]): { map: ZonePrefixRule[]; usingDefault: boolean } {
  const active = rows.filter((r) => (r.isActive ?? r.is_active ?? true) !== false);
  if (active.length === 0) return { map: [...DEFAULT_ZONE_PREFIX_MAP], usingDefault: true };
  return {
    map: active.map((r) => ({
      zone: String(r.zone ?? ''),
      prefixStart: Number(r.prefixStart ?? r.prefix_start ?? 0),
      prefixEnd: Number(r.prefixEnd ?? r.prefix_end ?? 0),
    })),
    usingDefault: false,
  };
}

// ── GET / — the company's zone map (falls back to the default, flagged). ──────
deliveryZones.get('/', async (c) => {
  const sb = c.get('supabase');
  const { data, error } = await paginateAll<MapRow>((from, to) =>
    scopeToCompany(sb.from('delivery_zone_postcodes').select(MAP_COLS), c)
      .order('prefix_start', { ascending: true })
      .range(from, to),
  );
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  const rows = (data ?? []);
  const { usingDefault } = toPrefixMap(rows);
  return c.json({
    zones: rows.map(mapOut),
    usingDefault,
    // The in-code default, so the editor can offer "load the default map".
    defaultMap: DEFAULT_ZONE_PREFIX_MAP.map((r) => ({ zone: r.zone, prefixStart: r.prefixStart, prefixEnd: r.prefixEnd })),
    knownZones: [...ZONE_SET],
  });
});

const prefixField = z.number().int().min(0).max(99);
const zoneCreateSchema = z.object({
  zone: z.string().trim().min(1).max(40),
  prefixStart: prefixField,
  prefixEnd: prefixField,
  label: z.string().trim().max(120).nullable().optional(),
  isActive: z.boolean().optional(),
}).refine((v) => v.prefixStart <= v.prefixEnd, { message: 'prefixStart must be <= prefixEnd' });

// ── POST / — add a zone rule. ─────────────────────────────────────────────────
deliveryZones.post('/', async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = zoneCreateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const p = parsed.data;
  const zone = p.zone.toUpperCase();
  if (!ZONE_SET.has(zone)) return c.json({ error: 'unknown_zone', reason: `zone must be one of the ${ZONE_SET.size} area zones`, knownZones: [...ZONE_SET] }, 400);
  const user = c.get('user') as { id?: string } | null;

  const sb = c.get('supabase');
  const { data, error } = await sb.from('delivery_zone_postcodes').insert({
    company_id: co.companyId,
    zone,
    prefix_start: p.prefixStart,
    prefix_end: p.prefixEnd,
    label: p.label ?? null,
    is_active: p.isActive ?? true,
    created_by: user?.id ?? null,
    updated_by: user?.id ?? null,
  }).select(MAP_COLS).single();
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_rule', reason: 'That exact zone + prefix range already exists.' }, 409);
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  return c.json({ zone: mapOut(data as MapRow) }, 201);
});

const zonePatchSchema = z.object({
  zone: z.string().trim().min(1).max(40).optional(),
  prefixStart: prefixField.optional(),
  prefixEnd: prefixField.optional(),
  label: z.string().trim().max(120).nullable().optional(),
  isActive: z.boolean().optional(),
});

// ── PATCH /:id — edit a zone rule. STRICT company scope. ──────────────────────
deliveryZones.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = zonePatchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const p = parsed.data;
  const user = c.get('user') as { id?: string } | null;

  const updates: Record<string, unknown> = {};
  if (p.zone !== undefined) {
    const zone = p.zone.toUpperCase();
    if (!ZONE_SET.has(zone)) return c.json({ error: 'unknown_zone', reason: `zone must be one of the ${ZONE_SET.size} area zones`, knownZones: [...ZONE_SET] }, 400);
    updates.zone = zone;
  }
  if (p.prefixStart !== undefined) updates.prefix_start = p.prefixStart;
  if (p.prefixEnd !== undefined) updates.prefix_end = p.prefixEnd;
  if (p.label !== undefined) updates.label = p.label;
  if (p.isActive !== undefined) updates.is_active = p.isActive;
  if (Object.keys(updates).length === 0) return c.json({ error: 'no_changes' }, 400);
  // A range flip (start > end) trips the table CHECK — guard for a clean 400.
  const nextStart = updates.prefix_start ?? undefined;
  const nextEnd = updates.prefix_end ?? undefined;
  if (nextStart !== undefined && nextEnd !== undefined && Number(nextStart) > Number(nextEnd)) {
    return c.json({ error: 'invalid_range', reason: 'prefixStart must be <= prefixEnd' }, 400);
  }
  updates.updated_by = user?.id ?? null;
  updates.updated_at = new Date().toISOString();

  const sb = c.get('supabase');
  const { data, error } = await scopeToCompanyId(
    sb.from('delivery_zone_postcodes').update(updates).eq('id', id),
    co.companyId,
  ).select(MAP_COLS).maybeSingle();
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_rule', reason: 'That exact zone + prefix range already exists.' }, 409);
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'update_failed', reason: error.message }, 500);
  }
  if (!data) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ zone: mapOut(data as MapRow) });
});

// ── DELETE /:id — remove a zone rule. STRICT company scope. ────────────────────
deliveryZones.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const { data: deleted, error } = await scopeToCompanyId(
    sb.from('delivery_zone_postcodes').delete().eq('id', id),
    co.companyId,
  ).select('id').maybeSingle();
  if (error) {
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'delete_failed', reason: error.message }, 500);
  }
  if (!deleted) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ ok: true });
});

// ── The auto-propose action ───────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const proposeSchema = z.object({
  soDocNos: z.array(z.string().trim().min(1)).min(1).max(2000),
  depotWarehouseId: z.string().uuid().nullable().optional(),
  startDate: z.string().regex(ISO_DATE).optional(),
  defaultMaxSets: z.number().int().min(1).max(1000).optional(),
  defaultMaxRevenueCenti: z.number().int().min(1).optional(),
});

/** Malaysian "today" (UTC+8) as YYYY-MM-DD — the default proposal start date. */
function todayMY(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const CAP_LAYERS: ReadonlySet<string> = new Set(['SETS', 'REVENUE', 'BOTH']);
function normCategory(raw: string): SetLineCategory {
  const g = (raw ?? '').trim().toUpperCase();
  if (g.includes('BEDFRAME')) return 'BEDFRAME';
  if (g.includes('SOFA')) return 'SOFA';
  if (g.includes('MATTRESS')) return 'MATTRESS';
  if (g.includes('ACCESSOR')) return 'ACCESSORY';
  if (g.includes('SERVICE')) return 'SERVICE';
  return 'OTHERS';
}

/** The columns the packer + the A2 sequencer both read off an SO header. The
 *  A1 packer uses postcode + revenue; A2 additionally geocodes (state/country)
 *  and reads the residence rule by building_type. One superset select serves both. */
const SO_PACK_COLS = 'doc_no, debtor_name, address1, address2, postcode, customer_state, customer_country, building_type, local_total_centi';

interface PackContext {
  startDate: string;
  usingDefault: boolean;
  lorries: PackLorry[];
  result: ReturnType<typeof packProposals>;
  enrich: Map<string, { debtorName: string | null; sets: number; revenueCenti: number; zone: string }>;
  unzoned: Array<{ ref: string; debtorName: string | null; reason: string }>;
  soByDoc: Map<string, Record<string, unknown>>;
}

/** Load + pack — the SHARED core of `/propose` (A1) and `/sequence-assign` (A2),
 *  so the two can never disagree about which orders group onto which lorry-day. */
async function loadAndPack(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: any,
  params: { soDocNos: string[]; depotWarehouseId: string | null; startDate: string; defaultMaxSets: number; defaultMaxRevenueCenti: number },
): Promise<{ ok: true; ctx: PackContext } | { ok: false; status: 500; error: string; reason: string }> {
  const sb = c.get('supabase');
  const { soDocNos, depotWarehouseId, startDate, defaultMaxSets, defaultMaxRevenueCenti } = params;

  // 1. Company zone map (falls back to the in-code default when unset).
  const { data: mapRows } = await paginateAll<MapRow>((from, to) =>
    scopeToCompany(sb.from('delivery_zone_postcodes').select(MAP_COLS), c).range(from, to),
  );
  const { map: zoneMap, usingDefault } = toPrefixMap(mapRows ?? []);

  // 2. Load the selected SOs (address + revenue + geocode/window inputs).
  const { data: soRows, error: soErr } = await scopeToAllowedCompanies(
    sb.from('mfg_sales_orders').select(SO_PACK_COLS).in('doc_no', soDocNos),
    c,
  );
  if (soErr) return { ok: false, status: 500, error: 'load_failed', reason: soErr.message };
  const soByDoc = new Map<string, Record<string, unknown>>();
  for (const r of (soRows ?? []) as Array<Record<string, unknown>>) {
    soByDoc.set(String((r.docNo ?? r.doc_no) as string), r);
  }

  // 3. Line items for those SOs (set count + which warehouse holds the stock).
  const { data: itemRows } = await paginateAll<{
    doc_no: string; item_group: string | null; item_code: string | null;
    qty: number | null; cancelled: boolean | null; warehouse_id: string | null;
  }>((from, to) =>
    scopeToAllowedCompanies(
      sb.from('mfg_sales_order_items')
        .select('doc_no, item_group, item_code, qty, cancelled, warehouse_id')
        .in('doc_no', soDocNos),
      c,
    ).range(from, to),
  );
  const codes = new Set<string>();
  for (const it of (itemRows ?? [])) if (it.item_code) codes.add(it.item_code);
  const productCategory = new Map<string, SetLineCategory>();
  {
    const codeList = [...codes];
    for (let i = 0; i < codeList.length; i += 300) {
      const chunk = codeList.slice(i, i + 300);
      if (chunk.length === 0) continue;
      const { data: prodRows } = await paginateAll<{ code: string; category: string | null }>((from, to) =>
        sb.from('mfg_products').select('code, category').in('code', chunk).range(from, to),
      );
      for (const p of (prodRows ?? [])) if (p.category) productCategory.set(p.code, normCategory(p.category));
    }
  }
  type Line = { category: SetLineCategory; qty: number | null; cancelled: boolean | null };
  const linesByDoc = new Map<string, Line[]>();
  for (const it of (itemRows ?? [])) {
    const dn = String(it.doc_no);
    const cat = (it.item_code ? productCategory.get(it.item_code) : undefined) ?? normCategory(it.item_group ?? '');
    const arr = linesByDoc.get(dn) ?? [];
    arr.push({ category: cat, qty: it.qty, cancelled: it.cancelled });
    linesByDoc.set(dn, arr);
  }

  // 4. Depot lorries — active, in-house, optionally filtered to the depot.
  let lq = sb.from('lorries')
    .select('id, plate, active, is_internal, warehouse_id, max_sets, max_revenue_centi, capacity_layer')
    .eq('active', true)
    .eq('is_internal', true)
    .order('plate');
  if (depotWarehouseId) lq = lq.eq('warehouse_id', depotWarehouseId);
  const { data: lorryRows, error: lorryErr } = await lq;
  if (lorryErr) return { ok: false, status: 500, error: 'load_failed', reason: lorryErr.message };
  const lorries: PackLorry[] = ((lorryRows ?? []) as Array<Record<string, unknown>>).map((l) => {
    const row = l;
    const layerRaw = String((row.capacityLayer ?? row.capacity_layer ?? 'SETS')).toUpperCase();
    const layer: CapacityLayer = (CAP_LAYERS.has(layerRaw) ? layerRaw : 'SETS') as CapacityLayer;
    const ms = row.maxSets ?? row.max_sets;
    const mr = row.maxRevenueCenti ?? row.max_revenue_centi;
    return {
      id: String(row.id),
      plate: String(row.plate ?? ''),
      maxSets: ms == null ? null : Number(ms),
      maxRevenueCenti: mr == null ? null : Number(mr),
      layer,
    };
  });

  // 5. Build pack orders; unzoned orders (no postcode / unmapped) are reported.
  const orders: PackOrder[] = [];
  const unzoned: Array<{ ref: string; debtorName: string | null; reason: string }> = [];
  const enrich = new Map<string, { debtorName: string | null; sets: number; revenueCenti: number; zone: string }>();
  for (const docNo of soDocNos) {
    const row = soByDoc.get(docNo);
    if (!row) { unzoned.push({ ref: docNo, debtorName: null, reason: 'order not found or not in your company' }); continue; }
    const debtorName = ((row.debtorName ?? row.debtor_name) ?? null) as string | null;
    const zr = zoneForAddress({
      postcode: ((row.postcode ?? null) as string | null),
      address1: ((row.address1 ?? null) as string | null),
      address2: ((row.address2 ?? null) as string | null),
    }, zoneMap);
    const sc = deriveSetCount(linesByDoc.get(docNo) ?? []);
    const revenueCenti = Number((row.localTotalCenti ?? row.local_total_centi) ?? 0) || 0;
    if (!zr.zone) {
      unzoned.push({ ref: docNo, debtorName, reason: zr.method === 'none' ? 'no postcode on the address' : `postcode ${zr.postcode} maps to no zone` });
      continue;
    }
    orders.push({ ref: docNo, zone: zr.zone, sets: sc.sets, revenueCenti, hasFurniture: sc.hasFurniture });
    enrich.set(docNo, { debtorName, sets: sc.sets, revenueCenti, zone: zr.zone });
  }

  // Fuller-first fill: pack the biggest orders first (sets, then revenue).
  orders.sort((a, b) => (b.sets - a.sets) || (b.revenueCenti - a.revenueCenti) || a.ref.localeCompare(b.ref));

  const result = packProposals({
    orders,
    lorries,
    config: { startDate, klangValleyZones: KLANG_VALLEY_ZONES, defaultMaxSets, defaultMaxRevenueCenti },
  });

  return { ok: true, ctx: { startDate, usingDefault, lorries, result, enrich, unzoned, soByDoc } };
}

deliveryZones.post('/propose', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = proposeSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const { soDocNos, depotWarehouseId } = parsed.data;
  const startDate = parsed.data.startDate ?? todayMY();
  const defaultMaxSets = parsed.data.defaultMaxSets ?? 10;
  const defaultMaxRevenueCenti = parsed.data.defaultMaxRevenueCenti ?? 3_000_000;

  const packed = await loadAndPack(c, { soDocNos, depotWarehouseId: depotWarehouseId ?? null, startDate, defaultMaxSets, defaultMaxRevenueCenti });
  if (!packed.ok) return c.json({ error: packed.error, reason: packed.reason }, packed.status);
  const { ctx } = packed;

  const proposals = ctx.result.proposals.map((p) => ({
    ...p,
    debtorName: ctx.enrich.get(p.ref)?.debtorName ?? null,
  }));

  return c.json({
    startDate,
    usingDefaultZoneMap: ctx.usingDefault,
    depotWarehouseId: depotWarehouseId ?? null,
    lorryCount: ctx.lorries.length,
    capacityDefaults: { maxSets: defaultMaxSets, maxRevenueCenti: defaultMaxRevenueCenti },
    proposals,
    days: ctx.result.days,
    unassigned: [
      ...ctx.unzoned.map((u) => ({ ref: u.ref, zone: null as string | null, reason: u.reason })),
      ...ctx.result.unassigned,
    ],
  });
});

/* ──────────────────────────────────────────────────────────────────────────
   POST /sequence-assign — Fleet Module A2. Takes a locked day's zone-packed
   groups (re-derived through the SAME A1 packer) and turns each into an ordered,
   crewed trip:
     1. SEQUENCE  — order each group's stops via the Phase-3 nearest-neighbour
        sequencer (propose-route.ts), depot = the warehouse origin, with per-stop
        arrival / start / finish times + ETA offsets. Reuses buildSequenceProposal.
     2. ASSIGN    — greedy lorry + driver + helper from the depot's AVAILABLE
        fleet (assignFleet). A lorry Module B (fleet-status) has grounded —
        BREAKDOWN / COMPLIANCE_BLOCKED / OUT_OF_SERVICE / a maintenance window —
        is EXCLUDED. Capacity fit + day-load balancing folded in.
     3. WINDOWS   — each stop carries its residence-rule delivery window.
   DISPLAY-ONLY. Writes NOTHING — everything is overridable on screen, and the
   established schedule write-path (PATCH /delivery-planning/so/:id/schedule)
   persists the accepted date + lorry + driver + helper + sequence. Google is
   hard-gated on GOOGLE_MAPS_API_KEY: unset -> the trips still come back crewed
   and grouped, just without a computed route (the plain order is kept).
   ─────────────────────────────────────────────────────────────────────────*/
const sequenceAssignSchema = z.object({
  soDocNos: z.array(z.string().trim().min(1)).min(1).max(2000),
  depotWarehouseId: z.string().uuid().nullable().optional(),
  startDate: z.string().regex(ISO_DATE).optional(),
  departTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'departTime must be HH:MM').optional(),
  defaultMaxSets: z.number().int().min(1).max(1000).optional(),
  defaultMaxRevenueCenti: z.number().int().min(1).optional(),
  // A3: own-fleet trips per lorry per day before the rest spill to 3PL overflow.
  maxTripsPerLorryPerDay: z.number().int().min(1).max(20).optional(),
});

const DEFAULT_SERVICE_MIN = 90;

deliveryZones.post('/sequence-assign', async (c) => {
  const sb = c.get('supabase');
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = sequenceAssignSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const { soDocNos, depotWarehouseId } = parsed.data;
  const startDate = parsed.data.startDate ?? todayMY();
  const departTime = parsed.data.departTime ?? '09:00';
  const departMin = timeToMinutes(departTime) ?? 9 * 60;
  const defaultMaxSets = parsed.data.defaultMaxSets ?? 10;
  const defaultMaxRevenueCenti = parsed.data.defaultMaxRevenueCenti ?? 3_000_000;

  // 1. Pack (A1) — the SAME grouping the review screen shows.
  const packed = await loadAndPack(c, { soDocNos, depotWarehouseId: depotWarehouseId ?? null, startDate, defaultMaxSets, defaultMaxRevenueCenti });
  if (!packed.ok) return c.json({ error: packed.error, reason: packed.reason }, packed.status);
  const { ctx } = packed;

  // 2. Turn each packed lorry-trip into a crew-able GROUP.
  const groups: AssignGroup[] = [];
  for (const day of ctx.result.days) {
    day.lorries.forEach((l, idx) => {
      groups.push({
        key: `${day.date}|${day.group}|${idx}`,
        date: day.date,
        group: day.group,
        orders: l.orders,
        sets: l.sets,
        revenueCenti: l.revenueCenti,
        preferredLorryId: l.lorryId,
      });
    });
  }
  // Biggest-first, so the fuller trips get first pick of the fleet.
  groups.sort((a, b) => (b.sets - a.sets) || (b.revenueCenti - a.revenueCenti) || a.key.localeCompare(b.key));

  // 3. Available fleet (Module B) + crew rosters.
  const today = todayMY();
  const availLorries = await loadAvailableLorries(sb, { depotWarehouseId: depotWarehouseId ?? null, today });
  const { data: driverRows } = await sb.from('drivers').select('id, name, vehicle').eq('active', true);
  const { data: helperRows } = await sb.from('helpers').select('id, name').eq('active', true);
  const drivers = ((driverRows ?? []) as Array<Record<string, unknown>>).map((d) => ({
    id: String(d.id), name: String(d.name ?? ''), vehiclePlate: (d.vehicle ?? null) as string | null,
  }));
  const helpers = ((helperRows ?? []) as Array<Record<string, unknown>>).map((h) => ({
    id: String(h.id), name: String(h.name ?? ''),
  }));

  // A3: driver leave over the planning window (the packed group dates), so a
  // driver on leave is not auto-crewed onto a trip that falls on a leave day.
  const groupDates = groups.map((g) => g.date).filter((d) => ISO_DATE.test(d));
  const leaveFrom = groupDates.length ? groupDates.reduce((m, d) => (d < m ? d : m), groupDates[0]) : startDate;
  const leaveTo = groupDates.length ? groupDates.reduce((m, d) => (d > m ? d : m), groupDates[0]) : startDate;
  const { ranges: driverLeave, excludedDrivers, helperRanges: helperLeave, excludedHelpers } = await loadDriverLeave(sb, { from: leaveFrom, to: leaveTo });

  // A3: the region's 3PL carriers — OUTSOURCE / non-internal lorries the
  // dispatcher can assign overflow trips to. Depot-scoped when a depot is picked,
  // plus any carrier not pinned to a warehouse (a shared 3PL). Reuses
  // scm.lorries (type='OUTSOURCE', is_internal=false) — no parallel carrier master.
  const { data: carrierRows } = await sb.from('lorries')
    .select('id, plate, warehouse_id, type')
    .eq('active', true).eq('is_internal', false).order('plate');
  const carriers = ((carrierRows ?? []) as Array<Record<string, unknown>>)
    .map((l) => ({
      id: String(l.id),
      plate: String(l.plate ?? ''),
      warehouseId: (l.warehouseId ?? l.warehouse_id ?? null) as string | null,
    }))
    .filter((l) => !depotWarehouseId || l.warehouseId == null || l.warehouseId === depotWarehouseId);

  const assigned = assignFleet({
    groups,
    lorries: availLorries.map((l) => ({
      id: l.id, plate: l.plate, dispatchable: l.dispatchable, status: l.statusLabel,
      maxSets: l.maxSets, maxRevenueCenti: l.maxRevenueCenti, layer: l.layer,
      driverId: l.driverId, driverName: l.driverName,
    })),
    drivers,
    helpers,
    config: { defaultMaxSets, defaultMaxRevenueCenti, maxTripsPerLorryPerDay: parsed.data.maxTripsPerLorryPerDay },
    driverLeave,
    helperLeave,
  });

  // 4. Residence rules — building_type -> service duration + window.
  const { data: ruleRows } = await scopeToAllowedCompanies(
    sb.from('delivery_residence_rules')
      .select('building_type, service_duration_minutes, earliest_delivery_time, latest_delivery_time, is_active'),
    c,
  );
  const ruleByType = new Map<string, { service: number; earliest: number | null; latest: number | null }>();
  for (const r of (ruleRows ?? []) as Array<Record<string, unknown>>) {
    const type = String((r.buildingType ?? r.building_type ?? '') as string).trim().toLowerCase();
    if (type === '') continue;
    if (((r.isActive ?? r.is_active) as boolean | null) === false) continue;
    ruleByType.set(type, {
      service: Number((r.serviceDurationMinutes ?? r.service_duration_minutes) ?? DEFAULT_SERVICE_MIN),
      earliest: timeToMinutes((r.earliestDeliveryTime ?? r.earliest_delivery_time) as string | null),
      latest: timeToMinutes((r.latestDeliveryTime ?? r.latest_delivery_time) as string | null),
    });
  }
  const ruleFor = (buildingType: string | null) =>
    ruleByType.get((buildingType ?? '').trim().toLowerCase()) ?? { service: DEFAULT_SERVICE_MIN, earliest: null, latest: null };

  // 5. Geocode the depot once (cache-first), then sequence each assigned trip.
  const configured = !!c.env.GOOGLE_MAPS_API_KEY;
  let depotOut: { warehouseId: string | null; address: string; lat: number; lng: number } | null = null;
  if (configured && depotWarehouseId) {
    const { data: wh } = await sb.from('warehouses').select('name, location, city, state, postcode').eq('id', depotWarehouseId).maybeSingle();
    if (wh) {
      const w = wh as Record<string, unknown>;
      const depotAddress = composeAddress({
        address1: (w.location ?? null) as string | null,
        address2: (w.city ?? null) as string | null,
        postcode: (w.postcode ?? null) as string | null,
        state: (w.state ?? null) as string | null,
      }) || String((w.name ?? '') as string).trim();
      const hit = depotAddress ? await geocodeAddressCached(sb, c.env, depotAddress) : null;
      if (hit) depotOut = { warehouseId: depotWarehouseId, address: depotAddress, lat: hit.lat, lng: hit.lng };
    }
  }

  // Build the per-stop window/service info for every referenced order, geocoding
  // cache-first (only when Google is configured + the depot resolved).
  const stopInfo = (docNo: string) => {
    const row = ctx.soByDoc.get(docNo);
    const debtorName = ((row?.debtorName ?? row?.debtor_name) ?? null) as string | null;
    const buildingType = ((row?.buildingType ?? row?.building_type) ?? null) as string | null;
    const rule = ruleFor(buildingType);
    const address = row ? composeAddress({
      address1: (row.address1 ?? null) as string | null,
      address2: (row.address2 ?? null) as string | null,
      postcode: (row.postcode ?? null) as string | null,
      state: (row.customerState ?? row.customer_state ?? null) as string | null,
      country: (row.customerCountry ?? row.customer_country ?? null) as string | null,
    }) : '';
    return { debtorName, buildingType, address, rule };
  };

  const trips = [];
  for (const a of assigned.assignments) {
    const stops = a.orders.map((ref) => {
      const info = stopInfo(ref);
      return {
        ref,
        debtorName: info.debtorName,
        buildingType: info.buildingType,
        address: info.address,
        serviceMinutes: info.rule.service,
        earliestTime: minutesToTime(info.rule.earliest),
        latestTime: minutesToTime(info.rule.latest),
      };
    });

    let sequence: ReturnType<typeof buildSequenceProposal> | null = null;
    let routeReason: string | null = null;
    const ungeocoded: string[] = [];

    if (!configured) {
      routeReason = 'GOOGLE_MAPS_API_KEY not set — trip is crewed and grouped, no computed route';
    } else if (!depotOut) {
      routeReason = 'depot could not be geocoded — set the warehouse address to sequence the route';
    } else {
      // Geocode this trip's stops (cache-first), preserving order.
      const geocoded: Array<{ ref: string; lat: number; lng: number; svc: number; earliest: number | null; latest: number | null }> = [];
      for (const s of stops) {
        if (!s.address.trim()) { ungeocoded.push(s.ref); continue; }
        const hit = await geocodeAddressCached(sb, c.env, s.address);
        if (!hit) { ungeocoded.push(s.ref); continue; }
        geocoded.push({ ref: s.ref, lat: hit.lat, lng: hit.lng, svc: s.serviceMinutes, earliest: timeToMinutes(s.earliestTime), latest: timeToMinutes(s.latestTime) });
      }
      if (geocoded.length === 0) {
        routeReason = 'no stop on this trip could be geocoded';
      } else {
        const points: LatLngPoint[] = [{ lat: depotOut.lat, lng: depotOut.lng }, ...geocoded.map((g) => ({ lat: g.lat, lng: g.lng }))];
        const matrix = await travelTimeMatrix(c.env, points);
        if (!matrix.ok) {
          routeReason = matrix.reason ?? 'travel matrix unavailable';
        } else {
          const seqStops: SequenceStopInput[] = geocoded.map((g) => ({ ref: g.ref, serviceMinutes: g.svc, earliestMin: g.earliest, latestMin: g.latest }));
          sequence = buildSequenceProposal({ departMin, stops: seqStops, travelSeconds: matrix.durationSeconds, distanceMetres: matrix.distanceMetres });
        }
      }
    }

    trips.push({
      key: a.key,
      date: a.date,
      group: a.group,
      lorryId: a.lorryId,
      plate: a.plate,
      driverId: a.driverId,
      driverName: a.driverName,
      helperId: a.helperId,
      helperName: a.helperName,
      sets: a.sets,
      revenueCenti: a.revenueCenti,
      ceilingSets: a.ceilingSets,
      ceilingRevenueCenti: a.ceilingRevenueCenti,
      overCeiling: a.overCeiling,
      departTime,
      stops,
      sequence,
      routeReason,
      ungeocoded,
    });
  }

  return c.json({
    startDate,
    departTime,
    configured,
    usingDefaultZoneMap: ctx.usingDefault,
    depotWarehouseId: depotWarehouseId ?? null,
    depot: depotOut,
    lorryCount: availLorries.length,
    dispatchableCount: availLorries.filter((l) => l.dispatchable).length,
    trips,
    excludedLorries: assigned.excludedLorries,
    // A3/WS2: drivers and helpers withheld from the auto-pick because they are on
    // leave, and the groups the own fleet could not cover (3PL-assignment
    // candidates) plus the region's available 3PL carriers.
    excludedDrivers,
    excludedHelpers,
    overflow: assigned.overflow,
    carriers,
    unassigned: [
      ...ctx.unzoned.map((u) => ({ key: null as string | null, date: null as string | null, group: null as string | null, orders: [u.ref], reason: u.reason })),
      ...assigned.unassigned,
    ],
  });
});

// ── Day locks ─────────────────────────────────────────────────────────────────

const LOCK_COLS = 'id, warehouse_id, delivery_date, notes, locked_by, locked_at';
function lockOut(r: Record<string, unknown>) {
  return {
    id: String(r.id),
    warehouseId: (r.warehouseId ?? r.warehouse_id ?? null) as string | null,
    deliveryDate: String((r.deliveryDate ?? r.delivery_date) ?? '').slice(0, 10),
    notes: (r.notes ?? null) as string | null,
    lockedBy: (r.lockedBy ?? r.locked_by ?? null) as string | null,
    lockedAt: (r.lockedAt ?? r.locked_at ?? null) as string | null,
  };
}

// GET /locks?warehouseId=&from=&to= — the locked days for a depot / range.
deliveryZones.get('/locks', async (c) => {
  const sb = c.get('supabase');
  const warehouseId = c.req.query('warehouseId');
  const from = c.req.query('from');
  const to = c.req.query('to');
  let q = scopeToCompany(sb.from('delivery_day_locks').select(LOCK_COLS), c).order('delivery_date', { ascending: true });
  if (warehouseId) q = q.eq('warehouse_id', warehouseId);
  if (from && ISO_DATE.test(from)) q = q.gte('delivery_date', from);
  if (to && ISO_DATE.test(to)) q = q.lte('delivery_date', to);
  const { data, error } = await q;
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  return c.json({ locks: ((data ?? []) as Array<Record<string, unknown>>).map(lockOut) });
});

const lockSchema = z.object({
  deliveryDate: z.string().regex(ISO_DATE),
  warehouseId: z.string().uuid().nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});

// POST /locks — lock a (warehouse, date). Idempotent: re-locking the same day
// returns the existing lock rather than a 409.
deliveryZones.post('/locks', async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = lockSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const p = parsed.data;
  const user = c.get('user') as { id?: string } | null;

  const sb = c.get('supabase');
  const { data, error } = await sb.from('delivery_day_locks').upsert({
    company_id: co.companyId,
    warehouse_id: p.warehouseId ?? null,
    delivery_date: p.deliveryDate,
    notes: p.notes ?? null,
    locked_by: user?.id ?? null,
  }, { onConflict: 'company_id,warehouse_id,delivery_date' }).select(LOCK_COLS).single();
  if (error) {
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'lock_failed', reason: error.message }, 500);
  }
  return c.json({ lock: lockOut(data as Record<string, unknown>) }, 201);
});

// DELETE /locks/:id — unlock (reversible). STRICT company scope.
deliveryZones.delete('/locks/:id', async (c) => {
  const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const { data: deleted, error } = await scopeToCompanyId(
    sb.from('delivery_day_locks').delete().eq('id', id),
    co.companyId,
  ).select('id').maybeSingle();
  if (error) {
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'unlock_failed', reason: error.message }, 500);
  }
  if (!deleted) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ ok: true });
});

export default deliveryZones;
