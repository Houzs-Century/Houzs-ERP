// Seeds ~5 SAMPLE rows into scm.fabric_colours so the SO line editor's Fabrics
// colour dropdown (useFabricColoursActive → GET /api/scm/fabric-colours)
// populates. Idempotent (ON CONFLICT (fabric_id, colour_id) DO NOTHING).
//
// FK: scm.fabric_colours.fabric_id → scm.fabric_library.id (verified 2026-06-20),
// so these colours hang off the sample fabric_library row "sample-fablib-velvet"
// (seed-fabric-library.mjs MUST run first — this script also upserts that anchor
// row defensively so it can run standalone).
//
// SAMPLE markers: labels suffixed " (SAMPLE)" and colour_id prefixed "SAMPLE-"
// so the owner can spot + replace them with the real colour vocabulary. In
// 2990's fabric_colours.colour_id == fabric_trackings.fabric_code (the code the
// SO line stores); these samples use placeholder codes.
//
//   node scripts/scm-schema/seed-fabric-colours.mjs
import { readFileSync } from "node:fs";
import postgres from "postgres";

const dv = readFileSync(".dev.vars", "utf8");
const url = dv.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim().replace(/^"|"$/g, "");
if (!url) { console.error("DATABASE_URL missing in .dev.vars"); process.exit(1); }
const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 25 });

// FK anchor — must exist in scm.fabric_library before any colour row inserts.
const FABRIC_ID = "sample-fablib-velvet";
const ROWS = [
  { colourId: "SAMPLE-CHARCOAL", label: "Charcoal Grey (SAMPLE)", hex: "#36454F", sort: 1 },
  { colourId: "SAMPLE-BEIGE",    label: "Warm Beige (SAMPLE)",    hex: "#D9C4A9", sort: 2 },
  { colourId: "SAMPLE-NAVY",     label: "Midnight Navy (SAMPLE)", hex: "#1B2A4A", sort: 3 },
  { colourId: "SAMPLE-TERRA",    label: "Terracotta (SAMPLE)",    hex: "#C56B45", sort: 4 },
  { colourId: "SAMPLE-SAGE",     label: "Sage Green (SAMPLE)",    hex: "#9CAF88", sort: 5 },
];

try {
  // Defensive — ensure the FK anchor library row exists so this seed can run
  // standalone (seed-fabric-library.mjs also creates it; both are idempotent).
  await sql`
    INSERT INTO scm.fabric_library (id, label, tier, default_surcharge, active, sort_order)
    VALUES (${FABRIC_ID}, 'Velvet (SAMPLE)', 'PRICE_2', 0, true, 1)
    ON CONFLICT (id) DO NOTHING
  `;
  for (const r of ROWS) {
    await sql`
      INSERT INTO scm.fabric_colours (fabric_id, colour_id, label, swatch_hex, active, sort_order)
      VALUES (${FABRIC_ID}, ${r.colourId}, ${r.label}, ${r.hex}, true, ${r.sort})
      ON CONFLICT (fabric_id, colour_id) DO NOTHING
    `;
  }
  const n = await sql`select count(*)::int c from scm.fabric_colours where active = true`;
  console.log(`DONE — scm.fabric_colours: ${n[0].c} active rows.`);
} catch (e) {
  console.error("seed failed:", String(e?.message || e).slice(0, 300));
  process.exitCode = 2;
}
await sql.end();
