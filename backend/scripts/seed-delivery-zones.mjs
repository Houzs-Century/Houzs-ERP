#!/usr/bin/env node
// ----------------------------------------------------------------------------
// seed-delivery-zones.mjs — install the DEFAULT Malaysian postcode -> zone map
// (scm.delivery_zone_postcodes, mig 0205) for every active company.
//
// WHY A SCRIPT, NOT A MIGRATION. Repo rule: seed / default rows that the owner
// then edits belong in a one-shot script, not a numbered migration (numbered
// migrations run in prod forever and a later cleanup migration is the cost).
// The table ships EMPTY from 0205; until this runs (or the owner customises),
// zone-classify.ts falls back to the same in-code DEFAULT_ZONE_PREFIX_MAP, so
// classification works with or without the rows — the rows just make the map
// visible + editable in the admin page.
//
// SOURCE OF TRUTH for these ranges is backend/src/scm/lib/zone-classify.ts
// (DEFAULT_ZONE_PREFIX_MAP). They are inlined here because a .mjs seed cannot
// import the .ts lib; keep the two in sync when the default map changes.
//
// IDEMPOTENT: ON CONFLICT (company_id, zone, prefix_start, prefix_end) DO
// NOTHING, so a second run adds nothing and never overwrites an owner edit.
// PUCHONG is intentionally absent (Puchong postcodes sit in the 47 = PJ range);
// the owner carves it out in the editor when they want it as its own cluster.
//
// USAGE:
//   DATABASE_URL=…  node scripts/seed-delivery-zones.mjs             # DRY-RUN
//   DATABASE_URL=…  APPLY=1 node scripts/seed-delivery-zones.mjs     # WRITE rows
//   COMPANY_CODE=HOUZS APPLY=1 node scripts/seed-delivery-zones.mjs  # one company
// ----------------------------------------------------------------------------
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) {
  console.error("Set DATABASE_URL. Refusing to run without it.");
  process.exit(2);
}
const APPLY = process.env.APPLY === "1";
const COMPANY_CODE = process.env.COMPANY_CODE || null;
const sql = postgres(DSN, { ssl: /localhost|127\.0\.0\.1/.test(DSN) ? false : "require", prepare: false, max: 1 });

// [zone, prefixStart, prefixEnd] — mirror of DEFAULT_ZONE_PREFIX_MAP.
const DEFAULT_MAP = [
  ["KEDAH", 5, 9],
  ["PENANG", 10, 14],
  ["PERAK", 30, 36],
  ["EAST", 15, 24],
  ["PAHANG", 25, 28],
  ["PAHANG", 39, 39],
  ["PAHANG", 49, 49],
  ["PAHANG", 69, 69],
  ["PJ", 40, 40],
  ["KLANG", 41, 42],
  ["KAJANG", 43, 43],
  ["PJ", 46, 47],
  ["RAWANG", 48, 48],
  ["KL", 50, 60],
  ["KL", 68, 68],
  ["NS", 70, 73],
  ["MELAKA", 75, 78],
  ["JOHOR", 79, 86],
];

async function resolveCompanies() {
  if (COMPANY_CODE) {
    return sql`SELECT id, code FROM companies WHERE code = ${COMPANY_CODE}`;
  }
  // Active companies (fall back to all if there is no active flag).
  return sql`SELECT id, code FROM companies ORDER BY id`;
}

async function main() {
  const companies = await resolveCompanies();
  console.log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}  companies=${companies.length}  rules/company=${DEFAULT_MAP.length}`);
  if (companies.length === 0) {
    console.log("No companies matched — nothing to seed.");
    return;
  }

  let inserted = 0;
  for (const co of companies) {
    for (const [zone, start, end] of DEFAULT_MAP) {
      if (!APPLY) {
        console.log(`  [dry] company ${co.code ?? co.id}: ${zone} ${String(start).padStart(2, "0")}-${String(end).padStart(2, "0")}`);
        continue;
      }
      const r = await sql`
        INSERT INTO scm.delivery_zone_postcodes (company_id, zone, prefix_start, prefix_end)
        VALUES (${co.id}, ${zone}, ${start}, ${end})
        ON CONFLICT (company_id, zone, prefix_start, prefix_end) DO NOTHING
        RETURNING id`;
      inserted += r.length;
    }
  }
  console.log(APPLY ? `Done. Inserted ${inserted} new rule(s) (existing left untouched).` : "Dry run — pass APPLY=1 to write.");
}

main()
  .then(() => sql.end())
  .catch((e) => { console.error(e); sql.end(); process.exit(1); });
