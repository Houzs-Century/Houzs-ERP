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

   NOR IS THE COUNTING DONE HERE ANY MORE. resolveCarriers() and countCarrier()
   moved into lib/colour-carriers.mjs so retire-non-fabric-rows.mjs can ask the
   identical question of the identical carriers before it deactivates a row.
   This file is now the REPORT; the lib is the list and the engine both.

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
/* The carrier list AND the per-kind SQL both live in lib/colour-carriers.mjs.
   The switch used to sit in this file; retire-non-fabric-rows.mjs has to ask
   the identical question before it deactivates a row, and two copies of a
   per-kind SQL switch is the drift this directory keeps paying for. */
import { CARRIERS, resolveCarriers, countCarrier } from './lib/colour-carriers.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const CODES = (process.env.CODES || '').split(',').map((s) => s.trim()).filter(Boolean);
const VERBOSE = process.env.VERBOSE === '1';

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

async function main() {
  if (!CODES.length) { bad('set CODES="CODE-1,CODE-2"'); process.exit(2); }
  note(`census: ${CODES.length} colour code(s), company ${CO}, ${CARRIERS.length} carriers`);

  // resolve each table's shape ONCE
  const { usable, skipped } = await resolveCarriers(sql);

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
      try { [{ n }] = await countCarrier(sql, c, code, CO); }
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
