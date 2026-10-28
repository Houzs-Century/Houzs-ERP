// Seeds ~5 SAMPLE rows into scm.fabric_library so ProductModelDetail's SOFA
// "fabrics offered" checklist (useFabricLibrary → GET /api/scm/fabric-library)
// populates. Idempotent (ON CONFLICT (id) DO NOTHING).
//
// SAMPLE markers: id prefixed "sample-" and label suffixed " (SAMPLE)" so the
// owner can spot + replace them. Columns mirror the frontend FabricLibrary shape
// (id/label/tier/default_surcharge/active/sort_order). tier is the SELLING tier
// (PRICE_1/2/3); default_surcharge is in sen.
//
//   node scripts/scm-schema/seed-fabric-library.mjs
import { readFileSync } from "node:fs";
import postgres from "postgres";

const dv = readFileSync(".dev.vars", "utf8");
const url = dv.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim().replace(/^"|"$/g, "");
if (!url) { console.error("DATABASE_URL missing in .dev.vars"); process.exit(1); }
const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 25 });

const ROWS = [
  { id: "sample-fablib-velvet",  label: "Velvet (SAMPLE)",        tier: "PRICE_2", surcharge: 0,    sort: 1 },
  { id: "sample-fablib-linen",   label: "Linen Weave (SAMPLE)",   tier: "PRICE_1", surcharge: 0,    sort: 2 },
  { id: "sample-fablib-leather", label: "Faux Leather (SAMPLE)",  tier: "PRICE_3", surcharge: 5000, sort: 3 },
  { id: "sample-fablib-chenille",label: "Chenille (SAMPLE)",      tier: "PRICE_2", surcharge: 2000, sort: 4 },
  { id: "sample-fablib-boucle",  label: "Boucle (SAMPLE)",        tier: "PRICE_3", surcharge: 8000, sort: 5 },
];

try {
  for (const r of ROWS) {
    await sql`
      INSERT INTO scm.fabric_library (id, label, tier, default_surcharge, active, sort_order)
      VALUES (${r.id}, ${r.label}, ${r.tier}, ${r.surcharge}, true, ${r.sort})
      ON CONFLICT (id) DO NOTHING
    `;
  }
  const n = await sql`select count(*)::int c from scm.fabric_library`;
  console.log(`DONE — scm.fabric_library: ${n[0].c} rows.`);
} catch (e) {
  console.error("seed failed:", String(e?.message || e).slice(0, 300));
  process.exitCode = 2;
}
await sql.end();
