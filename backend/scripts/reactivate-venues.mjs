#!/usr/bin/env node
// Reactivate the deactivated project venues so the 30 imported orders that
// reference them show their venue in the Edit dropdown again (owner 2026-08-09:
// "active 回来那个venue"). EAST COAST MALL and DATARAN CENTRIO exist in
// public.project_venues but were switched inactive, which blanks the picker.
// DRY-RUN by default; APPLY=1 to write.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

const TARGETS = ["EAST COAST MALL", "DATARAN CENTRIO"];

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  const cols = await sql`SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'project_venues' ORDER BY ordinal_position`;
  log(`project_venues columns: ${cols.map((c) => `${c.column_name}(${c.data_type})`).join(", ")}`);
  const names = cols.map((c) => c.column_name);
  const nameCol = ["name", "venue_name", "venue", "label", "title"].find((c) => names.includes(c));
  const actCol = ["active", "is_active", "enabled", "is_enabled"].find((c) => names.includes(c));
  if (!nameCol || !actCol) { console.error("could not identify name/active columns"); process.exit(1); }
  const actType = cols.find((c) => c.column_name === actCol).data_type;
  const onVal = /bool/i.test(actType) ? "true" : "1";

  const pats = TARGETS.map((t) => `%${t}%`);
  const rows = await sql.unsafe(
    `SELECT id, ${nameCol} AS name, ${actCol} AS active FROM public.project_venues
     WHERE upper(${nameCol}) LIKE ANY($1) ORDER BY ${nameCol}`, [pats]);
  for (const r of rows) log(`  id=${r.id}  "${r.name}"  active=${r.active}`);
  const toFix = rows.filter((r) => r.active === false || r.active === 0 || r.active === "0");
  log(`inactive matches to reactivate: ${toFix.length}`);

  if (!APPLY) { log("DRY-RUN — set APPLY=1 to write."); await sql.end(); return; }
  for (const r of toFix) {
    await sql.unsafe(`UPDATE public.project_venues SET ${actCol} = ${onVal} WHERE id = $1`, [r.id]);
    log(`  reactivated id=${r.id} "${r.name}"`);
  }
  const after = await sql.unsafe(
    `SELECT id, ${nameCol} AS name, ${actCol} AS active FROM public.project_venues
     WHERE upper(${nameCol}) LIKE ANY($1) ORDER BY ${nameCol}`, [pats]);
  for (const r of after) log(`  now: id=${r.id} "${r.name}" active=${r.active}`);
  log(`DONE. reactivated ${toFix.length} venues`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
