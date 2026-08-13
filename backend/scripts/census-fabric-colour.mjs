#!/usr/bin/env node
/* Count a fabric colour code in EVERY carrier that can hold it. Read-only.

   THE POINT. The fabric catalogue has been cleaned several times and has never
   come out clean, because each pass swept a handful of document arms while far
   more carriers exist and NOT ONE foreign key protects any of them (there is no FK to
   scm.fabric_colours anywhere — every reference is a bare TEXT string inside
   jsonb or inside a pipe-joined stock key). Reasoning that a merge is complete
   is exactly what has failed before. This counts instead.

   NO COUNT IS WRITTEN DOWN HERE. lib/colour-carriers.mjs IS the list, and it
   now derives its line and variant_key arms from lib/fabric-write.mjs, so the
   census and the repair cannot know different tables. The run prints its own
   carrier count on every invocation — that number, not this comment, is the
   one to quote. (It read 58 carriers, 51 of them live, on 2026-08-13.)

   HOW TO USE IT. Run it on a colour BEFORE retiring that colour, to size the
   work. Run it AGAIN after, and require every LIVE carrier to report 0. The
   second run is the proof — not a claim, a number anyone can reproduce.

     CODES="M2402-8-YELLOW,GARFIELD-1-SOFT LINEN" node scripts/census-fabric-colour.mjs

   HISTORY IS NOT DIRT. A frozen revision, an audit log and a scan sample are
   supposed to still say what they said. They are counted and shown, never
   required to be zero, and never rewritten — rewriting them would forge the
   record. Only LIVE carriers must reach zero.

   MISSING TABLES ARE REPORTED, NOT FATAL. A carrier that does not exist in the
   target database is skipped with a line saying so. Two probes have already
   died on a wrong table name and reported nothing; a census that silently
   skips is worse than one that crashes, so every skip is printed.

   Writes nothing. */
import postgres from 'postgres';
import { CARRIERS, COLOUR_KEYS, likeEscape, boundedRegex } from './lib/colour-carriers.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const CODES = (process.env.CODES || '').split(',').map((s) => s.trim()).filter(Boolean);
const VERBOSE = process.env.VERBOSE === '1';

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

/** Does this table exist, and does it have these columns? A carrier is only
 *  counted when both hold — otherwise it is SKIPPED and said out loud. */
async function shape(table) {
  const [schema, name] = table.split('.');
  const [reg] = await sql`SELECT to_regclass(${`${schema}.${name}`})::text AS t`;
  if (!reg.t) return null;
  const cols = await sql`SELECT column_name FROM information_schema.columns
                          WHERE table_schema = ${schema} AND table_name = ${name}`;
  return new Set(cols.map((r) => r.column_name));
}

/** The column a carrier reads — 'variants' or "allowed_options->'fabrics'". */
const baseCol = (c) => c.col.replace(/->.*$/, '').replace(/[^a-z_0-9].*$/i, '');

/** The supersede half of a master table. A merge sets active = false and
 *  records the absorber in the label; that row is the audit trail, not a miss.
 *  Split here rather than in the caller so the predicate travels with the
 *  carrier and no future caller can forget it. */
function activeClause(carrier, activeCol) {
  if (!activeCol) return '';                    // resolved as unsplittable upstream
  if (carrier.activeOnly) return `COALESCE(${activeCol}, true) = true AND `;
  if (carrier.supersededOnly) return `COALESCE(${activeCol}, true) = false AND `;
  return '';
}

async function countOne(carrier, code, hasCompany, activeCol = null) {
  const co = (hasCompany ? `company_id = ${CO} AND ` : '') + activeClause(carrier, activeCol);
  const esc = likeEscape(code);
  let where;
  switch (carrier.kind) {
    case 'variants':
      where = COLOUR_KEYS.map((k) => `${carrier.col}->>'${k}' = $1`).join(' OR ');
      return sql.unsafe(`SELECT COUNT(*)::int AS n FROM ${carrier.table} WHERE ${co}(${where})`, [code]);
    case 'vkey':
      return sql.unsafe(
        `SELECT COUNT(*)::int AS n FROM ${carrier.table}
          WHERE ${co}('|' || COALESCE(${carrier.col}, '') || '|') LIKE ('%|fabriccode=' || $1 || '|%') ESCAPE '\\'`,
        [likeEscape(String(code).toLowerCase())]);
    case 'text':
      return sql.unsafe(
        `SELECT COUNT(*)::int AS n FROM ${carrier.table} WHERE ${co}COALESCE(${carrier.col}, '') ~ $1`,
        [boundedRegex(code)]);
    case 'jsonarr':
      return sql.unsafe(
        `SELECT COUNT(*)::int AS n FROM ${carrier.table}
          WHERE ${co}jsonb_typeof(${carrier.col}) = 'array'
            AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(${carrier.col}) e WHERE e = $1)`,
        [code]);
    case 'col':
      return sql.unsafe(`SELECT COUNT(*)::int AS n FROM ${carrier.table} WHERE ${co}${carrier.col} = $1`, [code]);
    case 'blob':
      return sql.unsafe(
        `SELECT COUNT(*)::int AS n FROM ${carrier.table}
          WHERE ${co}COALESCE(${carrier.col}::text, '') LIKE ('%' || $1 || '%') ESCAPE '\\'`,
        [esc]);
    default:
      throw new Error(`unknown kind ${carrier.kind}`);
  }
}

async function main() {
  if (!CODES.length) { bad('set CODES="CODE-1,CODE-2"'); process.exit(2); }
  note(`census: ${CODES.length} colour code(s), company ${CO}, ${CARRIERS.length} carriers`);

  // resolve each table's shape ONCE
  const shapes = new Map();
  for (const t of new Set(CARRIERS.map((c) => c.table))) shapes.set(t, await shape(t));

  const usable = [], skipped = [];
  for (const c of CARRIERS) {
    const s = shapes.get(c.table);
    if (!s) { skipped.push({ ...c, why: 'table does not exist' }); continue; }
    const col = baseCol(c);
    if (!s.has(col)) { skipped.push({ ...c, why: `no column ${col}` }); continue; }
    /* The flag is spelled two ways in this schema. A carrier that asks to be
       split and finds NEITHER is SKIPPED out loud: counting it unsplit would
       report the same rows under both halves and read as clean. */
    const activeCol = s.has('active') ? 'active' : (s.has('is_active') ? 'is_active' : null);
    if ((c.activeOnly || c.supersededOnly) && !activeCol) {
      skipped.push({ ...c, why: 'asks for an active/superseded split, but the table has no active or is_active column' });
      continue;
    }
    usable.push({ ...c, hasCompany: s.has('company_id'), activeCol });
  }

  note(`\n=== CARRIERS ===`);
  note(`  usable:  ${usable.length}   (live ${usable.filter((c) => c.live).length}, history ${usable.filter((c) => !c.live).length})`);
  note(`  skipped: ${skipped.length}`);
  for (const s of skipped) note(`     SKIP ${String(s.table).padEnd(42)} ${s.col.padEnd(22)} — ${s.why}`);
  const noCo = usable.filter((c) => !c.hasCompany);
  if (noCo.length) {
    note(`  NOT company-scoped (counted across ALL companies — say so rather than pretend):`);
    for (const c of noCo) note(`     ${String(c.table).padEnd(42)} ${c.col}`);
  }

  let liveTotal = 0, histTotal = 0;
  for (const code of CODES) {
    note(`\n=== "${code}" ===`);
    const hits = [];
    for (const c of usable) {
      let n = 0;
      try { [{ n }] = await countOne(c, code, c.hasCompany, c.activeCol); }
      catch (e) { bad(`${c.table}.${c.col}: ${e.message}`); continue; }
      if (n > 0) hits.push({ ...c, n });
      else if (VERBOSE) note(`    0  ${c.table}.${c.col}`);
    }
    const live = hits.filter((h) => h.live), hist = hits.filter((h) => !h.live);
    liveTotal += live.reduce((a, h) => a + h.n, 0);
    histTotal += hist.reduce((a, h) => a + h.n, 0);

    if (!live.length) note(`  LIVE: clean — 0 rows in all ${usable.filter((c) => c.live).length} live carriers`);
    else {
      note(`  LIVE (must reach 0):`);
      for (const h of live.sort((a, b) => b.n - a.n)) {
        note(`    ${String(h.n).padStart(7)}  ${String(h.table).padEnd(42)} ${h.col}   [${h.kind}]`);
      }
    }
    if (hist.length) {
      note(`  HISTORY (expected — never rewritten):`);
      for (const h of hist.sort((a, b) => b.n - a.n)) {
        note(`    ${String(h.n).padStart(7)}  ${String(h.table).padEnd(42)} ${h.col}`);
      }
    }
  }

  note(`\n=== VERDICT ===`);
  note(`  live rows still naming these codes:    ${liveTotal}`);
  note(`  history rows (fine, left alone):       ${histTotal}`);
  if (liveTotal === 0) {
    note(`  CLEAN. Every live carrier reports zero.`);
  } else {
    note(`  NOT CLEAN. ${liveTotal} live row(s) still name a code that is being retired.`);
    note(`  Run this again after the migration; it must print CLEAN.`);
  }
  /* An exit code so CI can gate on it. REQUIRE_CLEAN=1 turns the census into a
     check: use it AFTER a migration, never before (before, a non-zero count is
     the whole point). */
  if (process.env.REQUIRE_CLEAN === '1' && liveTotal > 0) {
    await sql.end({ timeout: 5 });
    process.exit(1);
  }
  await sql.end({ timeout: 5 });
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
