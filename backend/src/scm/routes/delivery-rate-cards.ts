// ----------------------------------------------------------------------------
// /delivery-rate-cards — Fleet Module C: 3PL / own-fleet delivery RATE CARDS,
// the pure cost CALCULATOR, and the 3PL charge RECONCILIATION view.
//
// FOUR surfaces, one router:
//   1. CRUD over scm.delivery_rate_cards + scm.delivery_rate_rules (mig 0207) —
//      the owner builds a card per carrier: charging basis (item/set), aggregation
//      (drop/customer), positional tiers, cap+overage, sofa compartment brackets,
//      outstation zone surcharges, dispose/setup/dismantle, and the service /
//      pickup / inspection / transfer order-type charges. Own-fleet gets a card
//      too (is_own_fleet) so a 3PL drop and an own-fleet drop compare per drop.
//   2. POST /:id/compute — run the PURE computeDeliveryCost (delivery-rate-card.ts)
//      against a card for a set of delivery facts. Returns the itemised breakdown.
//      Writes nothing — the admin "cost calculator" test panel and the
//      reconciliation both use it.
//   3. GET /reconcile — the 3PL charge reconciliation. Lists OUTSOURCE trips that
//      carry a captured billed cost (scm.trips.three_pl_cost_centi, set in A3),
//      matches each to its carrier's rate card, derives the drop's facts from the
//      trip's stops (set count + destination zone), computes the EXPECTED cost,
//      and flags the delta (billed - expected). COST verification, not billing.
//   4. GET /meta — the carriers (lorries) + known zones the editor selects from.
//
// COGS ATTRIBUTION SEAM. The computed/reconciled delivery cost is an ATTACHED
// cost surfaced read-only here (and available to the DO/trip margin surface); it
// does NOT touch the FIFO lot / consumption money-path triggers. See the module
// doc for the documented COGS-rollup seam left for owner review.
//
// Mounted at '/delivery-rate-cards' in scm/index.ts behind
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
  companyCodeMap,
  withCompanyCode,
  NOT_THIS_COMPANY,
} from '../lib/companyScope';
import {
  computeDeliveryCost,
  tripOutstationFeeCenti,
  type RateCardSpec,
  type RateRuleSpec,
  type RateRuleType,
  type DeliveryFacts,
} from '../lib/delivery-rate-card';
import { ZONE_SET, DEFAULT_ZONE_PREFIX_MAP, zoneForAddress, type ZonePrefixRule } from '../lib/zone-classify';
import { deriveSetCount, type SetLine } from '../lib/set-count';
import { composeAddress } from '../lib/geocode';

export const deliveryRateCards = new Hono<{ Bindings: Env; Variables: Variables }>();
deliveryRateCards.use('*', supabaseAuth);

// The Module C tables (mig 0207) are not in the generated Supabase types yet —
// the schema types regenerate after the migration merges. Until then the query
// builder widens select() on these two tables to GenericStringError; rc() is the
// narrow, table-local `any` bridge so the row shaping (cardOut/ruleOut) stays the
// single source of the wire shape. Existing typed tables are untouched.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rc = (sb: unknown): any => sb;

const RULE_TYPES: readonly RateRuleType[] = [
  'POSITIONAL_TIER', 'OVERAGE', 'SOFA_BRACKET', 'OUTSTATION', 'OUTSTATION_TRIP',
  'DISPOSE', 'SETUP', 'DISMANTLE', 'SERVICE', 'PICKUP', 'INSPECTION', 'TRANSFER',
];
const RULE_TYPE_SET = new Set<string>(RULE_TYPES);

const CARD_COLS =
  'id, name, carrier_lorry_id, carrier_company_id, carrier_label, is_own_fleet, basis, aggregation, ' +
  'min_charge_centi, cap_centi, rounding, is_active, notes, created_at, updated_at';
const RULE_COLS =
  'id, card_id, rule_type, tier_position, bracket_min, bracket_max, zone, amount_centi, params, sort_order';

type Row = Record<string, unknown>;
const s = (v: unknown): string | null => (v == null ? null : String(v));
const n = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

function cardOut(r: Row) {
  return {
    id: String(r.id),
    name: String(r.name ?? ''),
    carrierLorryId: s(r.carrier_lorry_id),
    carrierCompanyId: s(r.carrier_company_id),
    carrierLabel: s(r.carrier_label),
    isOwnFleet: r.is_own_fleet === true,
    basis: (String(r.basis ?? 'SET') === 'ITEM' ? 'ITEM' : 'SET') as 'ITEM' | 'SET',
    aggregation: (String(r.aggregation ?? 'DROP') === 'CUSTOMER' ? 'CUSTOMER' : 'DROP') as 'DROP' | 'CUSTOMER',
    minChargeCenti: n(r.min_charge_centi),
    capCenti: n(r.cap_centi),
    rounding: String(r.rounding ?? 'NONE'),
    isActive: r.is_active !== false,
    notes: s(r.notes),
    createdAt: s(r.created_at),
    updatedAt: s(r.updated_at),
  };
}

function ruleOut(r: Row) {
  return {
    id: String(r.id),
    cardId: String(r.card_id),
    ruleType: String(r.rule_type) as RateRuleType,
    tierPosition: n(r.tier_position),
    bracketMin: n(r.bracket_min),
    bracketMax: n(r.bracket_max),
    zone: s(r.zone),
    amountCenti: Number(r.amount_centi ?? 0),
    params: (r.params ?? null) as Record<string, unknown> | null,
    sortOrder: Number(r.sort_order ?? 0),
  };
}

/** A card's stored rules -> the pure calculator's RateRuleSpec[]. */
function toRuleSpecs(rules: ReturnType<typeof ruleOut>[]): RateRuleSpec[] {
  return rules.map((r) => ({
    ruleType: r.ruleType,
    tierPosition: r.tierPosition,
    bracketMin: r.bracketMin,
    bracketMax: r.bracketMax,
    zone: r.zone,
    amountCenti: r.amountCenti,
  }));
}

function toCardSpec(card: ReturnType<typeof cardOut>, rules: ReturnType<typeof ruleOut>[]): RateCardSpec {
  return {
    basis: card.basis,
    aggregation: card.aggregation,
    minChargeCenti: card.minChargeCenti,
    capCenti: card.capCenti,
    rounding: card.rounding as RateCardSpec['rounding'],
    rules: toRuleSpecs(rules),
  };
}

// ── GET /meta — carriers (lorries) + known zones for the editor selects. ─────
deliveryRateCards.get('/meta', async (c) => {
  const sb = c.get('supabase');
  const { data } = await paginateAll<Row>((lo, hi) =>
    scopeToAllowedCompanies(sb.from('lorries').select('id, plate, type, is_internal').order('plate', { ascending: true }), c).range(lo, hi),
  );
  const carriers = (data ?? []).map((r) => ({
    id: String(r.id),
    plate: String(r.plate ?? ''),
    type: s(r.type),
    isInternal: r.is_internal !== false,
  }));
  // WS4b: 3PL companies — a card is now priced per company (its lorries inherit).
  const { data: coData } = await paginateAll<Row>((lo, hi) =>
    scopeToCompany(sb.from('threepl_companies').select('id, name, is_active'), c)
      .eq('is_active', true).order('name', { ascending: true }).range(lo, hi),
  );
  const companies = (coData ?? []).map((r) => ({ id: String(r.id), name: String(r.name ?? '') }));
  return c.json({ carriers, companies, ruleTypes: RULE_TYPES, zones: [...ZONE_SET] });
});

// ── GET / — list the company's rate cards (each with its rule count). ────────
deliveryRateCards.get('/', async (c) => {
  const sb = c.get('supabase');
  const { data, error } = await paginateAll<Row>((lo, hi) =>
    scopeToCompany(rc(sb).from('delivery_rate_cards').select(CARD_COLS), c)
      .order('name', { ascending: true }).range(lo, hi),
  );
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  const cards = (data ?? []).map(cardOut);
  // Rule counts per card (one query).
  const ids = cards.map((x) => x.id);
  const countById = new Map<string, number>();
  if (ids.length > 0) {
    const { data: ruleRows } = await paginateAll<Row>((lo, hi) =>
      scopeToCompany(rc(sb).from('delivery_rate_rules').select('card_id'), c).in('card_id', ids).range(lo, hi),
    );
    for (const r of ruleRows ?? []) countById.set(String(r.card_id), (countById.get(String(r.card_id)) ?? 0) + 1);
  }
  return c.json({ cards: cards.map((x) => ({ ...x, ruleCount: countById.get(x.id) ?? 0 })) });
});

const cardCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  carrierLorryId: z.string().uuid().nullable().optional(),
  carrierCompanyId: z.string().uuid().nullable().optional(),
  carrierLabel: z.string().trim().max(120).nullable().optional(),
  isOwnFleet: z.boolean().optional(),
  basis: z.enum(['ITEM', 'SET']).optional(),
  aggregation: z.enum(['DROP', 'CUSTOMER']).optional(),
  minChargeCenti: z.number().int().min(0).nullable().optional(),
  capCenti: z.number().int().min(0).nullable().optional(),
  rounding: z.enum(['NONE', 'NEAREST_10C', 'NEAREST_RM']).optional(),
  isActive: z.boolean().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

// ── POST / — create a card. ──────────────────────────────────────────────────
deliveryRateCards.post('/', async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = cardCreateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const p = parsed.data;
  const user = c.get('user') as { id?: string } | null;
  const sb = c.get('supabase');
  const { data, error } = await rc(sb).from('delivery_rate_cards').insert({
    company_id: co.companyId,
    name: p.name,
    carrier_lorry_id: p.carrierLorryId ?? null,
    carrier_company_id: p.carrierCompanyId ?? null,
    carrier_label: p.carrierLabel ?? null,
    is_own_fleet: p.isOwnFleet ?? false,
    basis: p.basis ?? 'SET',
    aggregation: p.aggregation ?? 'DROP',
    min_charge_centi: p.minChargeCenti ?? null,
    cap_centi: p.capCenti ?? null,
    rounding: p.rounding ?? 'NONE',
    is_active: p.isActive ?? true,
    notes: p.notes ?? null,
    created_by: user?.id ?? null,
    updated_by: user?.id ?? null,
  }).select(CARD_COLS).single();
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_name', reason: 'A card with that name already exists.' }, 409);
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  return c.json({ card: cardOut(data as Row) }, 201);
});

const cardPatchSchema = cardCreateSchema.partial();

// ── PATCH /:id — edit a card. STRICT company scope. ──────────────────────────
deliveryRateCards.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = cardPatchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const p = parsed.data;
  const updates: Record<string, unknown> = {};
  if (p.name !== undefined) updates.name = p.name;
  if (p.carrierLorryId !== undefined) updates.carrier_lorry_id = p.carrierLorryId;
  if (p.carrierCompanyId !== undefined) updates.carrier_company_id = p.carrierCompanyId;
  if (p.carrierLabel !== undefined) updates.carrier_label = p.carrierLabel;
  if (p.isOwnFleet !== undefined) updates.is_own_fleet = p.isOwnFleet;
  if (p.basis !== undefined) updates.basis = p.basis;
  if (p.aggregation !== undefined) updates.aggregation = p.aggregation;
  if (p.minChargeCenti !== undefined) updates.min_charge_centi = p.minChargeCenti;
  if (p.capCenti !== undefined) updates.cap_centi = p.capCenti;
  if (p.rounding !== undefined) updates.rounding = p.rounding;
  if (p.isActive !== undefined) updates.is_active = p.isActive;
  if (p.notes !== undefined) updates.notes = p.notes;
  if (Object.keys(updates).length === 0) return c.json({ error: 'no_changes' }, 400);
  const user = c.get('user') as { id?: string } | null;
  updates.updated_by = user?.id ?? null;
  updates.updated_at = new Date().toISOString();
  const sb = c.get('supabase');
  const { data, error } = await scopeToCompanyId(rc(sb).from('delivery_rate_cards').update(updates).eq('id', id), co.companyId).select(CARD_COLS).maybeSingle();
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_name', reason: 'A card with that name already exists.' }, 409);
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'update_failed', reason: error.message }, 500);
  }
  if (!data) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ card: cardOut(data as Row) });
});

// ── DELETE /:id — remove a card (its rules cascade). ─────────────────────────
deliveryRateCards.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const { data: deleted, error } = await scopeToCompanyId(rc(sb).from('delivery_rate_cards').delete().eq('id', id), co.companyId).select('id').maybeSingle();
  if (error) {
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'delete_failed', reason: error.message }, 500);
  }
  if (!deleted) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ ok: true });
});

// ── Rule CRUD ────────────────────────────────────────────────────────────────
const ruleCreateSchema = z.object({
  ruleType: z.enum(RULE_TYPES as [RateRuleType, ...RateRuleType[]]),
  tierPosition: z.number().int().min(1).nullable().optional(),
  bracketMin: z.number().int().min(0).nullable().optional(),
  bracketMax: z.number().int().min(0).nullable().optional(),
  zone: z.string().trim().max(40).nullable().optional(),
  amountCenti: z.number().int().min(0),
  params: z.record(z.string(), z.unknown()).nullable().optional(),
  sortOrder: z.number().int().optional(),
});

async function loadCardForWrite(c: any, id: string, companyId: number) {
  const sb = c.get('supabase');
  const { data } = await scopeToCompanyId(rc(sb).from('delivery_rate_cards').select('id').eq('id', id), companyId).maybeSingle();
  return !!data;
}

// POST /:id/rules — add a rule to a card.
deliveryRateCards.post('/:id/rules', async (c) => {
  const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = ruleCreateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const p = parsed.data;
  if ((p.ruleType === 'OUTSTATION' || p.ruleType === 'OUTSTATION_TRIP') && p.zone && !ZONE_SET.has(p.zone.toUpperCase())) {
    return c.json({ error: 'unknown_zone', reason: 'outstation zone must be one of the area zones', knownZones: [...ZONE_SET] }, 400);
  }
  if (!(await loadCardForWrite(c, id, co.companyId))) return c.json(NOT_THIS_COMPANY, 404);
  const sb = c.get('supabase');
  const { data, error } = await rc(sb).from('delivery_rate_rules').insert({
    company_id: co.companyId,
    card_id: id,
    rule_type: p.ruleType,
    tier_position: p.tierPosition ?? null,
    bracket_min: p.bracketMin ?? null,
    bracket_max: p.bracketMax ?? null,
    zone: (p.ruleType === 'OUTSTATION' || p.ruleType === 'OUTSTATION_TRIP') && p.zone ? p.zone.toUpperCase() : (p.zone ?? null),
    amount_centi: p.amountCenti,
    params: p.params ?? null,
    sort_order: p.sortOrder ?? 0,
  }).select(RULE_COLS).single();
  if (error) {
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  return c.json({ rule: ruleOut(data as Row) }, 201);
});

const rulePatchSchema = ruleCreateSchema.partial();

// PATCH /:id/rules/:ruleId — edit a rule.
deliveryRateCards.patch('/:id/rules/:ruleId', async (c) => {
  const id = c.req.param('id');
  const ruleId = c.req.param('ruleId');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = rulePatchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const p = parsed.data;
  const updates: Record<string, unknown> = {};
  if (p.ruleType !== undefined) updates.rule_type = p.ruleType;
  if (p.tierPosition !== undefined) updates.tier_position = p.tierPosition;
  if (p.bracketMin !== undefined) updates.bracket_min = p.bracketMin;
  if (p.bracketMax !== undefined) updates.bracket_max = p.bracketMax;
  if (p.zone !== undefined) updates.zone = p.zone ? p.zone.toUpperCase() : null;
  if (p.amountCenti !== undefined) updates.amount_centi = p.amountCenti;
  if (p.params !== undefined) updates.params = p.params;
  if (p.sortOrder !== undefined) updates.sort_order = p.sortOrder;
  if (Object.keys(updates).length === 0) return c.json({ error: 'no_changes' }, 400);
  updates.updated_at = new Date().toISOString();
  const sb = c.get('supabase');
  const { data, error } = await scopeToCompanyId(
    rc(sb).from('delivery_rate_rules').update(updates).eq('id', ruleId).eq('card_id', id), co.companyId,
  ).select(RULE_COLS).maybeSingle();
  if (error) {
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'update_failed', reason: error.message }, 500);
  }
  if (!data) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ rule: ruleOut(data as Row) });
});

// DELETE /:id/rules/:ruleId — remove a rule.
deliveryRateCards.delete('/:id/rules/:ruleId', async (c) => {
  const id = c.req.param('id');
  const ruleId = c.req.param('ruleId');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const { data: deleted, error } = await scopeToCompanyId(
    rc(sb).from('delivery_rate_rules').delete().eq('id', ruleId).eq('card_id', id), co.companyId,
  ).select('id').maybeSingle();
  if (error) {
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'delete_failed', reason: error.message }, 500);
  }
  if (!deleted) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ ok: true });
});

// ── POST /:id/compute — run the pure calculator against a card for given facts.
const factsSchema = z.object({
  setCount: z.number().int().min(0).nullable().optional(),
  itemCount: z.number().int().min(0).nullable().optional(),
  sofaCompartments: z.array(z.number().int().min(0)).nullable().optional(),
  destinationZone: z.string().trim().max(40).nullable().optional(),
  disposeCount: z.number().int().min(0).nullable().optional(),
  setupCount: z.number().int().min(0).nullable().optional(),
  dismantleCount: z.number().int().min(0).nullable().optional(),
  serviceCount: z.number().int().min(0).nullable().optional(),
  pickupCount: z.number().int().min(0).nullable().optional(),
  inspectionCount: z.number().int().min(0).nullable().optional(),
  transferCount: z.number().int().min(0).nullable().optional(),
});

deliveryRateCards.post('/:id/compute', async (c) => {
  const id = c.req.param('id');
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = factsSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const sb = c.get('supabase');
  const { data: card, error } = await scopeToCompany(rc(sb).from('delivery_rate_cards').select(CARD_COLS), c).eq('id', id).maybeSingle();
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  if (!card) return c.json(NOT_THIS_COMPANY, 404);
  const { data: rules } = await paginateAll<Row>((lo, hi) =>
    scopeToCompany(rc(sb).from('delivery_rate_rules').select(RULE_COLS), c).eq('card_id', id).range(lo, hi),
  );
  const cardO = cardOut(card as Row);
  const spec = toCardSpec(cardO, (rules ?? []).map(ruleOut));
  const breakdown = computeDeliveryCost(spec, parsed.data as DeliveryFacts);
  return c.json({ card: cardO, facts: parsed.data, breakdown });
});

// ── GET /reconcile — 3PL charge reconciliation. ──────────────────────────────
// Lists OUTSOURCE trips that carry a captured billed cost and, where a carrier
// rate card exists, computes the EXPECTED cost from the trip's derived facts and
// flags the delta. COST verification only — writes nothing, touches no money-path.
//
// Facts derived from the trip's stops: the charging-unit count (sets from the
// stops' SO lines) and the destination zone (the stops' SO postcodes -> the A1
// classifier). Occurrence charges (setup/dismantle/dispose/service...) and sofa
// compartments are NOT reliably in the trip data model, so they default to 0 and
// the response flags factsComplete=false — the dispatcher refines them in the
// calculator. The set-tier + outstation portion (the bulk of a 3PL charge) is
// derived and compared automatically.
const SET_CATEGORIES = (raw: string): SetLine['category'] => {
  const g = (raw ?? '').trim().toUpperCase();
  if (g.includes('BEDFRAME')) return 'BEDFRAME';
  if (g.includes('SOFA')) return 'SOFA';
  if (g.includes('MATTRESS')) return 'MATTRESS';
  return 'OTHERS';
};

deliveryRateCards.get('/reconcile', async (c) => {
  const sb = c.get('supabase');
  const from = c.req.query('from');
  const to = c.req.query('to');
  const zoneMapRules: ZonePrefixRule[] = [...DEFAULT_ZONE_PREFIX_MAP];

  // 1) OUTSOURCE trips carrying a captured billed cost, in the date window.
  const { data: tripData, error: tripErr } = await paginateAll<Row>((lo, hi) => {
    let q = sb.from('trips')
      .select('company_id, id, trip_no, trip_date, lorry_id, warehouse_id, is_outsourced, three_pl_cost_centi, status')
      .eq('is_outsourced', true).not('three_pl_cost_centi', 'is', null)
      .order('trip_date', { ascending: false }).range(lo, hi);
    if (from) q = q.gte('trip_date', from);
    if (to) q = q.lte('trip_date', to);
    q = scopeToAllowedCompanies(q, c);
    return q;
  });
  if (tripErr) return c.json({ error: 'load_failed', reason: tripErr.message }, 500);
  const trips = (tripData ?? []);
  if (trips.length === 0) return c.json({ rows: [] });

  // 2) Rate cards for carrier match (by carrier_lorry_id).
  const { data: cardRows } = await paginateAll<Row>((lo, hi) =>
    scopeToCompany(rc(sb).from('delivery_rate_cards').select(CARD_COLS), c).eq('is_active', true).range(lo, hi),
  );
  const cards = (cardRows ?? []).map(cardOut);
  const cardByLorry = new Map<string, ReturnType<typeof cardOut>>();
  for (const cd of cards) if (cd.carrierLorryId) cardByLorry.set(cd.carrierLorryId, cd);
  // WS4b: a card priced per 3PL COMPANY applies to every lorry under it. Resolve
  // each trip's lorry -> its threepl_company_id, and match company cards first
  // (fall back to a per-lorry card for own-fleet / legacy cards).
  const cardByCompany = new Map<string, ReturnType<typeof cardOut>>();
  for (const cd of cards) if (cd.carrierCompanyId) cardByCompany.set(cd.carrierCompanyId, cd);
  const lorryIds = [...new Set(trips.map((t) => s(t.lorry_id)).filter((x): x is string => !!x))];
  const lorryCompany = new Map<string, string>();
  if (lorryIds.length) {
    const { data: lorryRows } = await sb.from('lorries').select('id, threepl_company_id').in('id', lorryIds);
    for (const lr of (lorryRows ?? []) as Row[]) {
      const cid = s(lr.threepl_company_id);
      if (cid) lorryCompany.set(String(lr.id), cid);
    }
  }
  const { data: ruleRows } = cards.length
    ? await paginateAll<Row>((lo, hi) => scopeToCompany(rc(sb).from('delivery_rate_rules').select(RULE_COLS), c).in('card_id', cards.map((x) => x.id)).range(lo, hi))
    : { data: [] as Row[] };
  const rulesByCard = new Map<string, ReturnType<typeof ruleOut>[]>();
  for (const r of ruleRows ?? []) {
    const ro = ruleOut(r);
    const arr = rulesByCard.get(ro.cardId) ?? [];
    arr.push(ro);
    rulesByCard.set(ro.cardId, arr);
  }

  // 3) Stops -> SO doc numbers per trip, then SO lines for set/zone derivation.
  const tripIds = trips.map((t) => String(t.id));
  const { data: stopData } = await sb.from('trip_stops')
    .select('trip_id, stop_type, do_id, so_id').in('trip_id', tripIds);
  const doIdsByTrip = new Map<string, string[]>();
  const allDoIds = new Set<string>();
  for (const st of (stopData ?? []) as Row[]) {
    if (String(st.stop_type ?? '') !== 'DELIVERY') continue;
    const tripId = String(st.trip_id);
    const doId = s(st.do_id);
    if (!doId) continue;
    allDoIds.add(doId);
    const arr = doIdsByTrip.get(tripId) ?? [];
    arr.push(doId);
    doIdsByTrip.set(tripId, arr);
  }
  // DO -> SO doc no.
  const soDocByDoId = new Map<string, string>();
  if (allDoIds.size > 0) {
    const { data: doRows } = await sb.from('delivery_orders').select('id, so_doc_no').in('id', [...allDoIds]);
    for (const d of (doRows ?? []) as Row[]) {
      const idv = s(d.id); const soDoc = s(d.so_doc_no);
      if (idv && soDoc) soDocByDoId.set(idv, soDoc);
    }
  }
  const allSoDocs = new Set<string>([...soDocByDoId.values()]);
  // SO lines (for set count) + SO header (for postcode -> zone).
  const linesBySo = new Map<string, SetLine[]>();
  const zoneBySo = new Map<string, string | null>();
  if (allSoDocs.size > 0) {
    const { data: lineRows } = await paginateAll<Row>((lo, hi) =>
      scopeToAllowedCompanies(sb.from('mfg_sales_order_items').select('doc_no, item_group, cancelled'), c).in('doc_no', [...allSoDocs]).range(lo, hi),
    );
    for (const l of lineRows ?? []) {
      const doc = String(l.doc_no ?? '');
      const arr = linesBySo.get(doc) ?? [];
      arr.push({ category: SET_CATEGORIES(String(l.item_group ?? '')), qty: 1, cancelled: l.cancelled === true });
      linesBySo.set(doc, arr);
    }
    const { data: soRows } = await paginateAll<Row>((lo, hi) =>
      scopeToAllowedCompanies(sb.from('mfg_sales_orders').select('doc_no, postcode, address1, address2'), c).in('doc_no', [...allSoDocs]).range(lo, hi),
    );
    for (const so of soRows ?? []) {
      const doc = String(so.doc_no ?? '');
      const z = zoneForAddress({ postcode: s(so.postcode), address1: s(so.address1), address2: s(so.address2) }, zoneMapRules);
      zoneBySo.set(doc, z.zone);
    }
  }

  // 4) Per-trip: match card, derive facts, compute expected, flag delta.
  const codes = companyCodeMap(c);
  const rows = trips.map((t) => {
    const tripId = String(t.id);
    const lorryId = s(t.lorry_id);
    const companyId = lorryId ? lorryCompany.get(lorryId) ?? null : null;
    const card = (companyId ? cardByCompany.get(companyId) : null) ?? (lorryId ? cardByLorry.get(lorryId) : null) ?? null;
    const billedCenti = Number(t.three_pl_cost_centi ?? 0);
    const soDocs = [...new Set((doIdsByTrip.get(tripId) ?? []).map((d) => soDocByDoId.get(d)).filter((v): v is string => !!v))];
    // Aggregate the trip's sets across its drops; destination zone from the first drop.
    let setCount = 0;
    let destinationZone: string | null = null;
    for (const doc of soDocs) {
      const lines = linesBySo.get(doc) ?? [];
      setCount += deriveSetCount(lines).sets;
      if (!destinationZone) destinationZone = zoneBySo.get(doc) ?? null;
    }
    const dropCount = soDocs.length;
    let expectedCenti: number | null = null;
    let breakdown: ReturnType<typeof computeDeliveryCost> | null = null;
    if (card) {
      const spec = toCardSpec(card, rulesByCard.get(card.id) ?? []);
      breakdown = computeDeliveryCost(spec, { setCount, destinationZone });
      // WS4c: the FIXED per-trip outstation fee applies ONCE per trip (not per
      // drop), so it is added here after the per-drop cost, not inside the pure
      // per-drop calculator. Reflected as its own line for transparency.
      const tripFeeCenti = tripOutstationFeeCenti(spec.rules, destinationZone);
      if (tripFeeCenti > 0) {
        breakdown = {
          ...breakdown,
          lines: [...breakdown.lines, { ruleType: 'OUTSTATION_TRIP', label: `Outstation trip ${String(destinationZone).toUpperCase()}`, amountCenti: tripFeeCenti, detail: { zone: destinationZone, perTrip: true } }],
          totalCenti: breakdown.totalCenti + tripFeeCenti,
        };
      }
      expectedCenti = breakdown.totalCenti;
    }
    const deltaCenti = expectedCenti == null ? null : billedCenti - expectedCenti;
    const base = {
      tripId,
      tripNo: s(t.trip_no),
      tripDate: s(t.trip_date),
      lorryId,
      status: s(t.status),
      cardId: card?.id ?? null,
      cardName: card?.name ?? null,
      matched: !!card,
      dropCount,
      derivedSetCount: setCount,
      derivedZone: destinationZone,
      billedCenti,
      expectedCenti,
      deltaCenti,
      flagged: deltaCenti != null && deltaCenti !== 0,
      // Occurrence charges + sofa compartments are not derivable from trip data.
      factsComplete: false,
      breakdown,
    };
    return withCompanyCode(base as unknown as Row, codes);
  });

  return c.json({ rows });
});

// ── GET /:id — a card + its rules. ───────────────────────────────────────────
// Registered LAST: '/:id' is a single segment that would otherwise swallow the
// static '/meta' and '/reconcile' routes (repo convention, mirrors trips '/day').
deliveryRateCards.get('/:id', async (c) => {
  const id = c.req.param('id');
  const sb = c.get('supabase');
  const { data: card, error } = await scopeToCompany(rc(sb).from('delivery_rate_cards').select(CARD_COLS), c).eq('id', id).maybeSingle();
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  if (!card) return c.json(NOT_THIS_COMPANY, 404);
  const { data: rules } = await paginateAll<Row>((lo, hi) =>
    scopeToCompany(rc(sb).from('delivery_rate_rules').select(RULE_COLS), c).eq('card_id', id)
      .order('rule_type', { ascending: true }).order('sort_order', { ascending: true }).range(lo, hi),
  );
  return c.json({ card: cardOut(card as Row), rules: (rules ?? []).map(ruleOut) });
});
