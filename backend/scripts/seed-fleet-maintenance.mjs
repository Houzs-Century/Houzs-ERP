#!/usr/bin/env node
// ----------------------------------------------------------------------------
// seed-fleet-maintenance.mjs — backfill the Phase-1 compliance VAULT
// (scm.lorry_compliance_documents, mig 0202) for the real Houzs Century fleet.
//
// BUILDS ON scm.lorries — does NOT create a parallel master. Lorries are matched
// by PLATE; the script NEVER inserts a duplicate lorry (scm.lorries is the live
// fleet master, referenced by trips + DO crew). For each matched lorry that has
// NO vault rows yet, it appends a starter set of compliance documents and syncs
// the denormalized flat expiry columns (road_tax/insurance/puspakom) on
// scm.lorries so the existing Fleet compliance strip shows them.
//
// The plates + drivers are the owner's real Driver List. Compliance dates are
// PLACEHOLDERS (computed RELATIVE TO TODAY so the demo never goes stale) that
// make the dashboard show every state on day one — the owner corrects them
// against the real documents.
//
// USAGE:
//   DATABASE_URL=postgres://…  node scripts/seed-fleet-maintenance.mjs            # DRY-RUN
//   DATABASE_URL=postgres://…  APPLY=1 node scripts/seed-fleet-maintenance.mjs    # WRITE vault for matched lorries
//   CREATE_MISSING=1 APPLY=1   node scripts/seed-fleet-maintenance.mjs            # ALSO create absent lorries (LOCAL/EMPTY envs only)
//   COMPANY_CODE=HOUZS         …                                                  # stamp vault.company_id (provenance only)
//
// IDEMPOTENT: a lorry gets vault rows only if it currently has NONE, so a second
// run adds nothing and never touches renewal history you have edited. CREATE_
// MISSING is OFF by default — in prod scm.lorries is already populated and we
// must not duplicate a plate.
// ----------------------------------------------------------------------------
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) {
  console.error("Set DATABASE_URL. Refusing to run without it.");
  process.exit(2);
}
const APPLY = process.env.APPLY === "1";
const CREATE_MISSING = process.env.CREATE_MISSING === "1";
const COMPANY_CODE = process.env.COMPANY_CODE || null;
const sql = postgres(DSN, { ssl: /localhost|127\.0\.0\.1/.test(DSN) ? false : "require", prepare: false, max: 1 });

const d = (off) => new Date(Date.now() + off * 86_400_000).toISOString().slice(0, 10);

// The real Driver List. region = warehouse CODE (matched to scm.warehouses.code
// when CREATE_MISSING mints a lorry). docs = [type, issueOff, expiryOff, costCenti, extra?].
const FLEET = [
  { plate: "VPC 9058", driver: "Faslie",        region: "KL", docs: [["ROAD_TAX", -300, 65, 145000], ["INSURANCE", -290, 88, 382000], ["PUSPAKOM", -150, 41, 6000, { result: "PASS" }], ["APAD", -320, 120, 30000]] },
  { plate: "VNB 9058", driver: "Khalid",        region: "KL", docs: [["ROAD_TAX", -358, 9, 145000], ["INSURANCE", -340, 22, 382000], ["PUSPAKOM", -120, 63, 6000, { result: "PASS" }], ["APAD", -300, 150, 30000]] },
  { plate: "VQE 9058", driver: "Yunus",         region: "KL", docs: [["ROAD_TAX", -200, 120, 145000], ["INSURANCE", -190, 150, 382000], ["PUSPAKOM", -60, 120, 6000, { result: "PASS" }]] },
  { plate: "W 1591 T", driver: "Shakti",        region: "KL", docs: [["ROAD_TAX", -280, 88, 145000], ["INSURANCE", -270, 60, 382000], ["PUSPAKOM", -110, 75, 6000, { result: "PASS" }], ["APAD", -300, 44, 30000]] },
  { plate: "MCF 3084", driver: "Teik Hua",      region: "KL", docs: [["ROAD_TAX", -300, 70, 145000], ["INSURANCE", -280, 41, 382000], ["PUSPAKOM", -140, 33, 6000, { result: "PASS" }]] },
  { plate: "NCN 6553", driver: "Vel Murugan",   region: "KL", docs: [["ROAD_TAX", -260, 44, 145000], ["INSURANCE", -250, 19, 382000], ["PUSPAKOM", -100, 52, 6000, { result: "PASS" }]] },
  { plate: "BNH 6211", driver: "Muniandy",      region: "KL", docs: [["ROAD_TAX", -200, 130, 145000], ["INSURANCE", -350, 14, 382000], ["PUSPAKOM", -80, 96, 6000, { result: "PASS" }]] },
  { plate: "BLY 8678", driver: "Shamsul Fiqri", region: "KL", docs: [["ROAD_TAX", -120, 240, 145000], ["INSURANCE", -110, 176, 382000], ["PUSPAKOM", -30, 200, 6000, { result: "PASS" }]] },
  { plate: "AKF 8100", driver: "Mohamad Basri", region: "KL", docs: [["ROAD_TAX", -360, 12, 145000], ["INSURANCE", -300, 58, 382000], ["PUSPAKOM", -20, -3, 6000, { result: "FAIL", reinspect: 11 }]] },
  { plate: "VF 7765",  driver: "Akbar Syafie",  region: "KL", docs: [["ROAD_TAX", -150, 190, 145000], ["INSURANCE", -140, 133, 382000], ["PUSPAKOM", -40, 158, 6000, { result: "PASS" }]] },
  { plate: "VGJ 1184", driver: "Edward Thomas", region: "PG", docs: [["ROAD_TAX", -330, 26, 145000], ["INSURANCE", -320, 71, 382000], ["PUSPAKOM", -90, 47, 6000, { result: "PASS" }], ["CROSS_BORDER", -300, 35, 15000]] },
  { plate: "PHG 5628", driver: "Thunai",        region: "PG", docs: [["ROAD_TAX", -300, 55, 145000], ["INSURANCE", -290, 34, 382000], ["PUSPAKOM", -130, 88, 6000, { result: "PASS" }], ["CROSS_BORDER", -280, 60, 15000]] },
  { plate: "WYS 5237", driver: "Saravanan",     region: "PG", docs: [["ROAD_TAX", -360, 33, 145000], ["INSURANCE", -350, 5, 382000], ["PUSPAKOM", -160, 110, 6000, { result: "PASS" }]] },
];

const FLAT_COL = { ROAD_TAX: "road_tax_expiry", INSURANCE: "insurance_expiry", PUSPAKOM: "puspakom_expiry" };

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
  console.log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}  create_missing=${CREATE_MISSING}  company_id=${companyId ?? "null"}  fleet=${FLEET.length}`);

  let created = 0, vaultInserted = 0, skipped = 0, missing = 0;

  for (const v of FLEET) {
    let rows = await sql`SELECT id FROM scm.lorries WHERE plate = ${v.plate}`;
    if (!rows.length) {
      if (!CREATE_MISSING) {
        console.log(`  ! ${v.plate}  not in scm.lorries — skipped (set CREATE_MISSING=1 for empty local envs)`);
        missing++;
        continue;
      }
      console.log(`  ${APPLY ? "+lorry" : "?lorry"} ${v.plate}  ${v.driver} · ${v.region}  (minting scm.lorries row)`);
      if (APPLY) {
        const wh = await sql`SELECT id FROM scm.warehouses WHERE code = ${v.region} LIMIT 1`;
        rows = await sql`
          INSERT INTO scm.lorries (plate, type, is_internal, active, warehouse_id)
          VALUES (${v.plate}, 'OTHER', true, true, ${wh.length ? wh[0].id : null})
          RETURNING id`;
        created++;
      } else {
        vaultInserted += v.docs.length;
        continue;
      }
    }
    const lorryId = rows[0].id;

    const existingDocs = await sql`SELECT count(*)::int AS n FROM scm.lorry_compliance_documents WHERE lorry_id = ${lorryId}`;
    if (existingDocs[0].n > 0) {
      console.log(`  = ${v.plate}  already has ${existingDocs[0].n} vault rows — skipped`);
      skipped++;
      continue;
    }

    console.log(`  ${APPLY ? "+vault" : "?vault"} ${v.plate}  ${v.docs.length} documents`);
    if (!APPLY) { vaultInserted += v.docs.length; continue; }

    const latestByType = {};
    for (const [type, issueOff, expiryOff, cost, extra] of v.docs) {
      const expiry = d(expiryOff);
      await sql`
        INSERT INTO scm.lorry_compliance_documents
          (company_id, lorry_id, doc_type, issue_date, expiry_date, cost_centi, owner, result, reinspection_deadline)
        VALUES
          (${companyId}, ${lorryId}, ${type}, ${d(issueOff)}, ${expiry}, ${cost}, ${"Fleet admin"},
           ${extra?.result ?? null}, ${extra?.reinspect != null ? d(extra.reinspect) : null})`;
      vaultInserted++;
      if (!latestByType[type] || expiry > latestByType[type]) latestByType[type] = expiry;
    }
    // Sync the denormalized flat expiry columns on scm.lorries.
    for (const [type, expiry] of Object.entries(latestByType)) {
      const col = FLAT_COL[type];
      if (col) await sql.unsafe(`UPDATE scm.lorries SET ${col} = $1, updated_at = now() WHERE id = $2`, [expiry, lorryId]);
    }
  }

  console.log(`\n${APPLY ? "Done" : "Would apply"}: created ${created} lorries, inserted ${vaultInserted} vault documents, skipped ${skipped}, missing ${missing}.`);
  if (missing && !CREATE_MISSING) console.log("Missing lorries must be created via the Fleet UI / POST /api/scm/lorries first, or re-run with CREATE_MISSING=1 on a local env.");
  if (!APPLY) console.log("DRY-RUN — re-run with APPLY=1 to write.");
}

main()
  .then(() => sql.end())
  .catch(async (e) => {
    console.error("seed failed:", e.message);
    await sql.end();
    process.exit(1);
  });
