#!/usr/bin/env node
// ----------------------------------------------------------------------------
// seed-fleet-plans.mjs — seed a sensible DEFAULT preventive-maintenance plan set
// per lorry (scm.lorry_maintenance_plans, mig 0203) for the real Houzs fleet.
//
// BUILDS ON scm.lorries — matches lorries by PLATE, never inserts one. For each
// matched lorry that currently has NO plans, it inserts the DEFAULT_PLANS set
// below (one plan per component). Plans are seeded ONLY when a lorry has none, so
// a second run adds nothing and never touches intervals the owner has edited.
//
// The intervals are ordinary Malaysian lorry-fleet defaults (owner corrects them
// per vehicle). last_done_* is left NULL by default: a fresh plan has no service
// history, so it shows "no due date yet" until the first real service is logged
// or a mileage reading + an edit sets last_done. With SEED_LAST_DONE=1 the script
// seeds a plausible last_done relative to TODAY so a demo/local env shows live
// due-bars on day one (never in prod — real service history must be entered).
//
// USAGE:
//   DATABASE_URL=…  node scripts/seed-fleet-plans.mjs                 # DRY-RUN
//   DATABASE_URL=…  APPLY=1 node scripts/seed-fleet-plans.mjs         # WRITE plans
//   DATABASE_URL=…  APPLY=1 SEED_LAST_DONE=1 node scripts/…           # + demo last-done
//   COMPANY_CODE=HOUZS …                                             # stamp company_id (provenance)
//
// IDEMPOTENT: a lorry gets plans only if it currently has NONE. Company scope is
// provenance only (unified fleet — company_id is stamped, never used to scope).
// ----------------------------------------------------------------------------
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) {
  console.error("Set DATABASE_URL. Refusing to run without it.");
  process.exit(2);
}
const APPLY = process.env.APPLY === "1";
const SEED_LAST_DONE = process.env.SEED_LAST_DONE === "1";
const COMPANY_CODE = process.env.COMPANY_CODE || null;
const ONLY_PLATE = process.env.ONLY_PLATE || null; // seed a single plate, for testing
const sql = postgres(DSN, { ssl: /localhost|127\.0\.0\.1/.test(DSN) ? false : "require", prepare: false, max: 1 });

const d = (off) => new Date(Date.now() + off * 86_400_000).toISOString().slice(0, 10);

// The default plan set — [component, interval_km, interval_months, est_cost_sen].
// A null interval means "not tracked on that axis"; the plan is due on whichever
// of the two set intervals comes first. Demo last-done (SEED_LAST_DONE) uses
// lastDoneOffDays (days ago) + lastDoneKmBack (km before a nominal odometer) so
// the seeded fleet lands across ok / due-soon / overdue.
const DEFAULT_PLANS = [
  { component: "ENGINE_OIL",       intervalKm: 10_000,  intervalMonths: 4,  estCostSen: 45_000,  lastDoneOffDays: -110, lastDoneKmBack: 9_400 },
  { component: "OIL_FILTER",       intervalKm: 10_000,  intervalMonths: 4,  estCostSen: 8_000,   lastDoneOffDays: -110, lastDoneKmBack: 9_400 },
  { component: "GEARBOX_OIL",      intervalKm: 40_000,  intervalMonths: 24, estCostSen: 60_000,  lastDoneOffDays: -300, lastDoneKmBack: 22_000 },
  { component: "BRAKE_INSPECTION", intervalKm: 20_000,  intervalMonths: 6,  estCostSen: 12_000,  lastDoneOffDays: -160, lastDoneKmBack: 14_000 },
  { component: "BRAKE_PADS",       intervalKm: 40_000,  intervalMonths: 18, estCostSen: 55_000,  lastDoneOffDays: -260, lastDoneKmBack: 30_000 },
  { component: "TYRES",            intervalKm: 60_000,  intervalMonths: 36, estCostSen: 320_000, lastDoneOffDays: -400, lastDoneKmBack: 40_000 },
  { component: "BATTERY",          intervalKm: null,    intervalMonths: 24, estCostSen: 45_000,  lastDoneOffDays: -690, lastDoneKmBack: null },
  { component: "ALIGNMENT",        intervalKm: 20_000,  intervalMonths: 12, estCostSen: 9_000,   lastDoneOffDays: -200, lastDoneKmBack: 16_000 },
  { component: "AIRCON",           intervalKm: null,    intervalMonths: 12, estCostSen: 15_000,  lastDoneOffDays: -350, lastDoneKmBack: null },
  { component: "SUSPENSION",       intervalKm: 80_000,  intervalMonths: 36, estCostSen: 120_000, lastDoneOffDays: -420, lastDoneKmBack: 50_000 },
  { component: "COOLING_SYSTEM",   intervalKm: 60_000,  intervalMonths: 24, estCostSen: 40_000,  lastDoneOffDays: -300, lastDoneKmBack: 35_000 },
  { component: "PUSPAKOM_PREP",    intervalKm: null,    intervalMonths: 6,  estCostSen: 6_000,   lastDoneOffDays: -150, lastDoneKmBack: null },
];

// A nominal current odometer to hang demo last-done km off. Real environments
// derive current km from mileage readings; this only matters for SEED_LAST_DONE.
const NOMINAL_ODO = 180_000;

async function resolveCompanyId() {
  if (COMPANY_CODE) {
    const r = await sql`SELECT id FROM companies WHERE code = ${COMPANY_CODE}`;
    return r.length ? Number(r[0].id) : null;
  }
  const r = await sql`SELECT id FROM companies ORDER BY id`;
  return r.length === 1 ? Number(r[0].id) : null;
}

async function main() {
  const companyId = await resolveCompanyId();
  console.log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}  seed_last_done=${SEED_LAST_DONE}  company_id=${companyId ?? "null"}  plans/lorry=${DEFAULT_PLANS.length}`);

  const lorries = ONLY_PLATE
    ? await sql`SELECT id, plate FROM scm.lorries WHERE plate = ${ONLY_PLATE}`
    : await sql`SELECT id, plate FROM scm.lorries WHERE active = true ORDER BY plate`;
  console.log(`lorries to consider: ${lorries.length}`);

  let seededLorries = 0, plansInserted = 0, skipped = 0;

  for (const l of lorries) {
    const existing = await sql`SELECT count(*)::int AS n FROM scm.lorry_maintenance_plans WHERE lorry_id = ${l.id}`;
    if (existing[0].n > 0) {
      console.log(`  = ${l.plate}  already has ${existing[0].n} plans — skipped`);
      skipped++;
      continue;
    }
    console.log(`  ${APPLY ? "+plans" : "?plans"} ${l.plate}  ${DEFAULT_PLANS.length} components`);
    seededLorries++;
    if (!APPLY) { plansInserted += DEFAULT_PLANS.length; continue; }

    for (const p of DEFAULT_PLANS) {
      const lastDoneDate = SEED_LAST_DONE ? d(p.lastDoneOffDays) : null;
      const lastDoneKm = SEED_LAST_DONE && p.lastDoneKmBack != null ? NOMINAL_ODO - p.lastDoneKmBack : null;
      await sql`
        INSERT INTO scm.lorry_maintenance_plans
          (company_id, lorry_id, component, interval_km, interval_months, last_done_date, last_done_km, est_cost_sen, active)
        VALUES
          (${companyId}, ${l.id}, ${p.component}, ${p.intervalKm}, ${p.intervalMonths},
           ${lastDoneDate}, ${lastDoneKm}, ${p.estCostSen}, true)
        ON CONFLICT (lorry_id, component) DO NOTHING`;
      plansInserted++;
    }
  }

  console.log(`\n${APPLY ? "Done" : "Would apply"}: seeded ${seededLorries} lorries, inserted ${plansInserted} plans, skipped ${skipped}.`);
  if (!APPLY) console.log("DRY-RUN — re-run with APPLY=1 to write. Add SEED_LAST_DONE=1 on a demo/local env for live due-bars.");
}

main()
  .then(() => sql.end())
  .catch(async (e) => {
    console.error("seed failed:", e.message);
    await sql.end();
    process.exit(1);
  });
