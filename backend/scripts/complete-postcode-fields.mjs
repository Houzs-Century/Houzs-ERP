#!/usr/bin/env node
/* Fill the EMPTY City / State of every record that already has a Postcode, and
   store the Postcode an old Delivery Planning job only shows at read time.

   WHY. Owner 2026-11-18: "records that have a postcode but no City/State —
   backfill all of them" (a supplier with postcode 43500 shows State "pick
   state", City "Pick a state first"); "old DP jobs — backfill them all"
   (scm.dp_orders rows whose postcode sits in the address text are completed
   only when read, by src/scm/lib/postcode-from-address.ts); and "do all my
   projects' venues have a location now?" — the coverage report below.
   Empty postcodes on the masters are fill-master-postcodes.mjs's job, not this.

   WHAT IS FILLED (scripts/lib/postcode-completion.mjs, unit-tested):
   - City / State from scm.my_localities for the postcode the row carries, only
     where empty. Several cities under the postcode: State only, City listed as
     unresolved. Several states: nothing. A State already on the row that
     disagrees with my_localities: FLAGGED, nothing on that side written.
   - DP jobs (destination AND from_* side): an empty postcode taken from the
     address lines with the read-time rule — exactly one 5-digit number that
     my_localities knows; two = none — plus its City / State.

   TABLES= picks what runs (comma list): masters (suppliers, venues, warehouses,
   3PL companies, saved locations), dp, case (public.assr_case_address), so
   (scm.mfg_sales_orders), do (scm.delivery_orders), or all. Default:
   masters,dp,case. Sales Orders and Delivery Orders are customer documents
   mirrored to AutoCount, so they run only when named, and:
     - a row whose document lock is on is LISTED and never written: a Sales
       Order with a live Delivery Order or Sales Invoice (soHasDownstream), a
       Delivery Order with a live Sales Invoice (by header or line) or Delivery
       Return (doHasDownstream), or a cancelled document;
     - the lock is re-checked inside each UPDATE, so one taken between plan and
       write stops that row;
     - AutoCount is NOT updated by this script; the plan says how many planned
       rows are linked to an AutoCount document.

   MODE=plan (default) prints the venue coverage, counts per table and field,
   one line per planned / locked / unresolved / flagged row, and writes nothing.
   Names are printed for suppliers, venues, warehouses and 3PL companies (a
   business or a public place); every other table prints ids only. No address
   text, phone or customer name is ever printed.
   MODE=apply needs CONFIRM="COMPLETE POSTCODE FIELDS AS PLANNED" and writes
   only the planned rows of COMPANY_ID (required: run once per company), each
   UPDATE guarded on its id, its company and every planned column still being
   empty, then re-reads every written row on a fresh connection and checks the
   SHAPE: each planned column holds exactly the planned value, the postcode is
   a my_localities postcode, the State is its state and the City one of its
   cities.

   PROJECT VENUE RENAME (TABLES=venue_rename, never in the default or in
   `all`; same CONFIRM): the owner chose (2026-11-18) to rename the project
   venue "IOIGECC" (any case, surrounding spaces ignored) on every live project
   of COMPANY_ID to the venue master's "IOI GRAND EXHIBITION & CONVENTION
   CENTRE", so PROJECT_VENUE_JOIN finds its postcode (62502) for Setup /
   Dismantle. Only public.projects.venue changes; names and codes do not.
   Refused when the company's venue master lacks that name. The plan also
   counts the Sales Orders whose own venue text is IOIGECC: the fair picker and
   the fair reconcile match an order to a project by venue text, so an order
   still saying IOIGECC no longer matches these projects by venue (an order
   already linked keeps its project_id; the fair check may then say the slip
   venue differs). Sales Orders are not changed. Re-read on a fresh
   connection: the venue reads exactly the new name and resolves to a venue
   master row. A renamed project no longer says IOIGECC, so it is not planned
   again.

   RE-RUN: safe. Only empty fields are planned and each write requires them to
   be still empty, so a second run proposes only what the first left (the
   unresolved, flagged and locked rows) and never touches a value someone
   entered by hand in between. */
import postgres from 'postgres';
import { PROJECT_VENUE_JOIN } from '../src/scm/lib/project-venue-join.ts';
import {
  COMPLETION_TARGETS, LOCK_SQL, buildCompletionPlan, completionIndex, countByField, parseGroups, planVenueRenames, venueCoverage, verifyWritten,
} from './lib/postcode-completion.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID);
if (!Number.isInteger(CO) || CO <= 0) { console.error('COMPANY_ID is required (a positive integer); run once per company'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'COMPLETE POSTCODE FIELDS AS PLANNED';

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);
const say = (m) => console.log(m);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}
const parsed = parseGroups(process.env.TABLES);
if (!parsed.ok) { bad(parsed.why); process.exit(2); }
const GROUPS = parsed.groups;

const blank = (col) => `(${col} IS NULL OR btrim(${col}::text) = '')`;

const NAME_SQL = {
  suppliers: 'x.name', venues: 'x.name', warehouses: "coalesce(NULLIF(btrim(x.name), ''), x.code)", threepl: 'x.name',
};

async function columnsOf(client) {
  const rows = await client`SELECT table_schema || '.' || table_name AS t, column_name FROM information_schema.columns
                             WHERE table_schema IN ('scm', 'public')
                               AND table_name IN ('suppliers', 'project_venues', 'warehouses', 'threepl_companies', 'saved_locations',
                                                  'dp_orders', 'assr_case_address', 'mfg_sales_orders', 'delivery_orders')`;
  const has = new Map();
  for (const r of rows) {
    if (!has.has(r.t)) has.set(r.t, new Set());
    has.get(r.t).add(r.column_name);
  }
  return has;
}

/* The target with only the columns this database has: a missing State column
   or address line is dropped; a missing postcode or city skips the side. */
function shapeTarget(target, cols) {
  const sides = [];
  const dropped = [];
  for (const s of target.sides) {
    if (!cols.has(s.postcode) || !cols.has(s.city)) { dropped.push(`${s.side} side (no ${s.postcode} / ${s.city})`); continue; }
    const states = s.states.filter((c) => cols.has(c));
    if (states.length === 0) { dropped.push(`${s.side} side (no state column)`); continue; }
    dropped.push(...s.states.filter((c) => !cols.has(c)), ...s.lines.filter((c) => !cols.has(c)));
    sides.push({ ...s, states, lines: s.lines.filter((c) => cols.has(c)) });
  }
  return { ...target, sides, dropped };
}

const FROM_SQL = (target) => target.key === 'case'
  ? 'public.assr_case_address x JOIN public.assr_cases c ON c.id = x.assr_id'
  : `${target.table} x`;
const SCOPE_SQL = (target, param) => target.key === 'case' ? `c.company_id = ${param}` : `x.company_id = ${param}`;

/* The rows of this company with something to complete. */
async function readCandidates(target, hasLinked) {
  const cols = [...new Set(target.sides.flatMap((s) => [s.postcode, s.city, ...s.states, ...s.lines]))];
  const sideWhere = target.sides.map((s) => {
    const incomplete = `(${blank(`x.${s.city}`)} OR ${s.states.map((c) => blank(`x.${c}`)).join(' OR ')})`;
    return s.detect ? `(${blank(`x.${s.postcode}`)} OR ${incomplete})` : `(NOT ${blank(`x.${s.postcode}`)} AND ${incomplete})`;
  }).join(' OR ');
  const select = [
    `x.${target.idCol}::text AS __id`,
    target.printName ? `${NAME_SQL[target.key]} AS __name` : 'NULL::text AS __name',
    target.lock ? `${LOCK_SQL[target.lock]} AS __locked` : 'NULL::text AS __locked',
    hasLinked ? `(NULLIF(btrim(x.linked_ac_docno::text), '') IS NOT NULL) AS __linked` : 'false AS __linked',
    ...cols.map((c) => `x.${c}::text AS ${c}`),
  ].join(', ');
  return sql.unsafe(`SELECT ${select} FROM ${FROM_SQL(target)} WHERE ${SCOPE_SQL(target, '$1')} AND (${sideWhere}) ORDER BY 1`, [CO]);
}

async function coverage(willFillState) {
  /* PROJECT_VENUE_JOIN names projects / project_venues unqualified (it also runs
     on the D1 mirror); both live in public. */
  const rows = await sql.unsafe(
    `SELECT p.venue, pv.id::text AS venue_id, pv.postcode AS venue_postcode, pv.state AS venue_state, pv.city AS venue_city
       FROM public.projects p ${PROJECT_VENUE_JOIN.replaceAll('project_venues', 'public.project_venues')}
      WHERE p.company_id = $1 AND p.archived_at IS NULL`, [CO]);
  return venueCoverage(rows.map((r) => ({ venue: r.venue, venueId: r.venue_id, venuePostcode: r.venue_postcode, venueState: r.venue_state, venueCity: r.venue_city })), willFillState);
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO} tables=${GROUPS.join(',')}`);
  const localities = await sql`SELECT postcode, city, state FROM scm.my_localities WHERE postcode IS NOT NULL AND btrim(postcode) <> ''`;
  note(`my_localities rows with a postcode: ${localities.length}`);
  if (localities.length === 0) { bad('my_localities is empty — nothing can be validated, refusing to plan.'); await sql.end({ timeout: 5 }); process.exit(1); }
  const idx = completionIndex(localities);

  const has = await columnsOf(sql);
  const targets = new Map();
  const rows = [];
  const linked = new Set();
  for (const base of COMPLETION_TARGETS) {
    if (!GROUPS.includes(base.group)) continue;
    const cols = has.get(base.table) ?? new Set();
    const scopeCol = base.key === 'case' ? 'assr_id' : 'company_id';
    if (!cols.has(scopeCol) || !cols.has(base.idCol)) { note(`SKIPPED ${base.table}: no ${scopeCol} / ${base.idCol} column`); continue; }
    const target = shapeTarget(base, cols);
    if (target.sides.length === 0) { note(`SKIPPED ${base.table}: ${target.dropped.join(', ')}`); continue; }
    if (target.dropped.length) note(`${base.table}: not read (column absent): ${target.dropped.join(', ')}`);
    targets.set(target.key, target);
    const got = await readCandidates(target, cols.has('linked_ac_docno') && (base.key === 'so' || base.key === 'do'));
    note(`${base.table}: ${got.length} row(s) with a field to look at`);
    for (const r of got) {
      if (r.__linked) linked.add(`${base.key}:${r.__id}`);
      rows.push({ target: base.key, id: r.__id, companyId: CO, name: r.__name, values: r, locked: r.__locked ?? null });
    }
  }

  const { planned, locked, unresolved, flagged } = buildCompletionPlan({ rows, localities });

  let renames = [];
  if (GROUPS.includes('venue_rename')) {
    const projects = await sql`SELECT id::text AS id, code, venue FROM public.projects
                                WHERE company_id = ${CO} AND archived_at IS NULL AND venue IS NOT NULL AND btrim(venue) <> ''`;
    const master = await sql`SELECT name FROM public.project_venues WHERE company_id = ${CO}`;
    const rp = planVenueRenames(projects, master.map((m) => m.name));
    renames = rp.planned;
    say(`\n=== PROJECT VENUE RENAME (${renames.length}) — project id | code | venue -> new venue ===`);
    for (const r of renames) say(`  ${r.id} | ${r.code} | ${r.from} -> ${r.to}`);
    for (const f of rp.refused) say(`  REFUSED ${f.from} -> ${f.to} (${f.projects} project(s)): ${f.reason}`);
    if (renames.length) {
      const froms = [...new Set(renames.map((r) => r.from.toLowerCase()))];
      const [so] = await sql`SELECT count(*)::int AS total,
                                    count(*) FILTER (WHERE project_id::text = ANY(${renames.map((r) => r.id)}))::int AS linked,
                                    count(*) FILTER (WHERE project_id IS NULL)::int AS unlinked
                               FROM scm.mfg_sales_orders
                              WHERE company_id = ${CO} AND lower(btrim(venue)) = ANY(${froms})`;
      say(`  Sales Orders whose venue text says ${froms.join(' / ')}: ${so.total} (linked to one of these projects: ${so.linked}; linked to no project: ${so.unlinked}) — not changed`);
    }
  }

  const willFillState = new Set(planned.filter((p) => p.target === 'venues' && 'state' in p.changes).map((p) => p.id));
  const cov = await coverage(willFillState);
  say(`\n=== PROJECT VENUES (company ${CO}, projects not archived) ===`);
  say(`  projects: ${cov.projects}; with no venue name: ${cov.noVenue}`);
  say(`  venue name matches a venue master row: ${cov.matched} / ${cov.projects - cov.noVenue} projects (${cov.matchedVenues} distinct venues)`);
  say(`  of those ${cov.matched}: with postcode ${cov.withPostcode}, with state ${cov.withState} (${cov.withStateAfterPlan} after this plan), with city ${cov.withCity}`);
  say(`  venue names with no venue master row (${cov.unmatched.length} names, ${cov.unmatched.reduce((a, [, n]) => a + n, 0)} projects) — name | projects:`);
  for (const [name, n] of cov.unmatched) say(`    ${name} | ${n}`);

  const counts = countByField(planned);
  say(`\n=== COUNTS — table: planned rows (field: rows) | locked | unresolved | flagged ===`);
  for (const [key, target] of targets) {
    const fields = [...(counts.get(key) ?? new Map()).entries()].map(([c, n]) => `${c}: ${n}`).join(', ') || '-';
    const n = (list) => list.filter((x) => x.target === key).length;
    const link = key === 'so' || key === 'do' ? ` | linked to AutoCount: ${planned.filter((p) => p.target === key && linked.has(`${key}:${p.id}`)).length} planned` : '';
    say(`  ${target.table}: ${n(planned)} (${fields}) | locked ${n(locked)} | unresolved ${n(unresolved)} | flagged ${n(flagged)}${link}`);
  }
  const who = (x) => `${x.target} | ${x.id}${x.name ? ` | ${x.name}` : ''}`;
  /* Values only for the masters whose name may be printed; a customer-facing
     row (SO, DO, DP job, service case, saved location) shows field names only. */
  const shows = (x) => targets.get(x.target)?.printName === true;
  const what = (x) => (shows(x) ? Object.entries(x.changes).map(([c, v]) => `${c}=${v}`) : Object.keys(x.changes)).join(', ');
  const why = (x) => (shows(x) ? x.reason : x.codes);
  say(`\n=== PLANNED (${planned.length}) — table | id [| name] | fields filled ===`);
  for (const p of planned) say(`  ${who(p)} | ${what(p)}${p.notes ? ` | ${p.notes}` : ''}`);
  say(`\n=== LOCKED (${locked.length}) — would fill, never written ===`);
  for (const l of locked) say(`  ${who(l)} | ${Object.keys(l.changes).join(', ')} | ${l.reason}`);
  say(`\n=== UNRESOLVED (${unresolved.length}) — that part never written ===`);
  for (const u of unresolved) say(`  ${who(u)} | ${why(u)}`);
  say(`\n=== FLAGGED (${flagged.length}) — State disagrees with the postcode, nothing on that side written ===`);
  for (const f of flagged) say(`  ${who(f)} | ${why(f)}`);
  note(`\nplanned ${planned.length}, locked ${locked.length}, unresolved ${unresolved.length}, flagged ${flagged.length}${GROUPS.includes('venue_rename') ? `; project venue renames ${renames.length}` : ''}`);

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}" COMPANY_ID=${CO}${process.env.TABLES ? ` TABLES=${process.env.TABLES}` : ''}.`);
    await sql.end({ timeout: 5 });
    return;
  }

  const renamed = [];
  if (renames.length) {
    note(`\n=== RENAMING ${renames.length} PROJECT VENUE(S) ===`);
    for (const r of renames) {
      const back = await sql`UPDATE public.projects SET venue = ${r.to}
                              WHERE id::text = ${r.id} AND company_id = ${CO} AND archived_at IS NULL
                                AND lower(btrim(venue)) = ${r.from.toLowerCase()}
                             RETURNING id::text AS id`;
      if (back.length === 1) renamed.push(r);
      note(`  ${back.length === 1 ? 'OK  ' : 'SKIP (venue changed or archived meanwhile)'} project ${r.id} ${r.code}`);
    }
    note(`  renamed: ${renamed.length} of ${renames.length}`);
  }

  note(`\n=== WRITING ${planned.length} ROW(S) ===`);
  const written = [];
  for (const p of planned) {
    if (p.companyId !== CO) { bad(`  SKIP ${p.target} ${p.id}: company ${p.companyId} is not ${CO}`); continue; }
    const target = targets.get(p.target);
    const cols = Object.keys(p.changes);
    const params = [p.id, CO, ...cols.map((c) => p.changes[c])];
    const set = cols.map((c, i) => `${c} = $${i + 3}`).join(', ');
    const still = cols.map((c) => blank(`x.${c}`)).join(' AND ');
    const scope = target.key === 'case'
      ? 'EXISTS (SELECT 1 FROM public.assr_cases c WHERE c.id = x.assr_id AND c.company_id = $2)'
      : 'x.company_id = $2';
    const unlocked = target.lock ? ` AND (${LOCK_SQL[target.lock]}) IS NULL` : '';
    const back = await sql.unsafe(
      `UPDATE ${target.table} x SET ${set} WHERE x.${target.idCol}::text = $1 AND ${scope} AND ${still}${unlocked} RETURNING x.${target.idCol}::text AS id`,
      params);
    if (back.length === 1) written.push(p);
    else if (back.length > 1) bad(`  ${p.target} ${p.id}: ${back.length} rows matched one id`);
    note(`  ${back.length === 1 ? 'OK  ' : 'SKIP (filled or locked meanwhile)'} ${p.target} ${p.id} ${cols.join(',')}`);
  }
  note(`  written: ${written.length} of ${planned.length}`);
  await sql.end({ timeout: 5 });

  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  let wrong = 0;
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    for (const p of written) {
      const target = targets.get(p.target);
      const cols = [...new Set(target.sides.flatMap((s) => [s.postcode, s.city, ...s.states]))];
      const [row] = await check.unsafe(
        `SELECT ${cols.map((c) => `x.${c}::text AS ${c}`).join(', ')} FROM ${FROM_SQL(target)}
          WHERE x.${target.idCol}::text = $1 AND ${SCOPE_SQL(target, '$2')}`, [p.id, CO]);
      const problems = verifyWritten(p.target, p.changes, row ?? null, idx);
      if (problems.length) { wrong += 1; bad(`  ${p.target} ${p.id}: ${target.printName ? problems.join('; ') : `${problems.length} check(s) failed on ${Object.keys(p.changes).join(', ')}`}`); }
    }
    note(`  ${written.length - wrong} of ${written.length} written rows read back exactly as planned, in my_localities' shape`);
    let badRename = 0;
    for (const r of renamed) {
      const [row] = await check.unsafe(
        `SELECT p.venue, pv.id::text AS venue_id, pv.name AS venue_name
           FROM public.projects p ${PROJECT_VENUE_JOIN.replaceAll('project_venues', 'public.project_venues')}
          WHERE p.id::text = $1 AND p.company_id = $2`, [r.id, CO]);
      const ok = row && row.venue === r.to && row.venue_id != null && String(row.venue_name ?? '').trim().toLowerCase() === r.to.toLowerCase();
      if (!ok) { badRename += 1; bad(`  project ${r.id}: reads ${JSON.stringify(row ?? null)}, planned venue ${JSON.stringify(r.to)} resolving to a venue master row`); }
    }
    if (renamed.length) note(`  ${renamed.length - badRename} of ${renamed.length} renamed projects read the new venue and resolve to its venue master row`);
    wrong += badRename;
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
