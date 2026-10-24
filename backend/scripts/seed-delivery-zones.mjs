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
// visible + editable in the admin page (Delivery Zones).
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
// MODE=plan (default) reads and reports, writes nothing. MODE=apply needs
// CONFIRM="SEED DELIVERY ZONES", inserts the missing rules, and verifies on a
// FRESH connection that every seeded company now carries all the default rules.
//
// RE-RUN: inert. Every insert is ON CONFLICT (company_id, zone, prefix_start,
// prefix_end) DO NOTHING, so a second run inserts nothing, leaves owner edits
// untouched, and the fresh-connection check simply finds the rules already there.
// ----------------------------------------------------------------------------
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) {
  console.error("Set DATABASE_URL. Refusing to run without it.");
  process.exit(2);
}
const APPLY = (process.env.MODE || "plan").toLowerCase() === "apply" || process.env.APPLY === "1";
const CONFIRM_PHRASE = "SEED DELIVERY ZONES";
const COMPANY_CODE = process.env.COMPANY_CODE || null;

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

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
const key = (co, z, s, e) => `${co}|${z}|${s}|${e}`;

async function resolveCompanies(client) {
  if (COMPANY_CODE) return client`SELECT id, code FROM companies WHERE code = ${COMPANY_CODE}`;
  return client`SELECT id, code FROM companies ORDER BY id`;
}

async function main() {
  const companies = await resolveCompanies(sql);
  note(`mode=${APPLY ? "APPLY" : "PLAN (writes nothing)"}  companies=${companies.length}  rules/company=${DEFAULT_MAP.length}`);
  if (companies.length === 0) { note("No companies matched — nothing to seed."); await sql.end({ timeout: 5 }); return; }

  // What is already there, so the plan shows exactly what each run would add.
  const existing = await sql`
    SELECT company_id::text AS company_id, zone, prefix_start, prefix_end
      FROM scm.delivery_zone_postcodes
     WHERE company_id = ANY(${companies.map((c) => c.id)})`;
  const have = new Set(existing.map((r) => key(r.company_id, r.zone, r.prefix_start, r.prefix_end)));

  note(`\n=== PLAN (per company) ===`);
  const toAdd = [];
  for (const co of companies) {
    const missing = DEFAULT_MAP.filter(([z, s, e]) => !have.has(key(String(co.id), z, s, e)));
    note(`  company ${co.code ?? co.id}: ${DEFAULT_MAP.length - missing.length} already present, ${missing.length} to add`);
    for (const [z, s, e] of missing) toAdd.push({ co, z, s, e });
  }
  note(`  total rules to add: ${toAdd.length}`);

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  note(`\n=== SEEDING ===`);
  let inserted = 0;
  for (const { co, z, s, e } of toAdd) {
    const r = await sql`
      INSERT INTO scm.delivery_zone_postcodes (company_id, zone, prefix_start, prefix_end)
      VALUES (${co.id}, ${z}, ${s}, ${e})
      ON CONFLICT (company_id, zone, prefix_start, prefix_end) DO NOTHING
      RETURNING id`;
    inserted += r.length;
  }
  note(`  inserted ${inserted} new rule(s) (existing left untouched).`);

  await sql.end({ timeout: 5 });
  const check = postgres(DSN, { ssl: /localhost|127\.0\.0\.1/.test(DSN) ? false : "require", prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    const rows = await check`
      SELECT company_id::text AS company_id, zone, prefix_start, prefix_end
        FROM scm.delivery_zone_postcodes
       WHERE company_id = ANY(${companies.map((c) => c.id)})`;
    const now = new Set(rows.map((r) => key(r.company_id, r.zone, r.prefix_start, r.prefix_end)));
    const missingAfter = [];
    for (const co of companies) {
      const miss = DEFAULT_MAP.filter(([z, s, e]) => !now.has(key(String(co.id), z, s, e)));
      note(`  company ${co.code ?? co.id}: ${DEFAULT_MAP.length - miss.length}/${DEFAULT_MAP.length} default rules present`);
      if (miss.length) missingAfter.push({ company: co.code ?? co.id, miss: miss.map(([z, s, e]) => `${z} ${s}-${e}`) });
    }
    if (missingAfter.length) {
      bad(`  still missing: ${JSON.stringify(missingAfter)}`);
      throw new Error(`${missingAfter.length} company(ies) missing default rules after seed`);
    }
    note(`  every seeded company carries all ${DEFAULT_MAP.length} default rules.`);
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
