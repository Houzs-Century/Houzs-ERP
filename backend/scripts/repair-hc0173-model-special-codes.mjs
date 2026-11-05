// Point the Model specials pools at the Hydraulic add-on that is live (HC-0173).
//
// Sim, 2026-10-28: a CELENE (A) bedframe line on a new sales order offers no
// Hydraulic under Special Orders, though Maintenance lists HYDRAULIC as Active.
// On 2026-10-02 the add-on was re-keyed: a new HYDRAULIC row was added and the
// old Hydraulic row switched off. A Model's allowed_options.specials pool names
// add-on CODES, and the SO line editor and the server gate (allowed-options-
// check) both match them exactly, case included. 113 of the 116 bedframe Models
// with a ticked pool still name the old Hydraulic, so the line editor offers the
// inactive code nothing and filters the live one out.
//
// WHAT THIS DOES: in every Model pool that names FROM, FROM becomes TO in the
// same place (a pool that already names TO just loses FROM). Nothing else in
// allowed_options moves. Sales / purchase lines that already carry FROM are not
// touched: allowed-options-check only judges specials a line newly picks.
//
// REFUSES the run when FROM is still active or TO is missing / inactive, and
// leaves out (and names) a Model whose category TO is not offered for.
//
//   DATABASE_URL   required
//   MODE           plan (default) | apply
//   CONFIRM        required on apply: HC0173-MODEL-SPECIAL-CODES
//   COMPANY_ID     default 1 (2 = 2990)
//   FROM / TO      default Hydraulic / HYDRAULIC
//
// RE-RUN: idempotent. A pool that no longer names FROM is not read again.
import postgres from 'postgres';
import { readAddons, readModels, planModels, writeModels, readPools } from './lib/hc0173-model-special-sql.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('DATABASE_URL required'); process.exit(2); }
const MODE = (process.env.MODE ?? 'plan').toLowerCase();
const APPLY = MODE === 'apply';
const CONFIRM_PHRASE = 'HC0173-MODEL-SPECIAL-CODES';
const CO = Number(process.env.COMPANY_ID ?? 1);
const FROM = process.env.FROM ?? 'Hydraulic';
const TO = process.env.TO ?? 'HYDRAULIC';
const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply needs CONFIRM=${CONFIRM_PHRASE}`);
  process.exit(2);
}
if (FROM === TO) { console.error('FROM and TO are the same code'); process.exit(2); }

async function main() {
  const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  log(`mode=${MODE} company=${CO} "${FROM}" -> "${TO}"`);

  const { addons, models } = await sql.begin('read only', async (tx) => ({
    addons: await readAddons(tx, CO, [FROM, TO]),
    models: await readModels(tx, CO, FROM),
  }));
  const fromRow = addons.find((a) => a.code === FROM);
  const toRow = addons.find((a) => a.code === TO);
  if (fromRow?.active) { bad(`"${FROM}" is still an active add-on; a Model ticking it is not stranded`); await sql.end(); process.exit(1); }
  if (!toRow) { bad(`"${TO}" is not an add-on in company ${CO}`); await sql.end(); process.exit(1); }
  if (!toRow.active) { bad(`"${TO}" is not active; moving pools onto it strands them again`); await sql.end(); process.exit(1); }

  const { work, refused } = planModels(models, FROM, TO, toRow.categories);
  log('');
  log(`add-on "${FROM}": ${fromRow ? 'inactive' : 'no row'}   "${TO}": active, ${(toRow.categories ?? []).join(', ')}`);
  log(`MODELS: ${work.length} pool(s) name "${FROM}" -> "${TO}"${work.some((m) => m.hadTo) ? ` (${work.filter((m) => m.hadTo).length} already name "${TO}" and only lose "${FROM}")` : ''}.`);
  for (const m of work) log(`  ${m.category.padEnd(10)} ${String(m.model_code).padEnd(34)} ${m.active === false ? '[inactive] ' : ''}${m.name}`);
  if (refused.length) {
    log('');
    log(`LEFT ALONE: ${refused.length} Model(s).`);
    for (const m of refused) log(`  ${m.category.padEnd(10)} ${m.model_code}  - ${m.why}`);
  }

  if (!APPLY || work.length === 0) {
    log('');
    log(work.length ? `PLAN ONLY - set MODE=apply CONFIRM=${CONFIRM_PHRASE} to write.` : 'Nothing to change.');
    await sql.end();
    return;
  }

  const ids = work.map((m) => m.id);
  const written = await sql.begin((tx) => writeModels(tx, CO, ids, FROM, TO));
  await sql.end();
  log('');
  log(`WRITTEN: ${written.length} of ${work.length} Model pool(s).`);

  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  const after = await readPools(check, CO, ids);
  await check.end();
  const byId = new Map(after.map((r) => [String(r.id), r.specials]));
  const wrong = work.filter((m) => {
    const got = byId.get(String(m.id));
    return !Array.isArray(got) || got.some((s) => typeof s !== 'string') || JSON.stringify(got) !== JSON.stringify(m.next);
  });
  log(`VERIFY (fresh connection): ${wrong.length} of ${work.length} pool(s) differ from the planned list.`);
  if (wrong.length) {
    for (const m of wrong) bad(`${m.model_code}: expected ${JSON.stringify(m.next)} got ${JSON.stringify(byId.get(String(m.id)) ?? null)}`);
    process.exit(1);
  }
  log(`OK - every planned pool names "${TO}" in place of "${FROM}".`);
}

await main();
