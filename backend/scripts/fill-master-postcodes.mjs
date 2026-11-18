#!/usr/bin/env node
/* Fill the empty Postcode (and its City / State) on the master records Delivery
   Planning jobs draw their address from: suppliers, venues, warehouses and 3PL
   companies.

   WHY. Owner 2026-11-17: every DP job must carry Postcode + City + State,
   whatever its source, so Last Mile shows them. The masters are where those
   come from, and on 2026-11-17 venues had 94 of 94 without a postcode,
   suppliers 58 of 77, 3PL companies 9 of 9 (the 3PL columns are new in mig
   20261117T2000). The forms now take a postcode in the Sales Order's control;
   this proposes one for the rows already there.

   HOW A POSTCODE IS FOUND, in order (scripts/lib/master-postcodes.mjs):
     0. venues only: the hand-researched list scripts/data/venue-postcodes.json,
        when the row's name matches an entry's name ignoring case and surrounding
        spaces, exactly otherwise (the id is a hint),
        the entry is high or medium confidence, its postcode is in my_localities
        and my_localities' state agrees with the researched one (a disagreement
        is UNRESOLVED, not overridden by geocoding). Low confidence is not used;
     0b. warehouses only: the company's own addresses from the official site,
        scripts/data/warehouse-addresses.json, when the warehouse's name or code
        equals a listed name ignoring case. Besides postcode / city / state it
        writes the street into `location`, but only when `location` is empty.
        The row's State (guessed from its code by mig 0180) is replaced by the
        official one and the plan line says STATE ... becomes ...;
     1. a 5-digit postcode already written in the row's address text, valid in
        scm.my_localities;
     2. otherwise Google Geocoding — a venue by "name, state, Malaysia", the
        others by their address — keeping only a result whose postcode exists in
        my_localities and that Google does not mark partial or approximate.
   City and State always come from my_localities for that postcode. Anything
   ambiguous or not found is listed as UNRESOLVED and never written.

   GEOCODING NEEDS GOOGLE_MAPS_API_KEY in the environment. The production runner
   ("Run a backend script on production") does NOT pass it today — without it
   step 2 is skipped, every row it would have decided is UNRESOLVED with that
   reason, and the address-text proposals are still made. The key is never
   printed: no request URL is ever logged.

   MODE=plan (default) prints every proposal and every unresolved row and writes
   nothing. MODE=apply needs CONFIRM="FILL MASTER POSTCODES AS PLANNED", writes
   only the planned rows of COMPANY_ID (default 1), each guarded on its id, its
   company and a still-empty postcode, then re-reads them on a fresh connection
   and checks each now holds exactly the planned postcode / city / state (and,
   for a warehouse whose street was planned, that street).

   Never printed: phone numbers and emails (not selected; a long digit run in an
   address is masked).

   RE-RUN: safe. Only rows whose postcode is still empty are read or written, so
   a second run proposes only what the first left unresolved, and never touches
   a postcode someone has since entered by hand. A warehouse street is written
   only into an empty location, so a hand-entered one is never replaced. */
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { MASTER_TABLES, buildPlan, curatedIndex, curatedWarehouseIndex, geocodeQuery, parseGeocodePostcode, venueNameKey } from './lib/master-postcodes.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
if (!Number.isInteger(CO) || CO <= 0) { console.error('COMPANY_ID must be a positive integer'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'FILL MASTER POSTCODES AS PLANNED';
const GOOGLE_KEY = (process.env.GOOGLE_MAPS_API_KEY || '').trim();
const MAX_GEOCODE = Number(process.env.MAX_GEOCODE || 300);

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);
const say = (m) => console.log(m);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

/* A long run of digits in an address is a phone number more often than not. */
const mask = (s) => String(s ?? '').replace(/\+?\d[\d\s-]{7,}\d/g, '[number]').slice(0, 140);

const CURATED_FILE = new URL('./data/venue-postcodes.json', import.meta.url);
const curated = curatedIndex(JSON.parse(readFileSync(CURATED_FILE, 'utf8')).entries);
const WAREHOUSE_FILE = new URL('./data/warehouse-addresses.json', import.meta.url);
const curatedWh = curatedWarehouseIndex(JSON.parse(readFileSync(WAREHOUSE_FILE, 'utf8')).entries);

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

/* Which of the columns we need each table actually has — a table that lacks
   them (3PL before its migration) is skipped by name, not crashed on. */
async function columnsOf(client) {
  const rows = await client`SELECT table_schema || '.' || table_name AS t, column_name
                              FROM information_schema.columns
                             WHERE table_schema IN ('scm', 'public')
                               AND table_name IN ('suppliers', 'project_venues', 'warehouses', 'threepl_companies')`;
  const has = new Map();
  for (const r of rows) {
    if (!has.has(r.t)) has.set(r.t, new Set());
    has.get(r.t).add(r.column_name);
  }
  return has;
}

/* The rows with an empty postcode, shaped for the plan. */
async function readEmpty(master) {
  const empty = `(postcode IS NULL OR btrim(postcode) = '')`;
  if (master.key === 'suppliers') {
    return sql.unsafe(
      `SELECT id::text AS id, company_id, name, city, state,
              concat_ws(', ', NULLIF(btrim(address1), ''), NULLIF(btrim(address2), ''), NULLIF(btrim(address3), ''),
                        NULLIF(btrim(address4), ''), NULLIF(btrim(address), '')) AS address
         FROM scm.suppliers WHERE company_id = $1 AND ${empty} ORDER BY name`, [CO]);
  }
  if (master.key === 'venues') {
    return sql.unsafe(
      `SELECT id::text AS id, company_id, name, city, state, NULL::text AS address
         FROM public.project_venues WHERE company_id = $1 AND active = 1 AND ${empty} ORDER BY name`, [CO]);
  }
  if (master.key === 'warehouses') {
    return sql.unsafe(
      `SELECT id::text AS id, company_id, coalesce(NULLIF(btrim(name), ''), code) AS name, code, city, state, location AS address
         FROM scm.warehouses WHERE company_id = $1 AND ${empty} ORDER BY code`, [CO]);
  }
  return sql.unsafe(
    `SELECT id::text AS id, company_id, name, city, state, address
       FROM scm.threepl_companies WHERE company_id = $1 AND ${empty} ORDER BY name`, [CO]);
}

async function geocode(query) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&region=my&components=country:MY&key=${GOOGLE_KEY}`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!resp.ok) return { failed: `HTTP ${resp.status}` };
    const body = await resp.json();
    if (body.status === 'REQUEST_DENIED' || body.status === 'OVER_QUERY_LIMIT') return { failed: `Google said ${body.status}` };
    return { hit: parseGeocodePostcode(body) };
  } catch (e) {
    return { failed: `request failed (${e?.name ?? 'error'})` };
  }
}

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO} geocoding=${GOOGLE_KEY ? `on (at most ${MAX_GEOCODE} calls)` : 'OFF — GOOGLE_MAPS_API_KEY is not set'}`);

  const localities = await sql`SELECT postcode, city, state FROM scm.my_localities WHERE postcode IS NOT NULL AND btrim(postcode) <> ''`;
  note(`my_localities rows with a postcode: ${localities.length}`);
  if (localities.length === 0) { bad('my_localities is empty — nothing can be validated, refusing to plan.'); await sql.end({ timeout: 5 }); process.exit(1); }

  note(`curated venue entries: ${curated.byName.size}${curated.duplicates.length ? ` (dropped, name listed twice: ${curated.duplicates.join(', ')})` : ''}`);
  note(`curated warehouse names: ${curatedWh.byName.size}${curatedWh.duplicates.length ? ` (dropped, claimed twice: ${curatedWh.duplicates.join(', ')})` : ''}`);

  const has = await columnsOf(sql);
  const rows = [];
  for (const m of MASTER_TABLES) {
    const cols = has.get(m.table) ?? new Set();
    const missing = ['postcode', 'city', 'state', 'company_id'].filter((c) => !cols.has(c));
    if (missing.length) { note(`SKIPPED ${m.table}: no ${missing.join(', ')} column (migration not applied?)`); continue; }
    const got = await readEmpty(m);
    note(`${m.table}: ${got.length} row(s) with no postcode`);
    for (const r of got) rows.push({ master: m.key, id: r.id, companyId: Number(r.company_id), name: r.name, code: r.code ?? null, address: r.address, city: r.city, state: r.state });
  }

  /* Geocode only the rows the address text could not settle, and only when the
     text itself was not ambiguous (buildPlan would refuse those anyway). */
  const { planned: firstPass, unresolved: needGeo } = buildPlan({ rows, localities, geocodes: new Map(), geocodeSkipped: () => 'not geocoded yet', curated: curated.byName, curatedWarehouses: curatedWh.byName });
  const geocodes = new Map();
  let calls = 0;
  const skipped = new Map();
  for (const u of needGeo) {
    if (u.settled) continue; // the address text or curated entry was ambiguous, or contradicts the row — Google cannot fix that
    const master = MASTER_TABLES.find((m) => m.key === u.master);
    const row = rows.find((r) => r.master === u.master && r.id === u.id);
    const query = geocodeQuery(master, row);
    const key = `${u.master}:${u.id}`;
    if (!query) { skipped.set(key, 'nothing to geocode (no address)'); continue; }
    if (!GOOGLE_KEY) { skipped.set(key, 'not geocoded: GOOGLE_MAPS_API_KEY is not set on this runner'); continue; }
    if (calls >= MAX_GEOCODE) { skipped.set(key, `not geocoded: MAX_GEOCODE=${MAX_GEOCODE} reached`); continue; }
    calls += 1;
    const g = await geocode(query);
    if (g.failed) skipped.set(key, `geocode ${g.failed}`);
    else geocodes.set(key, g.hit);
  }
  note(`geocode calls made: ${calls} (curated + address-text proposals: ${firstPass.length})`);

  const { planned, unresolved } = buildPlan({
    rows, localities, geocodes,
    geocodeSkipped: (r) => skipped.get(`${r.master}:${r.id}`) ?? 'not geocoded',
    curated: curated.byName,
    curatedWarehouses: curatedWh.byName,
  });

  say(`\n=== PLANNED (${planned.length}) — table | id | name | current address | proposed postcode / city / state [+ street] | source | confidence ===`);
  for (const p of planned) {
    const street = p.proposed.street ? ` + street "${p.proposed.street}"` : '';
    say(`  ${p.master} | ${p.id} | ${p.name} | ${mask(p.address) || '-'} | ${p.proposed.postcode} / ${p.proposed.city} / ${p.proposed.state}${street} | ${p.source} | ${p.confidence}${p.note ? ` | ${p.note}` : ''}`);
  }
  say(`\n=== UNRESOLVED (${unresolved.length}) — never written ===`);
  for (const u of unresolved) say(`  ${u.master} | ${u.id} | ${u.name} | ${mask(u.address) || '-'} | ${u.reason}`);
  const venueNames = new Set(rows.filter((r) => r.master === 'venues').map((r) => venueNameKey(r.name)));
  const unmatched = [...curated.byName.entries()].filter(([k]) => !venueNames.has(k)).map(([, e]) => e.name);
  say(`
=== CURATED ENTRIES WITH NO EMPTY-POSTCODE VENUE OF THAT NAME (case ignored) (${unmatched.length}) ===`);
  for (const n of unmatched) say(`  ${n}`);
  const byMaster = (list) => MASTER_TABLES.map((m) => `${m.key} ${list.filter((x) => x.master === m.key).length}`).join(', ');
  note(`\nplanned: ${planned.length} (${byMaster(planned)})   unresolved: ${unresolved.length} (${byMaster(unresolved)})`);

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  note(`\n=== WRITING ${planned.length} ROW(S) ===`);
  const tableOf = new Map(MASTER_TABLES.map((m) => [m.key, m.table]));
  const written = [];
  for (const p of planned) {
    if (p.companyId !== CO) { bad(`  SKIP ${p.master} ${p.id}: company ${p.companyId} is not ${CO}`); continue; }
    /* The street only ever lands in an EMPTY warehouse location. */
    const back = p.master === 'warehouses'
      ? await sql.unsafe(
        `UPDATE scm.warehouses SET postcode = $1, city = $2, state = $3,
                location = CASE WHEN $6::text IS NOT NULL AND (location IS NULL OR btrim(location) = '') THEN $6::text ELSE location END
          WHERE id::text = $4 AND company_id = $5 AND (postcode IS NULL OR btrim(postcode) = '')
         RETURNING id::text AS id`,
        [p.proposed.postcode, p.proposed.city, p.proposed.state, p.id, CO, p.proposed.street])
      : await sql.unsafe(
        `UPDATE ${tableOf.get(p.master)} SET postcode = $1, city = $2, state = $3
          WHERE id::text = $4 AND company_id = $5 AND (postcode IS NULL OR btrim(postcode) = '')
         RETURNING id::text AS id`,
        [p.proposed.postcode, p.proposed.city, p.proposed.state, p.id, CO]);
    if (back.length) written.push(p);
    note(`  ${back.length ? 'OK  ' : 'SKIP (postcode filled meanwhile)'} ${p.master} ${p.id} ${p.name}`);
  }
  note(`  written: ${written.length} of ${planned.length}`);
  await sql.end({ timeout: 5 });

  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  let wrong = 0;
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    for (const p of written) {
      const [row] = await check.unsafe(
        `SELECT x.postcode, x.city, x.state, ${p.master === 'warehouses' ? 'x.location' : 'NULL::text'} AS street,
                EXISTS (SELECT 1 FROM scm.my_localities ml WHERE ml.postcode = x.postcode AND ml.city = x.city AND ml.state = x.state) AS in_catalog
           FROM ${tableOf.get(p.master)} x WHERE x.id::text = $1 AND x.company_id = $2`, [p.id, CO]);
      const same = row && row.postcode === p.proposed.postcode && row.city === p.proposed.city && row.state === p.proposed.state && row.in_catalog === true
        && (!p.proposed.street || row.street === p.proposed.street);
      if (!same) { wrong += 1; bad(`  ${p.master} ${p.id}: reads ${JSON.stringify(row ?? null)}, planned ${JSON.stringify(p.proposed)}`); }
    }
    note(`  ${written.length - wrong} of ${written.length} written rows read back exactly as planned and match a my_localities row`);
  } finally {
    await check.end({ timeout: 5 });
  }
  if (wrong) process.exit(1);
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
