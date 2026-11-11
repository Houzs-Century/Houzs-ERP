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
//      carry a captured billed cost (scm.trips.three_pl_cost_sen, set in A3),
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
  AGGREGATION_UNITS,
  type AggregationUnit,
  type RateCardSpec,
  type RateRuleSpec,
  type RateRuleType,
  type DeliveryFacts,
} from '../lib/delivery-rate-card';
import { RATE_RULE_TYPES } from '../lib/rate-rule-taxonomy';
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

/* The ONE list (rate-rule-taxonomy.ts, which audit:job-types holds to the
   rule_type CHECK). A local copy here lacked SUPPLIER_PICKUP after mig 0243
   added it, so the editor offered a rule this route refused with 400. */
const RULE_TYPES: readonly RateRuleType[] = RATE_RULE_TYPES;
const RULE_TYPE_SET = new Set<string>(RULE_TYPES);

const CARD_COLS =
  'id, name, carrier_lorry_id, carrier_company_id, carrier_label, is_own_fleet, basis, aggregation, ' +
  'min_charge_sen, cap_sen, rounding, is_active, notes, created_at, updated_at';
const RULE_COLS =
  'id, card_id, rule_type, tier_position, bracket_min, bracket_max, zone, area_id, amount_sen, params, sort_order';
/* A card's priced areas (mig 20261111T1000; owner 2026-11-11 on the 3PL quotations). */
const AREA_COLS = 'id, card_id, name, towns, sort_order';
/* Town surcharges stay the card's own: an area prices the ladder and the charges. */
const CARD_ONLY_TYPES: ReadonlySet<string> = new Set(['OUTSTATION', 'OUTSTATION_TRIP']);

type Row = Record<string, unknown>;
const s = (v: unknown): string | null => (v == null ? null : String(v));
const n = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

export function cardOut(r: Row) {
  return {
    id: String(r.id),
    name: String(r.name ?? ''),
    carrierLorryId: s(r.carrier_lorry_id),
    carrierCompanyId: s(r.carrier_company_id),
    carrierLabel: s(r.carrier_label),
    isOwnFleet: r.is_own_fleet === true,
    basis: (String(r.basis ?? 'SET') === 'ITEM' ? 'ITEM' : 'SET') as 'ITEM' | 'SET',
    /* Anything unrecognised reads as UNIT — the computation that has always
       run — so a value a later migration adds prices the way it did rather
       than silently becoming free. Never collapse to DROP: that would now
       change the count, not just the label. */
    aggregation: (AGGREGATION_UNITS.has(String(r.aggregation ?? '')) ? String(r.aggregation) : 'UNIT') as AggregationUnit,
    minChargeSen: n(r.min_charge_sen),
    capSen: n(r.cap_sen),
    rounding: String(r.rounding ?? 'NONE'),
    isActive: r.is_active !== false,
    notes: s(r.notes),
    createdAt: s(r.created_at),
    updatedAt: s(r.updated_at),
  };
}

export function ruleOut(r: Row) {
  return {
    id: String(r.id),
    cardId: String(r.card_id),
    ruleType: String(r.rule_type) as RateRuleType,
    tierPosition: n(r.tier_position),
    bracketMin: n(r.bracket_min),
    bracketMax: n(r.bracket_max),
    zone: s(r.zone),
    areaId: s(r.area_id),
    amountSen: Number(r.amount_sen ?? 0),
    params: (r.params ?? null) as Record<string, unknown> | null,
    sortOrder: Number(r.sort_order ?? 0),
  };
}

export function areaOut(r: Row) {
  return {
    id: String(r.id),
    cardId: String(r.card_id),
    name: String(r.name ?? ''),
    towns: Array.isArray(r.towns) ? (r.towns as unknown[]).map(String) : [],
    sortOrder: Number(r.sort_order ?? 0),
  };
}

/** A typed town list as stored: upper case, single spaces, no blanks, no repeats. */
export const townsOf = (towns: readonly string[]): string[] =>
  [...new Set(towns.map((t) => t.toUpperCase().replace(/\s+/g, ' ').trim()).filter((t) => t !== ''))];

/** A card's stored rules -> the pure calculator's RateRuleSpec[]. */
function toRuleSpecs(rules: ReturnType<typeof ruleOut>[]): RateRuleSpec[] {
  return rules.map((r) => ({
    ruleType: r.ruleType,
    tierPosition: r.tierPosition,
    bracketMin: r.bracketMin,
    bracketMax: r.bracketMax,
    zone: r.zone,
    areaId: r.areaId,
    amountSen: r.amountSen,
  }));
}

export function toCardSpec(
  card: ReturnType<typeof cardOut>, rules: ReturnType<typeof ruleOut>[], areas: ReturnType<typeof areaOut>[] = [],
): RateCardSpec {
  return {
    basis: card.basis,
    aggregation: card.aggregation,
    minChargeSen: card.minChargeSen,
    capSen: card.capSen,
    rounding: card.rounding as RateCardSpec['rounding'],
    rules: toRuleSpecs(rules),
    areas: areas.filter((a) => a.cardId === card.id).map((a) => ({ id: a.id, name: a.name, towns: a.towns })),
  };
}

/** The areas of these cards, scoped to the request's company. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadAreas(c: any, cardIds: string[]): Promise<{ ok: true; areas: ReturnType<typeof areaOut>[] } | { ok: false; reason: string }> {
  if (cardIds.length === 0) return { ok: true, areas: [] };
  const { data, error } = await paginateAll<Row>((lo, hi) =>
    scopeToCompany(rc(c.get('supabase')).from('delivery_rate_areas').select(AREA_COLS), c).in('card_id', cardIds)
      .order('sort_order', { ascending: true }).order('name', { ascending: true }).range(lo, hi),
  );
  if (error) return { ok: false, reason: error.message };
  return { ok: true, areas: (data ?? []).map(areaOut) };
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

/* Owner, 2026-08-01: a carrier's card IS that company's price list, so the New
   Rate Card form no longer asks for a name — it asks which 3PL. The name is then
   the company name, resolved server-side so the two can never disagree. A card
   with no carrier company (own-fleet / cost-structure) still needs one typed. */
const cardCreateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  carrierLorryId: z.string().uuid().nullable().optional(),
  carrierCompanyId: z.string().uuid().nullable().optional(),
  carrierLabel: z.string().trim().max(120).nullable().optional(),
  /* NO isOwnFleet. It is DERIVED from carrierCompanyId — see below. A card that
     names a carrier is that carrier's price list; a card that names none is our
     own cost structure. Accepting the two independently let them contradict. */
  basis: z.enum(['ITEM', 'SET']).optional(),
  aggregation: z.enum(['UNIT', 'DROP', 'CUSTOMER', 'TRIP']).optional(),
  minChargeSen: z.number().int().min(0).nullable().optional(),
  capSen: z.number().int().min(0).nullable().optional(),
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

  let cardName = p.name ?? null;
  if (p.carrierCompanyId) {
    const { data: carrier } = await scopeToCompanyId(
      sb.from('threepl_companies').select('id, name'), co.companyId,
    ).eq('id', p.carrierCompanyId).maybeSingle();
    if (!carrier) return c.json({ error: 'carrier_not_found', reason: 'That 3PL company does not exist for this company.' }, 404);
    cardName = String((carrier as Record<string, unknown>).name ?? '') || cardName;
  }
  if (!cardName) return c.json({ error: 'name_required', reason: 'Pick a 3PL company, or give the card a name.' }, 400);

  const { data, error } = await rc(sb).from('delivery_rate_cards').insert({
    company_id: co.companyId,
    name: cardName,
    carrier_lorry_id: p.carrierLorryId ?? null,
    carrier_company_id: p.carrierCompanyId ?? null,
    carrier_label: p.carrierLabel ?? null,
    is_own_fleet: (p.carrierCompanyId ?? null) === null,
    basis: p.basis ?? 'SET',
    aggregation: p.aggregation ?? 'UNIT',
    min_charge_sen: p.minChargeSen ?? null,
    cap_sen: p.capSen ?? null,
    rounding: p.rounding ?? 'NONE',
    is_active: p.isActive ?? true,
    notes: p.notes ?? null,
    created_by: user?.id ?? null,
    updated_by: user?.id ?? null,
  }).select(CARD_COLS).single();
  if (error) {
    if (error.code === '23505') {
      const dupCarrier = /carrier_company/i.test(error.message ?? '');
      return c.json(dupCarrier
        ? { error: 'duplicate_carrier', reason: 'That 3PL company already has a rate card. Open it to edit the rates.' }
        : { error: 'duplicate_name', reason: 'A card with that name already exists.' }, 409);
    }
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
  const sb = c.get('supabase');
  if (p.carrierCompanyId !== undefined) {
    /* Moving a card to a carrier (a card whose company was deleted is
       reassigned this way): the carrier must be this company's, and the card
       takes its name, as on create. */
    if (p.carrierCompanyId) {
      const { data: carrier, error: cErr } = await scopeToCompanyId(
        sb.from('threepl_companies').select('id, name'), co.companyId,
      ).eq('id', p.carrierCompanyId).maybeSingle();
      if (cErr) return c.json({ error: 'fetch_failed', reason: cErr.message }, 500);
      if (!carrier) return c.json({ error: 'carrier_not_found', reason: 'That 3PL company does not exist for this company.' }, 404);
      if (p.name === undefined) updates.name = String((carrier as Record<string, unknown>).name ?? '');
    }
    updates.carrier_company_id = p.carrierCompanyId;
    // Moved together, always. Writing the carrier without the flag is what let a
    // card read "MSJ TRANSPORT" and "Own-fleet card" at the same time.
    updates.is_own_fleet = p.carrierCompanyId === null;
  }
  if (p.carrierLabel !== undefined) updates.carrier_label = p.carrierLabel;
  if (p.basis !== undefined) updates.basis = p.basis;
  if (p.aggregation !== undefined) updates.aggregation = p.aggregation;
  if (p.minChargeSen !== undefined) updates.min_charge_sen = p.minChargeSen;
  if (p.capSen !== undefined) updates.cap_sen = p.capSen;
  if (p.rounding !== undefined) updates.rounding = p.rounding;
  if (p.isActive !== undefined) updates.is_active = p.isActive;
  if (p.notes !== undefined) updates.notes = p.notes;
  if (Object.keys(updates).length === 0) return c.json({ error: 'no_changes' }, 400);
  const user = c.get('user') as { id?: string } | null;
  updates.updated_by = user?.id ?? null;
  updates.updated_at = new Date().toISOString();
  const { data, error } = await scopeToCompanyId(rc(sb).from('delivery_rate_cards').update(updates).eq('id', id), co.companyId).select(CARD_COLS).maybeSingle();
  if (error) {
    if (error.code === '23505') {
      return c.json(/carrier_company/i.test(error.message ?? '')
        ? { error: 'duplicate_carrier', reason: 'That 3PL company already has a rate card.' }
        : { error: 'duplicate_name', reason: 'A card with that name already exists.' }, 409);
    }
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
  /* The area this rule prices in; null = the card's own rule. */
  areaId: z.string().trim().min(1).max(64).nullable().optional(),
  amountSen: z.number().int().min(0),
  params: z.record(z.string(), z.unknown()).nullable().optional(),
  sortOrder: z.number().int().optional(),
});

async function loadCardForWrite(c: any, id: string, companyId: number) {
  const sb = c.get('supabase');
  const { data } = await scopeToCompanyId(rc(sb).from('delivery_rate_cards').select('id').eq('id', id), companyId).maybeSingle();
  return !!data;
}

/** Why a rule cannot name this area, or null: the area must be this card's,
    and a town surcharge stays the card's own. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function areaRefusal(c: any, cardId: string, companyId: number, areaId: string | null | undefined, ruleType: string | null) {
  if (!areaId) return null;
  if (ruleType && CARD_ONLY_TYPES.has(ruleType)) {
    return { status: 400 as const, body: { error: 'area_not_for_surcharge', reason: 'A town surcharge belongs to the whole card. An area prices its own sets, sofas and charges.' } };
  }
  const { data, error } = await scopeToCompanyId(
    rc(c.get('supabase')).from('delivery_rate_areas').select('id').eq('id', areaId).eq('card_id', cardId), companyId,
  ).maybeSingle();
  if (error) return { status: 500 as const, body: { error: 'fetch_failed', reason: error.message } };
  if (!data) return { status: 404 as const, body: { error: 'area_not_found', reason: 'That area is not on this card.' } };
  return null;
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
  if (!(await loadCardForWrite(c, id, co.companyId))) return c.json(NOT_THIS_COMPANY, 404);
  const noArea = await areaRefusal(c, id, co.companyId, p.areaId, p.ruleType);
  if (noArea) return c.json(noArea.body, noArea.status);
  const sb = c.get('supabase');
  const { data, error } = await rc(sb).from('delivery_rate_rules').insert({
    company_id: co.companyId,
    card_id: id,
    rule_type: p.ruleType,
    tier_position: p.tierPosition ?? null,
    bracket_min: p.bracketMin ?? null,
    bracket_max: p.bracketMax ?? null,
    zone: (p.ruleType === 'OUTSTATION' || p.ruleType === 'OUTSTATION_TRIP') && p.zone ? p.zone.toUpperCase() : (p.zone ?? null),
    area_id: p.areaId ?? null,
    amount_sen: p.amountSen,
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
  if (p.areaId !== undefined) {
    /* The rule's type decides whether an area may hold it: the new type when it changes, else the stored one. */
    let ruleType: string | null = p.ruleType ?? null;
    if (!ruleType && p.areaId) {
      const { data: held, error: heldErr } = await scopeToCompanyId(
        rc(c.get('supabase')).from('delivery_rate_rules').select('rule_type').eq('id', ruleId).eq('card_id', id), co.companyId,
      ).maybeSingle();
      if (heldErr) return c.json({ error: 'read_failed', reason: heldErr.message }, 500);
      ruleType = held ? String((held as Row).rule_type) : null;
    }
    const noArea = await areaRefusal(c, id, co.companyId, p.areaId, ruleType);
    if (noArea) return c.json(noArea.body, noArea.status);
    updates.area_id = p.areaId;
  } else if (p.ruleType !== undefined && CARD_ONLY_TYPES.has(p.ruleType)) {
    /* Turning an area's rule into a town surcharge would leave a surcharge inside an area. */
    const { data: held, error: heldErr } = await scopeToCompanyId(
      rc(c.get('supabase')).from('delivery_rate_rules').select('area_id').eq('id', ruleId).eq('card_id', id), co.companyId,
    ).maybeSingle();
    if (heldErr) return c.json({ error: 'read_failed', reason: heldErr.message }, 500);
    if (held && (held as Row).area_id != null) {
      return c.json({ error: 'area_not_for_surcharge', reason: 'A town surcharge belongs to the whole card. Move the rule off its area first.' }, 400);
    }
  }
  if (p.amountSen !== undefined) updates.amount_sen = p.amountSen;
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

// ── Areas (mig 20261111T1000) ────────────────────────────────────────────────
// A card's priced areas: a name and its towns. Rules name an area to price
// deliveries there (see the rule routes above and scm/lib/delivery-rate-card.ts).
const areaSchema = z.object({
  name: z.string().trim().min(1).max(80),
  towns: z.array(z.string().trim().max(40)).max(80),
  sortOrder: z.number().int().optional(),
});
const areaPatchSchema = areaSchema.partial();

const areaWriteFailed = (error: { code?: string; message?: string }) => (error.code === '23505'
  ? { status: 409 as const, body: { error: 'duplicate_area', reason: 'This card already has an area with that name.' } }
  : { status: 500 as const, body: { error: 'save_failed', reason: error.message ?? 'unknown' } });

// POST /:id/areas — add an area to a card.
deliveryRateCards.post('/:id/areas', async (c) => {
  const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = areaSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  if (!(await loadCardForWrite(c, id, co.companyId))) return c.json(NOT_THIS_COMPANY, 404);
  const { data, error } = await rc(c.get('supabase')).from('delivery_rate_areas').insert({
    company_id: co.companyId,
    card_id: id,
    name: parsed.data.name,
    towns: townsOf(parsed.data.towns),
    sort_order: parsed.data.sortOrder ?? 0,
  }).select(AREA_COLS).single();
  if (error) { const f = areaWriteFailed(error); return c.json(f.body, f.status); }
  return c.json({ area: areaOut(data as Row) }, 201);
});

// PATCH /areas/:areaId — rename an area, change its towns or its place.
deliveryRateCards.patch('/areas/:areaId', async (c) => {
  const areaId = c.req.param('areaId');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = areaPatchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const p = parsed.data;
  const updates: Record<string, unknown> = {};
  if (p.name !== undefined) updates.name = p.name;
  if (p.towns !== undefined) updates.towns = townsOf(p.towns);
  if (p.sortOrder !== undefined) updates.sort_order = p.sortOrder;
  if (Object.keys(updates).length === 0) return c.json({ error: 'no_changes' }, 400);
  updates.updated_at = new Date().toISOString();
  const { data, error } = await scopeToCompanyId(
    rc(c.get('supabase')).from('delivery_rate_areas').update(updates).eq('id', areaId), co.companyId,
  ).select(AREA_COLS).maybeSingle();
  if (error) { const f = areaWriteFailed(error); return c.json(f.body, f.status); }
  if (!data) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ area: areaOut(data as Row) });
});

// DELETE /areas/:areaId — remove an area and the prices it carried.
deliveryRateCards.delete('/areas/:areaId', async (c) => {
  const areaId = c.req.param('areaId');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  /* Its rules go with it — the foreign key cascades; deleting them first says so
     here too, and leaves nothing behind should the area be gone already. */
  const { error: rErr } = await scopeToCompanyId(rc(sb).from('delivery_rate_rules').delete().eq('area_id', areaId), co.companyId);
  if (rErr) return c.json({ error: 'delete_failed', reason: rErr.message }, 500);
  const { data: deleted, error } = await scopeToCompanyId(
    rc(sb).from('delivery_rate_areas').delete().eq('id', areaId), co.companyId,
  ).select('id').maybeSingle();
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  if (!deleted) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ ok: true });
});

// ── POST /:id/compute — run the pure calculator against a card for given facts.
const factsSchema = z.object({
  setCount: z.number().int().min(0).nullable().optional(),
  itemCount: z.number().int().min(0).nullable().optional(),
  sofaCompartments: z.array(z.number().int().min(0)).nullable().optional(),
  destinationZone: z.string().trim().max(40).nullable().optional(),
  /* The Price check names the area to price in. */
  areaId: z.string().trim().min(1).max(64).nullable().optional(),
  disposeCount: z.number().int().min(0).nullable().optional(),
  setupCount: z.number().int().min(0).nullable().optional(),
  dismantleCount: z.number().int().min(0).nullable().optional(),
  serviceCount: z.number().int().min(0).nullable().optional(),
  pickupCount: z.number().int().min(0).nullable().optional(),
  inspectionCount: z.number().int().min(0).nullable().optional(),
  supplierPickupCount: z.number().int().min(0).nullable().optional(),
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
  const areas = await loadAreas(c, [id]);
  if (!areas.ok) return c.json({ error: 'fetch_failed', reason: areas.reason }, 500);
  const cardO = cardOut(card as Row);
  const spec = toCardSpec(cardO, (rules ?? []).map(ruleOut), areas.areas);
  /* perTrip: the calculator on the Rate Cards page could NEVER show an
     OUTSTATION_TRIP line — the rules editor let you create one and this
     endpoint never applied it, so the figure on screen silently disagreed
     with what the reconciliation would bill. It prices a trip, like the
     reconcile does. */
  const breakdown = computeDeliveryCost(spec, parsed.data as DeliveryFacts, { perTrip: true });
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
      .select('company_id, id, trip_no, trip_date, lorry_id, warehouse_id, is_outsourced, three_pl_cost_sen, status')
      .eq('is_outsourced', true).not('three_pl_cost_sen', 'is', null)
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
  const cardAreas = await loadAreas(c, cards.map((x) => x.id));
  if (!cardAreas.ok) return c.json({ error: 'load_failed', reason: cardAreas.reason }, 500);

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
  const customerKeyBySo = new Map<string, string>();
  const addressBySo = new Map<string, string>();
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
      scopeToAllowedCompanies(sb.from('mfg_sales_orders').select('doc_no, postcode, address1, address2, address3, address4, city, debtor_code, debtor_name'), c).in('doc_no', [...allSoDocs]).range(lo, hi),
    );
    for (const so of soRows ?? []) {
      const doc = String(so.doc_no ?? '');
      const z = zoneForAddress({ postcode: s(so.postcode), address1: s(so.address1), address2: s(so.address2) }, zoneMapRules);
      zoneBySo.set(doc, z.zone);
      /* The "customer" a per-customer card charges once for: the SAME buyer at
         the SAME doorstep. Keyed on debtor + normalised address rather than
         debtor alone, because one buyer with two delivery addresses is two
         stops and two charges — owner: "一样的顾客、一样的地址". */
      const who = s(so.debtor_code) || s(so.debtor_name) || doc;
      const where = [s(so.address1), s(so.address2), s(so.postcode)]
        .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().toUpperCase();
      customerKeyBySo.set(doc, `${who}@@${where}`);
      /* The words a town surcharge or an area is found by: the whole address and its city. */
      addressBySo.set(doc, [s(so.address1), s(so.address2), s(so.address3), s(so.address4), s(so.city), s(so.postcode)]
        .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().toUpperCase());
    }
  }

  // 4) Per-trip: match card, derive facts, compute expected, flag delta.
  const codes = companyCodeMap(c);
  const rows = trips.map((t) => {
    const tripId = String(t.id);
    const lorryId = s(t.lorry_id);
    const companyId = lorryId ? lorryCompany.get(lorryId) ?? null : null;
    const card = (companyId ? cardByCompany.get(companyId) : null) ?? (lorryId ? cardByLorry.get(lorryId) : null) ?? null;
    const billedSen = Number(t.three_pl_cost_sen ?? 0);
    const soDocs = [...new Set((doIdsByTrip.get(tripId) ?? []).map((d) => soDocByDoId.get(d)).filter((v): v is string => !!v))];
    /* Aggregate the trip's sets across its drops, and collect EVERY zone it
       touches. It used to take whichever zone came first out of the query —
       not the first stop on the route, just the first row — so a
       Melaka->Johor trip could be charged Melaka's rate, and a re-run could
       answer differently. The calculator now picks the farthest of them
       (farthestZone), once, per the owner's rule. */
    let setCount = 0;
    const zones: string[] = [];
    for (const doc of soDocs) {
      const lines = linesBySo.get(doc) ?? [];
      setCount += deriveSetCount(lines).sets;
      const z = zoneBySo.get(doc) ?? null;
      if (z && !zones.includes(z)) zones.push(z);
    }
    const destinationZone: string | null = zones[0] ?? null;
    /* Distinct doorsteps on this trip — what a per-CUSTOMER card charges once
       for. Two drops to the same buyer at the same address collapse to one. */
    const customerCount = new Set(soDocs.map((d) => customerKeyBySo.get(d) ?? d)).size;
    const dropCount = soDocs.length;
    let expectedSen: number | null = null;
    let breakdown: ReturnType<typeof computeDeliveryCost> | null = null;
    if (card) {
      const spec = toCardSpec(card, rulesByCard.get(card.id) ?? [], cardAreas.areas);
      /* perTrip: the FIXED per-trip outstation fee is now emitted INSIDE the
         calculator, before the min/cap/rounding envelope. It used to be added
         here afterwards, which let a capped card bill above its own cap. */
      breakdown = computeDeliveryCost(spec, { setCount, dropCount, customerCount, destinationZone, destinationZones: zones, addressText: soDocs.map((d) => addressBySo.get(d) ?? '').join(' | ') }, { perTrip: true });
      expectedSen = breakdown.totalSen;
    }
    const deltaSen = expectedSen == null ? null : billedSen - expectedSen;
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
      billedSen,
      expectedSen,
      deltaSen,
      flagged: deltaSen != null && deltaSen !== 0,
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
  const areas = await loadAreas(c, [id]);
  if (!areas.ok) return c.json({ error: 'fetch_failed', reason: areas.reason }, 500);
  return c.json({ card: cardOut(card as Row), rules: (rules ?? []).map(ruleOut), areas: areas.areas });
});
