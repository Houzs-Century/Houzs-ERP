/* Pure logic for backend/scripts/complete-postcode-fields.mjs — which empty
   City / State (and, on a Delivery Planning job, which empty Postcode) a row
   should get from the postcode it already carries. No database and no network
   here; tests/postcodeCompletionPlan.test.mjs pins every decision.

   Owner 2026-11-18: "records that have a postcode but no City/State — backfill
   all of them" (a supplier with postcode 43500 and empty State/City shows
   "pick state" in its form), and "old DP jobs — backfill them all": a dp_orders
   row whose postcode is empty but written in its address text is today only
   completed at READ time (src/scm/lib/postcode-from-address.ts); he wants it
   stored.

   THE RULES.
   - Only EMPTY fields are filled. A value already stored is never changed.
   - City and State come from scm.my_localities for the postcode, never guessed.
   - A postcode my_localities files under several states fills nothing.
   - A postcode under several cities fills the State only; the City is listed
     as unresolved.
   - A State already on the row that disagrees with my_localities is FLAGGED and
     nothing on that side is written (the postcode itself may be the mistake).
   - Detecting a missing postcode from the address (DP jobs only) is the
     read-time rule, imported from postcode-from-address.ts so the two cannot
     drift: exactly one standalone 5-digit number that my_localities knows, in
     the address lines or the city; two known numbers = none. */

import { canonicalizeMyState } from '../../src/scm/lib/canonical-state.ts';
import { postcodeCandidates } from '../../src/scm/lib/postcode-from-address.ts';

/* Every table this completes. A `side` is one postcode / city / state trio:
   `states` lists every column that holds the State (a Delivery Order carries
   both `state` and `customer_state`), `lines` the address text a missing
   postcode may be detected in (only when `detect`). `group` is what TABLES=
   selects. `printName`: the row's name is a business / public place and may be
   printed in the log; every other table prints ids only. `lock`: the document
   lock the apply re-checks (see the script). */
export const COMPLETION_TARGETS = [
  {
    key: 'suppliers', table: 'scm.suppliers', group: 'masters', idCol: 'id', printName: true, lock: null,
    sides: [{ side: 'main', postcode: 'postcode', city: 'city', states: ['state'], lines: ['address1', 'address2', 'address3', 'address4', 'address'], detect: false }],
  },
  {
    key: 'venues', table: 'public.project_venues', group: 'masters', idCol: 'id', printName: true, lock: null,
    sides: [{ side: 'main', postcode: 'postcode', city: 'city', states: ['state'], lines: [], detect: false }],
  },
  {
    key: 'warehouses', table: 'scm.warehouses', group: 'masters', idCol: 'id', printName: true, lock: null,
    sides: [{ side: 'main', postcode: 'postcode', city: 'city', states: ['state'], lines: ['location'], detect: false }],
  },
  {
    key: 'threepl', table: 'scm.threepl_companies', group: 'masters', idCol: 'id', printName: true, lock: null,
    sides: [{ side: 'main', postcode: 'postcode', city: 'city', states: ['state'], lines: ['address'], detect: false }],
  },
  {
    key: 'saved_locations', table: 'scm.saved_locations', group: 'masters', idCol: 'id', printName: false, lock: null,
    sides: [{ side: 'main', postcode: 'postcode', city: 'city', states: ['state'], lines: ['address1', 'address2'], detect: false }],
  },
  {
    key: 'dp', table: 'scm.dp_orders', group: 'dp', idCol: 'id', printName: false, lock: null,
    sides: [
      { side: 'dest', postcode: 'postcode', city: 'city', states: ['state'], lines: ['address1', 'address2', 'address3', 'address4'], detect: true },
      { side: 'from', postcode: 'from_postcode', city: 'from_city', states: ['from_state'], lines: ['from_address1', 'from_address2'], detect: true },
    ],
  },
  {
    /* No company_id of its own: the company is the case's (public.assr_cases). */
    key: 'case', table: 'public.assr_case_address', group: 'case', idCol: 'assr_id', printName: false, lock: null,
    sides: [{ side: 'main', postcode: 'postcode', city: 'city', states: ['state'], lines: [], detect: false }],
  },
  {
    key: 'so', table: 'scm.mfg_sales_orders', group: 'so', idCol: 'doc_no', printName: false, lock: 'so',
    sides: [{ side: 'main', postcode: 'postcode', city: 'city', states: ['customer_state'], lines: [], detect: false }],
  },
  {
    key: 'do', table: 'scm.delivery_orders', group: 'do', idCol: 'id', printName: false, lock: 'do',
    sides: [{ side: 'main', postcode: 'postcode', city: 'city', states: ['state', 'customer_state'], lines: [], detect: false }],
  },
];

/* What runs without TABLES=. The Sales Order and Delivery Order are customer /
   financial documents mirrored to AutoCount: the owner applies the masters
   first and opts into those two by name. */
export const DEFAULT_GROUPS = ['masters', 'dp', 'case'];
export const ALL_GROUPS = ['masters', 'dp', 'case', 'so', 'do', 'venue_rename'];
/* TABLES=all is every fill; the project venue rename is a decision, named on its own. */
const ALL_FILLS = ['masters', 'dp', 'case', 'so', 'do'];

/** TABLES= text -> the groups to run, or an error. Empty = DEFAULT_GROUPS. */
export function parseGroups(text) {
  const raw = String(text ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (raw.length === 0) return { ok: true, groups: [...DEFAULT_GROUPS] };
  const groups = [...new Set(raw.flatMap((g) => (g === 'all' ? ALL_FILLS : [g])))];
  const bad = groups.filter((g) => !ALL_GROUPS.includes(g));
  if (bad.length) return { ok: false, why: `unknown TABLES value(s) ${bad.join(', ')}; use ${ALL_GROUPS.join(', ')} or all (= every fill, not venue_rename)` };
  return { ok: true, groups };
}

const t = (v) => (v == null ? '' : String(v)).trim();
export const stateKey = (s) => t(canonicalizeMyState(t(s)) ?? '').toUpperCase();

/** my_localities rows -> Map(postcode -> {cities: string[], states: string[]}),
 *  each list de-duplicated (states compared canonically, first spelling kept). */
export function completionIndex(rows) {
  const idx = new Map();
  for (const r of rows) {
    const pc = t(r.postcode);
    if (!/^\d{5}$/.test(pc)) continue;
    const e = idx.get(pc) ?? { cities: [], states: [], stateKeys: [] };
    const city = t(r.city);
    const state = t(r.state);
    if (city && !e.cities.includes(city)) e.cities.push(city);
    if (state && !e.stateKeys.includes(stateKey(state))) { e.stateKeys.push(stateKey(state)); e.states.push(state); }
    idx.set(pc, e);
  }
  return idx;
}

const r = (code, text) => ({ code, text });

/**
 * One side of one row. `values` maps column -> stored value. Returns
 *   { changes: {col: value}, unresolved: Reason[], flags: Reason[], detected: postcode|null }
 * `changes` holds only columns that are empty today. A Reason is { code, text }:
 * `text` names the values (postcode, states, cities), `code` names none, for
 * the tables whose log may not carry a customer's address details.
 */
export function planSide(spec, values, idx) {
  const out = { changes: {}, unresolved: [], flags: [], detected: null };
  const label = spec.side === 'from' ? 'from ' : '';
  const stored = t(values[spec.postcode]);
  const cityEmpty = !t(values[spec.city]);
  const emptyStates = spec.states.filter((c) => !t(values[c]));
  const filledStates = spec.states.filter((c) => t(values[c]));

  let pc = stored;
  if (!pc) {
    if (!spec.detect) return out;
    const known = postcodeCandidates(...spec.lines.map((c) => values[c] ?? null), values[spec.city] ?? null).filter((p) => idx.has(p));
    if (known.length === 0) return out; // nothing in the address: nothing to say
    if (known.length > 1) { out.unresolved.push(r(`${label}two-known-postcodes`, `${label}address holds ${known.length} known postcodes (${known.join(', ')})`)); return out; }
    pc = known[0];
    out.detected = pc;
  } else if (!cityEmpty && emptyStates.length === 0) {
    return out; // complete already
  }

  if (!/^\d{5}$/.test(pc)) { out.unresolved.push(r(`${label}postcode-not-5-digits`, `${label}postcode "${pc}" is not 5 digits`)); return out; }
  const loc = idx.get(pc);
  if (!loc) { out.unresolved.push(r(`${label}postcode-not-in-my_localities`, `${label}postcode ${pc} is not in my_localities`)); return out; }
  if (loc.states.length !== 1) {
    out.unresolved.push(r(`${label}postcode-${loc.states.length ? 'several' : 'no'}-states`, `${label}postcode ${pc} sits under ${loc.states.length ? `several states (${loc.states.join(', ')})` : 'no state'} in my_localities`));
    return out;
  }
  const state = loc.states[0];
  const disagree = filledStates.filter((c) => stateKey(values[c]) !== stateKey(state));
  if (disagree.length) {
    out.flags.push(r(`${label}state-disagrees(${disagree.join(',')})`, `${label}postcode ${pc} is ${state} in my_localities, but ${disagree.map((c) => `${c} says "${t(values[c])}"`).join(' and ')}; not changed`));
    out.detected = null;
    return out;
  }

  if (out.detected) out.changes[spec.postcode] = pc;
  for (const c of emptyStates) out.changes[c] = state;
  if (cityEmpty) {
    if (loc.cities.length === 1) out.changes[spec.city] = loc.cities[0];
    else out.unresolved.push(r(`${label}city-${loc.cities.length ? 'several' : 'no'}-cities`, `${label}city: postcode ${pc} covers ${loc.cities.length ? `several cities (${loc.cities.join(', ')})` : 'no city'} in my_localities`));
  }
  return out;
}

/**
 * The plan. `rows`: { target (a COMPLETION_TARGETS key), id, companyId, name,
 * values: {col: value}, locked: string|null }. `locked` is the reason a
 * document may not be edited (a live downstream document), or null.
 *
 * Returns { planned, locked, unresolved, flagged }:
 *   planned   rows with at least one change and no lock: { ..., changes, notes }
 *   locked    rows that WOULD change but are locked: never written
 *   unresolved / flagged: one entry per row with reasons, never written for
 *             the reasons given (a planned row may also appear here for the
 *             part of it that could not be decided, e.g. its city)
 */
export function buildCompletionPlan({ rows, localities }) {
  const idx = completionIndex(localities);
  const byKey = new Map(COMPLETION_TARGETS.map((x) => [x.key, x]));
  const planned = [];
  const locked = [];
  const unresolved = [];
  const flagged = [];
  for (const r of rows) {
    const target = byKey.get(r.target);
    if (!target) throw new Error(`buildCompletionPlan: unknown target ${r.target}`);
    if (r.locked === undefined) throw new Error('buildCompletionPlan: pass locked (a reason, or null)');
    const base = { target: r.target, id: String(r.id), companyId: r.companyId, name: target.printName ? t(r.name) : null };
    const changes = {};
    const reasons = [];
    const flags = [];
    const detected = [];
    for (const spec of target.sides) {
      const s = planSide(spec, r.values ?? {}, idx);
      Object.assign(changes, s.changes);
      reasons.push(...s.unresolved);
      flags.push(...s.flags);
      if (s.detected) detected.push(`${spec.side === 'from' ? 'from_' : ''}postcode taken from the address text`);
    }
    if (reasons.length) unresolved.push({ ...base, reason: reasons.map((x) => x.text).join('; '), codes: reasons.map((x) => x.code).join('; ') });
    if (flags.length) flagged.push({ ...base, reason: flags.map((x) => x.text).join('; '), codes: flags.map((x) => x.code).join('; ') });
    if (Object.keys(changes).length === 0) continue;
    if (r.locked) { locked.push({ ...base, changes, reason: r.locked }); continue; }
    planned.push({ ...base, changes, notes: detected.join('; ') || null });
  }
  return { planned, locked, unresolved, flagged };
}

/** Per target, per column: how many planned rows fill it. */
export function countByField(planned) {
  const out = new Map();
  for (const p of planned) {
    const m = out.get(p.target) ?? new Map();
    for (const col of Object.keys(p.changes)) m.set(col, (m.get(col) ?? 0) + 1);
    out.set(p.target, m);
  }
  return out;
}

/**
 * The venue coverage of a company's live projects. `projects`: one row per
 * live project with { venue, venueId, venuePostcode, venueState, venueCity }
 * as PROJECT_VENUE_JOIN resolves it (venueId null = no venue row of that name).
 * `willFillState`: venue ids this plan gives a State. PURE.
 */
export function venueCoverage(projects, willFillState) {
  const has = (v) => t(v) !== '';
  const named = projects.filter((p) => has(p.venue));
  const matched = named.filter((p) => p.venueId != null);
  const unmatched = new Map();
  for (const p of named) {
    if (p.venueId != null) continue;
    const k = t(p.venue);
    unmatched.set(k, (unmatched.get(k) ?? 0) + 1);
  }
  const fill = willFillState ?? new Set();
  return {
    projects: projects.length,
    noVenue: projects.length - named.length,
    matched: matched.length,
    matchedVenues: new Set(matched.map((p) => String(p.venueId))).size,
    withPostcode: matched.filter((p) => has(p.venuePostcode)).length,
    withState: matched.filter((p) => has(p.venueState)).length,
    withCity: matched.filter((p) => has(p.venueCity)).length,
    withStateAfterPlan: matched.filter((p) => has(p.venueState) || fill.has(String(p.venueId))).length,
    unmatched: [...unmatched.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  };
}

/**
 * The fresh-connection check of one written row: every planned column now
 * holds exactly the planned value, and the SHAPE is right — each side's
 * postcode is 5 digits and known to my_localities, its State is that
 * postcode's state and its City one of that postcode's cities. `read` is the
 * row as re-read (null = gone). Returns the problems; [] = good. PURE.
 */
export function verifyWritten(targetKey, changes, read, localities) {
  const target = COMPLETION_TARGETS.find((x) => x.key === targetKey);
  if (!target) return [`unknown target ${targetKey}`];
  if (!read) return ['row not found on re-read'];
  const idx = localities instanceof Map ? localities : completionIndex(localities);
  const problems = [];
  for (const [col, want] of Object.entries(changes)) {
    if (t(read[col]) !== t(want)) problems.push(`${col} reads ${JSON.stringify(read[col] ?? null)}, planned ${JSON.stringify(want)}`);
  }
  for (const spec of target.sides) {
    const touched = [spec.postcode, spec.city, ...spec.states].some((c) => c in changes);
    if (!touched) continue;
    const pc = t(read[spec.postcode]);
    const loc = idx.get(pc);
    if (!/^\d{5}$/.test(pc) || !loc) { problems.push(`${spec.postcode} "${pc}" is not a my_localities postcode`); continue; }
    for (const c of spec.states) {
      if (c in changes && (loc.stateKeys.length !== 1 || stateKey(read[c]) !== loc.stateKeys[0])) problems.push(`${c} "${t(read[c])}" is not postcode ${pc}'s state`);
    }
    if (spec.city in changes && !loc.cities.includes(t(read[spec.city]))) problems.push(`${spec.city} "${t(read[spec.city])}" is not a city of postcode ${pc}`);
  }
  return problems;
}

/* PROJECT VENUE RENAME (owner 2026-11-18). A project names its venue by text
   and finds the venue master row through PROJECT_VENUE_JOIN (same company,
   lower(trim(name))). Six projects say "IOIGECC", a name the master does not
   have, so their Setup / Dismantle jobs get no postcode; the master's row is
   "IOI GRAND EXHIBITION & CONVENTION CENTRE" (62502). The owner chose to rename
   the project venue to that name, all six included (the 2027-07 one whose code
   says IOI-MALL-PUTRAJAYA is also IOIGECC, owner 2026-11-18). Only the venue
   field moves; project names and codes stay. Runs only with TABLES=venue_rename. */
export const VENUE_RENAMES = [
  { from: 'IOIGECC', to: 'IOI GRAND EXHIBITION & CONVENTION CENTRE' },
];

const venueKey = (s) => t(s).toLowerCase();

/**
 * `projects`: live (not archived) projects of one company, { id, code, venue }.
 * `masterNames`: the company's project_venues names. A rename is planned only
 * when the target name exists in the master (else the rename would not help and
 * is refused). Returns { planned: [{id, code, from, to}], refused: [{from, to, projects, reason}] }.
 */
export function planVenueRenames(projects, masterNames, renames = VENUE_RENAMES) {
  const master = new Set((masterNames ?? []).map(venueKey));
  const planned = [];
  const refused = [];
  for (const rn of renames) {
    const hits = projects.filter((p) => venueKey(p.venue) === venueKey(rn.from) && t(p.venue) !== rn.to);
    if (hits.length === 0) continue;
    if (!master.has(venueKey(rn.to))) {
      refused.push({ ...rn, projects: hits.length, reason: `the venue master has no "${rn.to}" in this company` });
      continue;
    }
    if (master.has(venueKey(rn.from))) {
      refused.push({ ...rn, projects: hits.length, reason: `the venue master already has a "${rn.from}" row; the projects resolve to it` });
      continue;
    }
    for (const p of hits) planned.push({ id: String(p.id), code: t(p.code), from: t(p.venue), to: rn.to });
  }
  return { planned, refused };
}
