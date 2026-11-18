// ---------------------------------------------------------------------------
// geocode.ts — address -> lat/lng, CACHED (scm.geocode_cache, migration 0197).
//
// The TMS Phase 3 scheduler geocodes each delivery stop's free-text address so
// the Distance Matrix can measure travel time between stops. Geocoding is a PAID
// Google call, and the same address is scheduled repeatedly, so every address is
// geocoded exactly ONCE and then served from the cache table forever.
//
// GATED behind GOOGLE_MAPS_API_KEY, the SAME backend key maps.ts uses. With no
// key a geocode returns null and NEVER calls Google — nothing bills until the
// owner sets the key. Reuses the geocoder URL/key pattern already established in
// scan-so.ts (region=my, components=country:MY); this file adds the lat/lng +
// caching layer scan-so did not need (it only wanted state/city/postcode).
//
// The URL builder and the response parser are PURE and unit-tested; only the
// thin fetch + cache wrapper touches the network / DB.
// ---------------------------------------------------------------------------

import type { SupabaseClient as SupabaseClientGeneric } from '@supabase/supabase-js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = SupabaseClientGeneric<any, any, any>;

const GEOCODE_BASE = 'https://maps.googleapis.com/maps/api/geocode/json';

export interface LatLng {
  lat: number;
  lng: number;
}

export interface GeocodeHit extends LatLng {
  formattedAddress: string | null;
  locationType: string | null;
}

/**
 * Normalise an address into the cache key. PURE. Lower-case, strip punctuation to
 * a single space, collapse repeated whitespace, trim — so "12, Jalan A/1." and
 * "12 Jalan A 1" resolve to the same cached point. Returns '' for empty input,
 * which the caller treats as "nothing to geocode".
 */
export function normalizeAddress(raw: string | null | undefined): string {
  return (raw ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Compose the geocodable address string from an SO's address parts. PURE.
 * Joins the non-empty parts with ", ", so a missing line does not leave a stray
 * comma. Postcode + state anchor the result to the right locality for Google.
 */
export function composeAddress(parts: {
  address1?: string | null;
  address2?: string | null;
  postcode?: string | null;
  state?: string | null;
  country?: string | null;
}): string {
  return [parts.address1, parts.address2, parts.postcode, parts.state, parts.country]
    .map((p) => (p ?? '').trim())
    .filter((p) => p !== '')
    .join(', ');
}

/** The country an address is in, for the geocoder's country filter: Singapore
 *  when the address names it, else Malaysia. Pinning every address to MY made a
 *  Singapore delivery unfindable (HC-SO-011153, Woodlands, 2026-11-18). PURE. */
export function geocodeCountryOf(address: string): 'MY' | 'SG' {
  return /(^|[^a-z])singapore($|[^a-z])/i.test(address) ? 'SG' : 'MY';
}

/** Build the Geocoding API URL. PURE. Biased to the address's country (MY / SG). */
export function buildGeocodeUrl(address: string, apiKey: string): string {
  const cc = geocodeCountryOf(address);
  return `${GEOCODE_BASE}?address=${encodeURIComponent(address)}&region=${cc.toLowerCase()}&components=country:${cc}&key=${apiKey}`;
}

interface GeocodeBody {
  status?: string;
  results?: Array<{
    formatted_address?: string;
    types?: string[];
    geometry?: {
      location?: { lat?: number; lng?: number };
      location_type?: string;
    };
  }>;
}

/** A result that is only the whole country or a whole state: Google's answer
 *  to an address it could not place. Pinning it would put the stop in the
 *  middle of Malaysia / the state, which is worse than listing it unlocated. */
const TOO_COARSE = new Set(['country', 'administrative_area_level_1']);

/**
 * Parse a Geocoding response into a lat/lng hit. PURE. Returns null unless the
 * status is OK and a finite lat/lng came back (a 0,0 with no location is treated
 * as no hit — Malaysia is never at the null island), and null for a country- or
 * state-only result.
 */
export function parseGeocode(body: GeocodeBody): GeocodeHit | null {
  if (body.status !== 'OK' || !body.results?.length) return null;
  const top = body.results[0];
  if ((top.types ?? []).some((t) => TOO_COARSE.has(t))) return null;
  const loc = top.geometry?.location;
  const lat = Number(loc?.lat);
  const lng = Number(loc?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return null;
  return {
    lat,
    lng,
    formattedAddress: top.formatted_address ?? null,
    locationType: top.geometry?.location_type ?? null,
  };
}

/* Addresses Google could not place, remembered per Worker isolate so the same
   bad address is not re-billed on every page open. scm.geocode_cache keeps hits
   only (lat/lng are NOT NULL), so a miss has no table row; six hours lets an
   address fixed in the meantime be retried the same day. Bounded so a long-lived
   isolate cannot grow it without limit. */
const MISS_TTL_MS = 6 * 60 * 60 * 1000;
const MISS_MAX = 5000;
const recentMisses = new Map<string, number>();

export function rememberMiss(key: string, now: number): void {
  if (recentMisses.size >= MISS_MAX) {
    const oldest = recentMisses.keys().next().value;
    if (oldest !== undefined) recentMisses.delete(oldest);
  }
  recentMisses.set(key, now + MISS_TTL_MS);
}

export function missedRecently(key: string, now: number): boolean {
  const until = recentMisses.get(key);
  if (until === undefined) return false;
  if (until > now) return true;
  recentMisses.delete(key);
  return false;
}

/** Test seam: forget every remembered miss. */
export function clearRememberedMisses(): void {
  recentMisses.clear();
}

/**
 * Geocode ONE address, cache-first. Returns null when there is nothing to
 * geocode, no API key, or Google could not resolve it — the caller degrades
 * gracefully (that stop drops out of the route with a reason).
 *
 * Reads scm.geocode_cache by the normalized key; on a miss it calls Google once,
 * writes the row (best-effort — a cache write failure never fails the geocode),
 * and returns the point. Never throws.
 */
export async function geocodeAddressCached(
  sb: SupabaseClient,
  env: { GOOGLE_MAPS_API_KEY?: string },
  rawAddress: string | null | undefined,
): Promise<GeocodeHit | null> {
  const raw = (rawAddress ?? '').trim();
  const key = normalizeAddress(raw);
  if (key === '') return null;

  // Cache hit — no Google call.
  try {
    const { data } = await sb
      .from('geocode_cache')
      .select('lat, lng, formatted_address, location_type')
      .eq('normalized_address', key)
      .maybeSingle();
    if (data) {
      const r = data as Record<string, unknown>;
      const lat = Number(r.lat);
      const lng = Number(r.lng);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        return {
          lat,
          lng,
          formattedAddress: (r.formattedAddress ?? r.formatted_address ?? null) as string | null,
          locationType: (r.locationType ?? r.location_type ?? null) as string | null,
        };
      }
    }
  } catch { /* cache read is best-effort; fall through to a live geocode */ }

  const apiKey = env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null;
  if (missedRecently(key, Date.now())) return null;

  let hit: GeocodeHit | null = null;
  try {
    const resp = await fetch(buildGeocodeUrl(raw, apiKey), { signal: AbortSignal.timeout(8_000) });
    if (!resp.ok) return null;
    hit = parseGeocode((await resp.json()) as GeocodeBody);
  } catch {
    return null; // a network failure is not a verdict on the address: not remembered
  }
  if (!hit) { rememberMiss(key, Date.now()); return null; }

  // Cache the result — best-effort, ON CONFLICT the unique key is a no-op so a
  // race just keeps whichever row landed first.
  try {
    await sb.from('geocode_cache').upsert(
      {
        normalized_address: key,
        raw_address: raw,
        formatted_address: hit.formattedAddress,
        lat: hit.lat,
        lng: hit.lng,
        location_type: hit.locationType,
      },
      { onConflict: 'normalized_address', ignoreDuplicates: true },
    );
  } catch { /* a cache write failure must never fail the geocode itself */ }

  return hit;
}
