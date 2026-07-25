#!/usr/bin/env node
// ----------------------------------------------------------------------------
// seed-fleet-maintenance.mjs — load the real Houzs Century lorry fleet + a
// starter compliance vault into the Phase-1 Fleet Maintenance tables
// (fleet_vehicles + fleet_compliance_documents, migration 0200).
//
// WHY A SCRIPT, NOT A MIGRATION: numbered migrations run in prod on every
// deploy; demo/real seed data in one leaves every environment paying a
// seed-then-cleanup cost forever (mig 067/069/079 precedent). This is a
// one-shot the owner runs manually and then edits in the UI.
//
// The plates + drivers are the owner's real Driver List. Regions (KL / PG) and
// all compliance dates are PLACEHOLDERS chosen to make the dashboard show every
// state (available / service-due / compliance-blocked / out-of-service) on day
// one — the owner corrects them against the real documents. Compliance dates
// are computed RELATIVE TO TODAY so the demo never goes stale.
//
// USAGE:
//   DATABASE_URL=postgres://…  node scripts/seed-fleet-maintenance.mjs           # DRY-RUN
//   DATABASE_URL=postgres://…  APPLY=1 node scripts/seed-fleet-maintenance.mjs   # WRITE
//   COMPANY_CODE=HOUZS  APPLY=1 node scripts/seed-fleet-maintenance.mjs          # pick company
//
// IDEMPOTENT: a vehicle is inserted only if its (company_id, plate) is absent;
// compliance rows are appended only for vehicles this run just created, so a
// second run adds nothing and never touches renewal history you have edited.
// ----------------------------------------------------------------------------
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) {
  console.error("Set DATABASE_URL (the local/pooler connection string). Refusing to run without it.");
  process.exit(2);
}
const APPLY = process.env.APPLY === "1";
const COMPANY_CODE = process.env.COMPANY_CODE || null;
const sql = postgres(DSN, { ssl: /localhost|127\.0\.0\.1/.test(DSN) ? false : "require", prepare: false, max: 1 });

// days-from-today -> YYYY-MM-DD (UTC calendar date).
function d(offsetDays) {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

// The real Driver List. mileage/nextServiceKm/oos are placeholder ops facts;
// docs are [type, issueOffsetDays, expiryOffsetDays, costCenti, extra?].
const FLEET = [
  { plate: "VPC 9058", driver: "Faslie",         region: "KL", km: 184203, nextKm: 190000, docs: [["ROAD_TAX", -300, 65, 145000], ["INSURANCE", -290, 88, 382000], ["PUSPAKOM", -150, 41, 6000, { result: "PASS" }], ["APAD", -320, 120, 30000]] },
  { plate: "VNB 9058", driver: "Khalid",         region: "KL", km: 207880, nextKm: 208500, docs: [["ROAD_TAX", -358, 9, 145000], ["INSURANCE", -340, 22, 382000], ["PUSPAKOM", -120, 63, 6000, { result: "PASS" }], ["APAD", -300, 150, 30000]] },
  { plate: "VQE 9058", driver: "Yunus",          region: "KL", km: 98120,  nextKm: 110000, docs: [["ROAD_TAX", -200, 120, 145000], ["INSURANCE", -190, 150, 382000], ["PUSPAKOM", -60, 120, 6000, { result: "PASS" }]] },
  { plate: "W 1591 T", driver: "Shakti",         region: "KL", km: 263540, nextKm: 265000, docs: [["ROAD_TAX", -280, 88, 145000], ["INSURANCE", -270, 60, 382000], ["PUSPAKOM", -110, 75, 6000, { result: "PASS" }], ["APAD", -300, 44, 30000]] },
  { plate: "MCF 3084", driver: "Teik Hua",       region: "KL", km: 151002, nextKm: 152000, docs: [["ROAD_TAX", -300, 70, 145000], ["INSURANCE", -280, 41, 382000], ["PUSPAKOM", -140, 33, 6000, { result: "PASS" }]] },
  { plate: "NCN 6553", driver: "Vel Murugan",    region: "KL", km: 221450, nextKm: 230000, docs: [["ROAD_TAX", -260, 44, 145000], ["INSURANCE", -250, 19, 382000], ["PUSPAKOM", -100, 52, 6000, { result: "PASS" }]] },
  { plate: "BNH 6211", driver: "Muniandy",       region: "KL", km: 132770, nextKm: 140000, docs: [["ROAD_TAX", -200, 130, 145000], ["INSURANCE", -350, 14, 382000], ["PUSPAKOM", -80, 96, 6000, { result: "PASS" }]] },
  { plate: "BLY 8678", driver: "Shamsul Fiqri",  region: "KL", km: 77410,  nextKm: 90000,  docs: [["ROAD_TAX", -120, 240, 145000], ["INSURANCE", -110, 176, 382000], ["PUSPAKOM", -30, 200, 6000, { result: "PASS" }]] },
  { plate: "AKF 8100", driver: "Mohamad Basri",  region: "KL", km: 169300, nextKm: 175000, docs: [["ROAD_TAX", -360, 12, 145000], ["INSURANCE", -300, 58, 382000], ["PUSPAKOM", -20, -3, 6000, { result: "FAIL", reinspect: 11 }]] },
  { plate: "VF 7765",  driver: "Akbar Syafie",   region: "KL", km: 44210,  nextKm: 55000,  docs: [["ROAD_TAX", -150, 190, 145000], ["INSURANCE", -140, 133, 382000], ["PUSPAKOM", -40, 158, 6000, { result: "PASS" }]] },
  { plate: "VGJ 1184", driver: "Edward Thomas",  region: "PG", km: 118990, nextKm: 125000, docs: [["ROAD_TAX", -330, 26, 145000], ["INSURANCE", -320, 71, 382000], ["PUSPAKOM", -90, 47, 6000, { result: "PASS" }], ["CROSS_BORDER", -300, 35, 15000]] },
  { plate: "PHG 5628", driver: "Thunai",         region: "PG", km: 243110, nextKm: 243500, docs: [["ROAD_TAX", -300, 55, 145000], ["INSURANCE", -290, 34, 382000], ["PUSPAKOM", -130, 88, 6000, { result: "PASS" }], ["CROSS_BORDER", -280, 60, 15000]] },
  { plate: "WYS 5237", driver: "Saravanan",      region: "PG", km: 301220, nextKm: 305000, oos: "Retired pending sale", docs: [["ROAD_TAX", -360, 33, 145000], ["INSURANCE", -350, 5, 382000], ["PUSPAKOM", -160, 110, 6000, { result: "PASS" }]] },
];

async function resolveCompanyId() {
  if (COMPANY_CODE) {
    const rows = await sql`SELECT id, code FROM companies WHERE code = ${COMPANY_CODE}`;
    if (!rows.length) throw new Error(`No company with code ${COMPANY_CODE}`);
    return Number(rows[0].id);
  }
  const rows = await sql`SELECT id, code FROM companies ORDER BY id`;
  if (rows.length === 0) throw new Error("No companies found.");
  if (rows.length > 1) {
    throw new Error(`Multiple companies (${rows.map((r) => r.code).join(", ")}). Set COMPANY_CODE to choose one.`);
  }
  return Number(rows[0].id);
}

async function main() {
  const companyId = await resolveCompanyId();
  console.log(`company_id=${companyId}  mode=${APPLY ? "APPLY" : "DRY-RUN"}  fleet=${FLEET.length}`);

  let vehiclesInserted = 0;
  let docsInserted = 0;

  for (const v of FLEET) {
    const existing = await sql`SELECT id FROM fleet_vehicles WHERE company_id = ${companyId} AND plate = ${v.plate}`;
    if (existing.length) {
      console.log(`  = ${v.plate}  already present (id=${existing[0].id}) — skipped`);
      continue;
    }
    console.log(`  ${APPLY ? "+" : "?"} ${v.plate}  ${v.driver} · ${v.region}${v.oos ? "  [OUT OF SERVICE]" : ""}  docs=${v.docs.length}`);
    if (!APPLY) {
      vehiclesInserted++;
      docsInserted += v.docs.length;
      continue;
    }

    const [row] = await sql`
      INSERT INTO fleet_vehicles
        (company_id, plate, region, driver_name, vehicle_type, current_mileage_km, next_service_km, out_of_service, out_of_service_reason)
      VALUES
        (${companyId}, ${v.plate}, ${v.region}, ${v.driver}, ${"LORRY"}, ${v.km}, ${v.nextKm}, ${!!v.oos}, ${v.oos ?? null})
      RETURNING id`;
    const vehicleId = Number(row.id);
    vehiclesInserted++;

    for (const [type, issueOff, expiryOff, cost, extra] of v.docs) {
      await sql`
        INSERT INTO fleet_compliance_documents
          (company_id, vehicle_id, doc_type, document_ref, issue_date, expiry_date, cost_centi, owner, result, reinspection_deadline)
        VALUES
          (${companyId}, ${vehicleId}, ${type}, ${null}, ${d(issueOff)}, ${d(expiryOff)}, ${cost}, ${"Fleet admin"},
           ${extra?.result ?? null}, ${extra?.reinspect != null ? d(extra.reinspect) : null})`;
      docsInserted++;
    }
  }

  console.log(`\n${APPLY ? "Inserted" : "Would insert"}: ${vehiclesInserted} vehicles, ${docsInserted} compliance documents.`);
  if (!APPLY) console.log("DRY-RUN — re-run with APPLY=1 to write.");
}

main()
  .then(() => sql.end())
  .catch(async (e) => {
    console.error("seed failed:", e.message);
    await sql.end();
    process.exit(1);
  });
