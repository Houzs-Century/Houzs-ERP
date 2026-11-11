// ----------------------------------------------------------------------------
// /delivery-places — towns under the delivery zones (mig 20261111T1100; owner
// 2026-11-11: the carriers' rate cards use the same areas as the Delivery Zones
// maintenance, 做).
//
// A place is a town a rate card may price and the zone its postcodes fall in
// (NULL = in no zone, abroad). The rate card calculator reads a town only inside
// its zone (scm/lib/delivery-rate-card.ts), so a Kuala Lumpur address on Jalan
// Ipoh is not Ipoh. A zone's own name is not a place: a card price naming a zone
// covers the whole zone by postcode.
//
//   GET    /      the company's places, each with the rate cards that price it,
//                 and the towns cards price that no zone holds yet
//   POST   /      file a pasted list of towns under a zone (a town filed under
//                 another zone moves)
//   PATCH  /:id   move a place to another zone, or to none
//   DELETE /:id   remove a place no rate card prices
//
// Mounted at '/delivery-places' behind scmAreaGuard('scm.transportation.drivers'),
// the area of Delivery Zones and the rate cards.
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { paginateAll } from '../lib/paginate-all';
import { scopeToCompany, scopeToCompanyId, requireActiveCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import { ZONE_SET } from '../lib/zone-classify';
import type { PlaceSpec } from '../lib/delivery-rate-card';

export const deliveryPlaces = new Hono<{ Bindings: Env; Variables: Variables }>();
deliveryPlaces.use('*', supabaseAuth);

/* The table is not in the generated Supabase types until the migration merges;
   like rc() in delivery-rate-cards.ts, a narrow table-local bridge. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pg = (sb: unknown): any => sb;

type Row = Record<string, unknown>;
const PLACE_COLS = 'id, name, zone';
const MAX_NAME = 60;

/** A typed town as stored: upper case, single spaces. */
export const placeName = (raw: string): string => raw.toUpperCase().replace(/\s+/g, ' ').trim();

const placeOut = (r: Row) => ({ id: String(r.id), name: String(r.name ?? ''), zone: r.zone == null ? null : String(r.zone) });

/** The company's places as the calculator reads them. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadPlaces(c: any): Promise<{ ok: true; places: PlaceSpec[] } | { ok: false; reason: string }> {
  const { data, error } = await paginateAll<Row>((lo, hi) =>
    scopeToCompany(pg(c.get('supabase')).from('delivery_places').select(PLACE_COLS), c).order('name', { ascending: true }).range(lo, hi),
  );
  if (error) return { ok: false, reason: error.message };
  return { ok: true, places: (data ?? []).map(placeOut).map(({ name, zone }) => ({ name, zone })) };
}

/** A company's places, for a read with no request scope (the 3PL invoice pricing). */
export async function loadPlacesFor(sb: unknown, companyId: number): Promise<{ ok: true; places: PlaceSpec[] } | { ok: false; reason: string }> {
  const { data, error } = await paginateAll<Row>((lo, hi) =>
    scopeToCompanyId(pg(sb).from('delivery_places').select(PLACE_COLS), companyId).order('name', { ascending: true }).range(lo, hi),
  );
  if (error) return { ok: false, reason: error.message };
  return { ok: true, places: (data ?? []).map(placeOut).map(({ name, zone }) => ({ name, zone })) };
}

/** The names a rate card may not price: neither a zone nor a place. */
export function unplacedNames(names: readonly string[], places: readonly PlaceSpec[]): string[] {
  const known = new Set(places.map((p) => p.name));
  return [...new Set(names.map(placeName).filter((n) => n !== '' && !ZONE_SET.has(n) && !known.has(n)))];
}

/** Why a rate card write naming these towns is refused, or null. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function placeRefusal(c: any, names: readonly string[]) {
  if (names.length === 0) return null;
  const loaded = await loadPlaces(c);
  if (!loaded.ok) return { status: 500 as const, body: { error: 'fetch_failed', reason: loaded.reason } };
  const unknown = unplacedNames(names, loaded.places);
  if (unknown.length === 0) return null;
  const list = unknown.length > 6 ? `${unknown.slice(0, 6).join(', ')} +${unknown.length - 6}` : unknown.join(', ');
  return { status: 400 as const, body: { error: 'unknown_place', names: unknown, reason: `Not in a zone yet: ${list}. Add it under its zone on the Delivery Zones page first.` } };
}

/** Each town the company's rate cards price (area towns, town prices) → the cards' names. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function townsOnCards(c: any): Promise<{ ok: true; byTown: Map<string, string[]> } | { ok: false; reason: string }> {
  const sb = pg(c.get('supabase'));
  const cards = await paginateAll<Row>((lo, hi) => scopeToCompany(sb.from('delivery_rate_cards').select('id, name'), c).range(lo, hi));
  if (cards.error) return { ok: false, reason: cards.error.message };
  const areas = await paginateAll<Row>((lo, hi) => scopeToCompany(sb.from('delivery_rate_areas').select('card_id, towns'), c).range(lo, hi));
  if (areas.error) return { ok: false, reason: areas.error.message };
  const rules = await paginateAll<Row>((lo, hi) =>
    scopeToCompany(sb.from('delivery_rate_rules').select('card_id, zone, rule_type'), c).in('rule_type', ['OUTSTATION', 'OUTSTATION_TRIP']).range(lo, hi),
  );
  if (rules.error) return { ok: false, reason: rules.error.message };
  const cardName = new Map((cards.data ?? []).map((r) => [String(r.id), String(r.name ?? '')]));
  const byTown = new Map<string, Set<string>>();
  const add = (town: unknown, cardId: unknown) => {
    const t = placeName(String(town ?? ''));
    const card = cardName.get(String(cardId));
    if (!t || card === undefined) return;
    byTown.set(t, (byTown.get(t) ?? new Set<string>()).add(card));
  };
  for (const a of areas.data ?? []) for (const t of (Array.isArray(a.towns) ? a.towns : [])) add(t, a.card_id);
  for (const r of rules.data ?? []) add(r.zone, r.card_id);
  return { ok: true, byTown: new Map([...byTown].map(([t, set]) => [t, [...set].sort((x, y) => x.localeCompare(y))])) };
}

// ── GET / — the places, the cards pricing each, the towns no zone holds yet. ──
deliveryPlaces.get('/', async (c) => {
  const { data, error } = await paginateAll<Row>((lo, hi) =>
    scopeToCompany(pg(c.get('supabase')).from('delivery_places').select(PLACE_COLS), c).order('name', { ascending: true }).range(lo, hi),
  );
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  const towns = await townsOnCards(c);
  if (!towns.ok) return c.json({ error: 'fetch_failed', reason: towns.reason }, 500);
  const places = (data ?? []).map(placeOut).sort((a, b) => a.name.localeCompare(b.name));
  const placed = new Set(places.map((p) => p.name));
  return c.json({
    places: places.map((p) => ({ ...p, cards: towns.byTown.get(p.name) ?? [] })),
    unplaced: [...towns.byTown]
      .filter(([t]) => !ZONE_SET.has(t) && !placed.has(t))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, cards]) => ({ name, cards })),
  });
});

const zoneField = z.string().trim().min(1).max(40).nullable();
const postSchema = z.object({ zone: zoneField, names: z.array(z.string().max(200)).min(1).max(300) });
const patchSchema = z.object({ zone: zoneField });

/** The zone as stored, or the refusal when it is not one of the zones. */
function zoneOf(raw: string | null) {
  if (raw == null) return { ok: true as const, zone: null };
  const zone = raw.toUpperCase();
  if (!ZONE_SET.has(zone)) return { ok: false as const, body: { error: 'unknown_zone', reason: `zone must be one of the ${ZONE_SET.size} zones`, knownZones: [...ZONE_SET] } };
  return { ok: true as const, zone };
}

// ── POST / — file a pasted list of towns under a zone. ───────────────────────
deliveryPlaces.post('/', async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const zone = zoneOf(parsed.data.zone);
  if (!zone.ok) return c.json(zone.body, 400);
  const names = [...new Set(parsed.data.names.map(placeName).filter((n) => n !== ''))];
  if (names.length === 0) return c.json({ error: 'no_names', reason: 'Type at least one town.' }, 400);
  const zoneNames = names.filter((n) => ZONE_SET.has(n));
  if (zoneNames.length > 0) {
    return c.json({ error: 'zone_not_place', names: zoneNames, reason: 'A zone covers all its postcodes; a rate card can price the zone itself.' }, 400);
  }
  const tooLong = names.filter((n) => n.length > MAX_NAME);
  if (tooLong.length > 0) return c.json({ error: 'name_too_long', names: tooLong, reason: `A town is at most ${MAX_NAME} letters.` }, 400);
  const now = new Date().toISOString();
  const { data, error } = await pg(c.get('supabase')).from('delivery_places')
    .upsert(names.map((name) => ({ company_id: co.companyId, name, zone: zone.zone, updated_at: now })), { onConflict: 'company_id,name' })
    .select(PLACE_COLS);
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  const saved = ((data ?? []) as Row[]).map(placeOut).sort((a, b) => a.name.localeCompare(b.name));
  return c.json({ places: saved }, 201);
});

// ── PATCH /:id — move a place to another zone, or to none. ───────────────────
deliveryPlaces.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const zone = zoneOf(parsed.data.zone);
  if (!zone.ok) return c.json(zone.body, 400);
  const { data, error } = await scopeToCompanyId(
    pg(c.get('supabase')).from('delivery_places').update({ zone: zone.zone, updated_at: new Date().toISOString() }).eq('id', id), co.companyId,
  ).select(PLACE_COLS).maybeSingle();
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  if (!data) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ place: placeOut(data as Row) });
});

// ── DELETE /:id — remove a place no rate card prices. ────────────────────────
deliveryPlaces.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = pg(c.get('supabase'));
  const { data: held, error: heldErr } = await scopeToCompanyId(sb.from('delivery_places').select(PLACE_COLS).eq('id', id), co.companyId).maybeSingle();
  if (heldErr) return c.json({ error: 'fetch_failed', reason: heldErr.message }, 500);
  if (!held) return c.json(NOT_THIS_COMPANY, 404);
  const name = placeOut(held as Row).name;
  const towns = await townsOnCards(c);
  if (!towns.ok) return c.json({ error: 'fetch_failed', reason: towns.reason }, 500);
  const cards = towns.byTown.get(name) ?? [];
  if (cards.length > 0) {
    return c.json({ error: 'place_in_use', cards, reason: `${name} is priced on ${cards.join(', ')}. Take it off those rate cards first.` }, 409);
  }
  const { data: deleted, error } = await scopeToCompanyId(sb.from('delivery_places').delete().eq('id', id), co.companyId).select('id').maybeSingle();
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  if (!deleted) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ ok: true });
});
