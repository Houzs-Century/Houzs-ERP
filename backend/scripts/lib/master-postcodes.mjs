/* Pure logic for backend/scripts/fill-master-postcodes.mjs — which Postcode /
   City / State a master record (supplier, venue, warehouse, 3PL company) should
   carry, and from what evidence. No database and no network here, so every
   decision is unit-tested (tests/masterPostcodesPlan.test.mjs).

   Owner 2026-11-17: every Delivery Planning job must carry Postcode + City +
   State, whatever its source, so Last Mile shows them. The sources are these
   masters, and most of them have no postcode (venues 94 of 94, suppliers 58 of
   77, 3PL 9 of 9 on 2026-11-17).

   THE RULES.
   - A postcode is only ever one that exists in scm.my_localities — the same
     table every address form picks from. A 5-digit number that is not there is
     not a postcode, whatever it looks like.
   - City and State come from my_localities for that postcode, never from the
     geocoder's own admin areas (which disagree with the catalog — scan-so.ts
     snaps them the same way).
   - Ambiguity is refused, never guessed: two different valid postcodes in one
     address, a postcode that maps to more than one state, a postcode under
     several cities none of which the address names, a postcode whose state
     contradicts the State already on the row, a geocode that Google itself
     marks partial or approximate. Every such row goes to UNRESOLVED with the
     reason and is never written.
   - Only an EMPTY postcode is filled. A row that already has one is not read. */

import { canonicalizeMyState } from '../../src/scm/lib/canonical-state.ts';

/* The masters this fills. `geocodeBy` says what Google is asked: a venue has no
   street address (owner 2026-07-23: venues only need State), only a well-known
   name such as "Sunway Pyramid", so it is looked up by name; the others by the
   address text they hold. Workshops are NOT here: scm.workshops has no postcode,
   city or state columns (owner 2026-11-17: not required for LORRY_SERVICE). */
export const MASTER_TABLES = [
  { key: 'suppliers', table: 'scm.suppliers', geocodeBy: 'address' },
  { key: 'venues', table: 'public.project_venues', geocodeBy: 'name' },
  { key: 'warehouses', table: 'scm.warehouses', geocodeBy: 'address' },
  { key: 'threepl', table: 'scm.threepl_companies', geocodeBy: 'address' },
];

const t = (v) => (v == null ? '' : String(v)).trim();
const stateKey = (s) => t(canonicalizeMyState(t(s)) ?? '').toUpperCase();

/** my_localities rows -> Map(postcode -> [{city, state}]). */
export function localityIndex(rows) {
  const idx = new Map();
  for (const r of rows) {
    const pc = t(r.postcode);
    if (!pc) continue;
    const list = idx.get(pc) ?? [];
    list.push({ city: t(r.city), state: t(r.state) });
    idx.set(pc, list);
  }
  return idx;
}

/** Every standalone 5-digit run in the text, in order, de-duplicated. A run that
 *  is part of a longer number (a phone, an SSM number) is not a candidate. */
export function postcodeCandidates(text) {
  const out = [];
  for (const m of t(text).matchAll(/(?<![\d-])\d{5}(?![\d-])/g)) {
    if (!out.includes(m[0])) out.push(m[0]);
  }
  return out;
}

/** The {city, state} a postcode means, or a refusal. `address` breaks a tie
 *  between several cities under one postcode, but only when it names exactly one. */
export function localityFor(idx, postcode, address) {
  const hits = idx.get(t(postcode)) ?? [];
  if (hits.length === 0) return { ok: false, why: `postcode ${postcode} is not in my_localities` };
  const states = [...new Set(hits.map((h) => stateKey(h.state)))];
  if (states.length > 1) return { ok: false, why: `postcode ${postcode} sits under more than one state in my_localities` };
  const cities = [...new Set(hits.map((h) => h.city))];
  if (cities.length === 1) return { ok: true, city: cities[0], state: hits[0].state };
  const text = t(address).toLowerCase();
  const named = cities.filter((c) => c && text.includes(c.toLowerCase()));
  if (named.length === 1) return { ok: true, city: named[0], state: hits[0].state };
  return { ok: false, why: `postcode ${postcode} covers several cities (${cities.join(', ')}) and the address names ${named.length ? 'more than one' : 'none'}` };
}

/** A postcode already written in the address text, validated against
 *  my_localities. Several numbers that are all the same postcode are fine; two
 *  DIFFERENT valid postcodes are ambiguous. */
export function postcodeFromAddress(idx, address) {
  const found = postcodeCandidates(address);
  const valid = found.filter((p) => idx.has(p));
  if (valid.length === 0) {
    return { ok: false, why: found.length ? `5-digit number(s) ${found.join(', ')} not in my_localities` : 'no postcode in the address text' };
  }
  if (valid.length > 1) return { ok: false, ambiguous: true, why: `the address holds ${valid.length} different postcodes (${valid.join(', ')})` };
  const loc = localityFor(idx, valid[0], address);
  if (!loc.ok) return { ok: false, ambiguous: true, why: loc.why };
  return { ok: true, postcode: valid[0], city: loc.city, state: loc.state, confidence: found.length === 1 ? 'high' : 'medium' };
}

/** The text a row is geocoded by, or '' when there is nothing worth a paid call. */
export function geocodeQuery(master, row) {
  if (master.geocodeBy === 'name') {
    const name = t(row.name);
    return name ? [name, t(row.state), 'Malaysia'].filter(Boolean).join(', ') : '';
  }
  const addr = t(row.address);
  return addr ? [addr, t(row.city), t(row.state), 'Malaysia'].filter(Boolean).join(', ') : '';
}

/** A Google Geocoding response -> {postcode, locationType, partial} of the top
 *  result, or null when Google found nothing usable. */
export function parseGeocodePostcode(body) {
  if (!body || body.status !== 'OK' || !Array.isArray(body.results) || body.results.length === 0) return null;
  const top = body.results[0];
  const pc = (top.address_components ?? []).find((c) => (c.types ?? []).includes('postal_code'));
  return {
    postcode: t(pc?.long_name) || null,
    locationType: t(top.geometry?.location_type) || null,
    partial: top.partial_match === true,
    formatted: t(top.formatted_address) || null,
  };
}

/** Decide one row from its geocode result. */
export function postcodeFromGeocode(idx, geo, address) {
  if (!geo) return { ok: false, why: 'Google found no match' };
  if (!geo.postcode) return { ok: false, why: 'Google matched a place with no postcode' };
  if (geo.partial) return { ok: false, ambiguous: true, why: `Google matched only part of the query (${geo.postcode})` };
  if (geo.locationType === 'APPROXIMATE') return { ok: false, ambiguous: true, why: `Google placed it only approximately (${geo.postcode})` };
  if (!idx.has(geo.postcode)) return { ok: false, why: `Google's postcode ${geo.postcode} is not in my_localities` };
  const loc = localityFor(idx, geo.postcode, address);
  if (!loc.ok) return { ok: false, ambiguous: true, why: loc.why };
  const confidence = geo.locationType === 'ROOFTOP' || geo.locationType === 'RANGE_INTERPOLATED' ? 'high' : 'medium';
  return { ok: true, postcode: geo.postcode, city: loc.city, state: loc.state, confidence };
}

/**
 * The plan. `rows` are master rows with an EMPTY postcode:
 *   { master: 'suppliers'|..., id, companyId, name, address, city, state }
 * `geocodes` maps `${master}:${id}` -> parsed geocode (or null for "no match");
 * a row with no entry was not geocoded, and `geocodeSkipped` says why.
 *
 * Returns { planned, unresolved } — planned rows carry the proposal and its
 * evidence; unresolved rows carry the reason. Nothing ambiguous is planned.
 */
export function buildPlan({ rows, localities, geocodes, geocodeSkipped }) {
  const idx = localityIndex(localities);
  const planned = [];
  const unresolved = [];
  for (const r of rows) {
    const base = { master: r.master, id: r.id, companyId: r.companyId, name: t(r.name), address: t(r.address), current: { city: t(r.city) || null, state: t(r.state) || null } };
    const fromText = postcodeFromAddress(idx, r.address);
    let pick = null;
    const reasons = [];
    if (fromText.ok) pick = { ...fromText, source: 'address text' };
    else {
      reasons.push(fromText.why);
      if (!fromText.ambiguous) {
        const key = `${r.master}:${r.id}`;
        if (geocodes.has(key)) {
          const g = postcodeFromGeocode(idx, geocodes.get(key), r.address || r.name);
          if (g.ok) pick = { ...g, source: 'geocode' };
          else reasons.push(g.why);
        } else {
          reasons.push(geocodeSkipped(r));
        }
      }
    }
    // `settled`: no geocode can change this verdict (the text itself was ambiguous,
    // or a postcode was found and contradicts the row).
    if (!pick) { unresolved.push({ ...base, settled: fromText.ambiguous === true, reason: reasons.join('; ') }); continue; }
    if (base.current.state && stateKey(base.current.state) !== stateKey(pick.state)) {
      unresolved.push({ ...base, settled: true, reason: `postcode ${pick.postcode} (${pick.source}) is in ${pick.state}, but the row says ${base.current.state}` });
      continue;
    }
    const cityChange = base.current.city && base.current.city.toLowerCase() !== pick.city.toLowerCase();
    planned.push({
      ...base,
      proposed: { postcode: pick.postcode, city: pick.city, state: pick.state },
      source: pick.source,
      confidence: pick.confidence,
      note: cityChange ? `city "${base.current.city}" becomes my_localities' "${pick.city}"` : null,
    });
  }
  return { planned, unresolved };
}
