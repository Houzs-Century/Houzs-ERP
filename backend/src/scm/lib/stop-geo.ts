
import type { Context } from 'hono';
import type { SupabaseClient as SupabaseClientGeneric } from '@supabase/supabase-js';
import { geocodeAddressCached, normalizeAddress } from './geocode';
import { chunkIn } from './paginate-all';
import { scopeToAllowedCompanies } from './companyScope';
import { assrCompanySql } from '../../routes/assr';
import { assrBoardLocation } from './assr-board-scope';
import { PROJECT_VENUE_COLS, PROJECT_VENUE_JOIN } from './project-venue-join';
import { fillDpRowsPostcode } from './postcode-from-address';
import { postcodeInLines } from '../shared/assr-case-address';
import type { Env, Variables } from '../env';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema-parameterised scm client, same alias as geocode.ts
type SupabaseClient = SupabaseClientGeneric<any, any, any>;


/** One address to try. `approximate` = only the postcode area, not the door. */
export interface GeoCandidate {
  address: string;
  approximate: boolean;
}

/** A stop's place, in the parts every job type has. */
export interface StopPlace {
  name: string | null;
  lines: Array<string | null | undefined>;
  postcode: string | null;
  city: string | null;
  state: string | null;
  useName: boolean;
}

const tidy = (v: unknown): string => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const names = (text: string, part: string) => new RegExp(`(^|[^a-z0-9])${escapeRe(part.toLowerCase())}($|[^a-z0-9])`).test(text.toLowerCase());

function withTail(head: string[], street: string[], tail: string[]): string {
  const out = [...head, ...street];
  let said = street.join(' , ');
  for (const t of tail) {
    if (t === '' || names(said, t) || t.split(' ').every((w) => names(said, w))) continue;
    out.push(t);
    said += ` , ${t}`;
  }
  return out.join(', ');
}

/**
 * The addresses to try for one stop, best first. PURE.
 *  1. street lines + "postcode city" + state + Malaysia;
 *  2. place name + street + postcode city state (venues, suppliers: Google knows
 *     "MELAKA INTERNATIONAL TRADE CENTRE" by name) — tried FIRST when the street
 *     is missing or has no number in it;
 *  3. "postcode city, state, Malaysia" — the postcode area, approximate.
 * Duplicates (same cache key) are dropped. Empty when there is nothing usable;
 * a state alone is too coarse to pin and yields nothing.
 */
export function placeCandidates(p: StopPlace): GeoCandidate[] {
  const name = tidy(p.name);
  const street = p.lines.map(tidy).filter((l) => l !== '' && l.toLowerCase() !== name.toLowerCase());
  const postcode = tidy(p.postcode);
  const city = tidy(p.city);
  const state = tidy(p.state);
  const town = [postcode, city].filter(Boolean).join(' ');
  const tail = [town, state, 'Malaysia'];

  const full = street.length > 0 ? withTail([], street, tail) : null;
  const named = p.useName && name !== '' ? withTail([name], street, tail) : null;
  const weakStreet = street.length === 0 || !/\d/.test(street.join(' '));
  const ordered = weakStreet ? [named, full] : [full, named];

  const out: GeoCandidate[] = [];
  const seen = new Set<string>();
  const add = (address: string | null, approximate: boolean) => {
    if (!address) return;
    const key = normalizeAddress(address);
    if (key === '' || seen.has(key)) return;
    seen.add(key);
    out.push({ address, approximate });
  };
  for (const a of ordered) add(a, false);
  if (town !== '') add([town, state, 'Malaysia'].filter(Boolean).join(', '), true);
  return out;
}

/** A sales order's addresses: the composed address the scheduler and the geo
 *  feed have always cached (kept byte-for-byte for cache parity), then its
 *  postcode area. PURE. */
export function soCandidates(composed: string, postcode: string | null, state: string | null, country: string | null): GeoCandidate[] {
  const out: GeoCandidate[] = [];
  if (composed.trim() !== '') out.push({ address: composed, approximate: false });
  const pc = tidy(postcode);
  if (pc !== '') {
    const sg = /singapore/i.test(tidy(country)) || /^\d{6}$/.test(pc);
    const area = sg ? `${pc}, Singapore` : [pc, tidy(state), 'Malaysia'].filter(Boolean).join(', ');
    if (normalizeAddress(area) !== normalizeAddress(composed)) out.push({ address: area, approximate: !sg });
  }
  return out;
}

const PLACE_PARTY_TYPES = new Set(['SETUP', 'DISMANTLE', 'SUPPLIER_PICKUP', 'TRANSFER', 'LORRY_SERVICE']);

/** A manual DP job (dp_orders row, postcode already filled from the text). PURE. */
export function dpPlace(d: Record<string, unknown>): StopPlace {
  return {
    name: (d.party_name as string | null) ?? null,
    lines: [d.address1, d.address2, d.address3, d.address4] as Array<string | null>,
    postcode: (d.postcode as string | null) ?? null,
    city: (d.city as string | null) ?? null,
    state: (d.state as string | null) ?? null,
    useName: PLACE_PARTY_TYPES.has(String(d.job_type ?? '').toUpperCase()),
  };
}

/** A service-case leg: the case's own lines + assr_case_address postcode / city /
 *  state, then the postcode in its lines, then the linked SO's. A customer's
 *  name is never geocoded. PURE. */
export function assrPlace(a: {
  addr1: string | null; addr2: string | null; addr3: string | null; addr4: string | null;
  case_postcode: string | null; case_city: string | null; case_state: string | null;
  so_state: string | null; so_postcode: string | null;
}): StopPlace {
  const loc = assrBoardLocation(a.addr3, a.addr4, a.so_state, a.so_postcode, { postcode: a.case_postcode, state: a.case_state });
  return {
    name: null,
    lines: [a.addr1, a.addr2, a.addr3, a.addr4],
    postcode: tidy(a.case_postcode) || postcodeInLines(a) || loc.postcode,
    city: a.case_city,
    state: loc.state,
    useName: false,
  };
}

/** A project's setup / dismantle: the venue (by name — the venue master mostly has
 *  no street) with the venue master's postcode / city / state. PURE. */
export function projectPlace(p: {
  venue: string | null; name: string | null; venue_address: string | null; state: string | null;
  venue_postcode: string | null; venue_city: string | null; venue_state: string | null;
}): StopPlace {
  return {
    name: p.venue ?? p.name,
    lines: [p.venue_address],
    postcode: p.venue_postcode,
    city: p.venue_city,
    state: p.state ?? p.venue_state,
    useName: true,
  };
}

/** A board row key -> which job it is. The keys the board mints:
 *  "<ASSR no>#<leg>", "DP:<uuid>", "PRJ:<id>#SETUP|DISMANTLE". PURE. */
export type JobRef =
  | { kind: 'assr'; assrNo: string }
  | { kind: 'dp'; id: string }
  | { kind: 'project'; id: number };

export function parseJobRef(ref: string): JobRef | null {
  const r = ref.trim();
  if (r.startsWith('DP:')) {
    const id = r.slice(3);
    return /^[0-9a-f-]{8,40}$/i.test(id) ? { kind: 'dp', id } : null;
  }
  const prj = /^PRJ:(\d+)#(SETUP|DISMANTLE)$/.exec(r);
  if (prj) return { kind: 'project', id: Number(prj[1]) };
  const assr = /^([^#]+)#(customer_pickup|inspection|delivery)$/.exec(r);
  if (assr) return { kind: 'assr', assrNo: assr[1]!.trim() };
  return null;
}


type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

export interface JobStop {
  ref: string;
  customer: string | null;
  postcode: string | null;
  state: string | null;
  candidates: GeoCandidate[];
}

/**
 * Read the place of each non-SO board row key. Company predicate on the DP and
 * ASSR reads (the service-role client bypasses RLS); projects follow the board's
 * project union, which lists the shared fleet's setup / dismantle work across
 * companies. A key that does not parse or names no row is left out.
 */
export async function loadJobStops(c: Ctx, sb: SupabaseClient, refs: string[]): Promise<{ stops: JobStop[]; error: string | null }> {
  const parsed = refs.map((ref) => ({ ref, job: parseJobRef(ref) })).filter((x): x is { ref: string; job: JobRef } => x.job != null);
  const stops: JobStop[] = [];

  const dpIds = [...new Set(parsed.flatMap((x) => (x.job.kind === 'dp' ? [x.job.id] : [])))];
  if (dpIds.length > 0) {
    const { data, error } = await chunkIn<Record<string, unknown>>(dpIds, (batch, lo, hi) => scopeToAllowedCompanies(
      sb.from('dp_orders').select('id, job_type, party_name, address1, address2, address3, address4, city, postcode, state').in('id', batch).order('id'), c,
    ).range(lo, hi));
    if (error) return { stops: [], error: error.message };
    await fillDpRowsPostcode(sb, data);
    const byId = new Map(data.map((d) => [String(d.id), d]));
    for (const x of parsed) {
      if (x.job.kind !== 'dp') continue;
      const d = byId.get(x.job.id);
      if (!d) continue;
      const place = dpPlace(d);
      stops.push({ ref: x.ref, customer: place.name, postcode: place.postcode, state: place.state, candidates: placeCandidates(place) });
    }
  }

  const assrNos = [...new Set(parsed.flatMap((x) => (x.job.kind === 'assr' ? [x.job.assrNo] : [])))];
  if (assrNos.length > 0) {
    const res = await c.env.DB.prepare(
      `SELECT assr_cases.assr_no AS assr_no, assr_cases.customer_name AS customer_name,
              assr_cases.addr1 AS addr1, assr_cases.addr2 AS addr2, assr_cases.addr3 AS addr3, assr_cases.addr4 AS addr4,
              ca.postcode AS case_postcode, ca.city AS case_city, ca.state AS case_state,
              so.customer_state AS so_state, so.postcode AS so_postcode
         FROM assr_cases
         LEFT JOIN assr_case_address ca ON ca.assr_id = assr_cases.id
         LEFT JOIN LATERAL (
              SELECT o.customer_state, o.postcode FROM scm.mfg_sales_orders o
               WHERE o.doc_no = assr_cases.doc_no OR o.linked_ac_docno = assr_cases.doc_no
               ORDER BY (o.doc_no = assr_cases.doc_no) DESC LIMIT 1) so ON TRUE
        WHERE assr_cases.assr_no IN (${assrNos.map(() => '?').join(', ')})${assrCompanySql(c, 'assr_cases.company_id')}`,
    ).bind(...assrNos).all<{
      assr_no: string; customer_name: string | null;
      addr1: string | null; addr2: string | null; addr3: string | null; addr4: string | null;
      case_postcode: string | null; case_city: string | null; case_state: string | null;
      so_state: string | null; so_postcode: string | null;
    }>();
    const byNo = new Map(res.results.map((a) => [String(a.assr_no), a]));
    for (const x of parsed) {
      if (x.job.kind !== 'assr') continue;
      const a = byNo.get(x.job.assrNo);
      if (!a) continue;
      const place = assrPlace(a);
      stops.push({ ref: x.ref, customer: a.customer_name, postcode: place.postcode, state: place.state, candidates: placeCandidates(place) });
    }
  }

  const projectIds = [...new Set(parsed.flatMap((x) => (x.job.kind === 'project' ? [x.job.id] : [])))];
  if (projectIds.length > 0) {
    const res = await c.env.DB.prepare(
      `SELECT p.id AS id, p.name AS name, p.venue AS venue, p.venue_address AS venue_address, p.state AS state, ${PROJECT_VENUE_COLS}
         FROM projects p ${PROJECT_VENUE_JOIN}
        WHERE p.id IN (${projectIds.map(() => '?').join(', ')})`,
    ).bind(...projectIds).all<{
      id: number; name: string | null; venue: string | null; venue_address: string | null; state: string | null;
      venue_postcode: string | null; venue_city: string | null; venue_state: string | null;
    }>();
    const byId = new Map(res.results.map((p) => [Number(p.id), p]));
    for (const x of parsed) {
      if (x.job.kind !== 'project') continue;
      const p = byId.get(x.job.id);
      if (!p) continue;
      const place = projectPlace(p);
      stops.push({ ref: x.ref, customer: place.name, postcode: place.postcode, state: place.state, candidates: placeCandidates(place) });
    }
  }
  return { stops, error: null };
}

export type Located =
  | { ok: true; lat: number; lng: number; approximate: boolean; address: string }
  | { ok: false; reason: string };

/**
 * Locate each stop at its first candidate that resolves. ONE batched cache read
 * over every candidate first; Google only for a candidate the cache has never
 * seen (geocodeAddressCached caches the hit, and remembers a miss per isolate),
 * each distinct address at most once per request. With no key, only cached
 * addresses resolve.
 */
export async function locateStops(
  sb: SupabaseClient,
  env: { GOOGLE_MAPS_API_KEY?: string },
  candidatesByRef: ReadonlyMap<string, GeoCandidate[]>,
): Promise<Map<string, Located>> {
  const configured = !!env.GOOGLE_MAPS_API_KEY;
  const cached = new Map<string, { lat: number; lng: number }>();
  const keys = [...new Set([...candidatesByRef.values()].flat().map((g) => normalizeAddress(g.address)).filter((k) => k !== ''))];
  for (let i = 0; i < keys.length; i += 200) {
    const { data, error } = await sb.from('geocode_cache').select('normalized_address, lat, lng').in('normalized_address', keys.slice(i, i + 200));
    if (error) { console.warn(`[stop-geo] geocode cache read failed: ${error.message.slice(0, 120)}`); continue; }
    for (const h of (data as Array<Record<string, unknown>>)) {
      const key = String(h.normalizedAddress ?? h.normalized_address ?? '');
      const lat = Number(h.lat);
      const lng = Number(h.lng);
      if (key && Number.isFinite(lat) && Number.isFinite(lng)) cached.set(key, { lat, lng });
    }
  }

  const resolved = new Map<string, { lat: number; lng: number } | null>();
  const out = new Map<string, Located>();
  for (const [ref, candidates] of candidatesByRef) {
    let found: Located | null = null;
    for (const g of candidates) {
      const key = normalizeAddress(g.address);
      let hit = cached.get(key) ?? null;
      if (!hit && configured) {
        if (!resolved.has(key)) {
          const r = await geocodeAddressCached(sb, env, g.address);
          resolved.set(key, r ? { lat: r.lat, lng: r.lng } : null);
        }
        hit = resolved.get(key) ?? null;
      }
      if (hit) { found = { ok: true, lat: hit.lat, lng: hit.lng, approximate: g.approximate, address: g.address }; break; }
    }
    out.set(ref, found ?? { ok: false, reason: unlocatedReason(candidates, configured) });
  }
  return out;
}

/** Why a stop has no pin. PURE. */
export function unlocatedReason(candidates: readonly GeoCandidate[], configured: boolean): string {
  if (candidates.length === 0) return 'no address, postcode or city on file';
  if (!configured) return 'not in the geocode cache and GOOGLE_MAPS_API_KEY is not set';
  return candidates.some((g) => g.approximate)
    ? 'neither the address nor its postcode could be located — check both'
    : 'address could not be located and there is no postcode — add the postcode';
}
