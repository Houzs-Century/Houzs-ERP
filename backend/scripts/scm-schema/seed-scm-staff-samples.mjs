// Seeds 2-3 SAMPLE salesperson rows into scm.staff so the SO New page's
// SALESPERSON dropdown (useStaff → GET /api/scm/staff) populates. Idempotent
// (ON CONFLICT (id) DO NOTHING). The existing system-staff uuid row
// (00000000-0000-4000-8000-000000000001, role super_admin) is left UNTOUCHED —
// these inserts use distinct fixed uuids.
//
// SAMPLE markers: staff_code prefixed "SP-SAMPLE-" and name suffixed
// " (SAMPLE)" so the owner can spot + replace them with real salespeople.
//
//   node scripts/scm-schema/seed-scm-staff-samples.mjs
import { readFileSync } from "node:fs";
import postgres from "postgres";

const dv = readFileSync(".dev.vars", "utf8");
const url = dv.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim().replace(/^"|"$/g, "");
if (!url) { console.error("DATABASE_URL missing in .dev.vars"); process.exit(1); }
const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 25 });

// Fixed uuids so re-runs are idempotent. role 'sales' is a valid scm staff_role
// enum member (verified 2026-06-20).
const ROWS = [
  { id: "00000000-0000-4000-8000-0000000000a1", code: "SP-SAMPLE-001", name: " Amir Salesperson (SAMPLE)", initials: "AS", color: "#2563eb" },
  { id: "00000000-0000-4000-8000-0000000000a2", code: "SP-SAMPLE-002", name: "Bee Lin Salesperson (SAMPLE)", initials: "BL", color: "#16a34a" },
  { id: "00000000-0000-4000-8000-0000000000a3", code: "SP-SAMPLE-003", name: "Chong Wei Salesperson (SAMPLE)", initials: "CW", color: "#db2777" },
];

try {
  for (const r of ROWS) {
    await sql`
      INSERT INTO scm.staff (id, staff_code, name, role, initials, color, active)
      VALUES (${r.id}, ${r.code}, ${r.name}, 'sales', ${r.initials}, ${r.color}, true)
      ON CONFLICT (id) DO NOTHING
    `;
  }
  const n = await sql`select count(*)::int c from scm.staff where role = 'sales'`;
  const total = await sql`select count(*)::int c from scm.staff`;
  console.log(`DONE — scm.staff: ${n[0].c} sales rows, ${total[0].c} total (system row untouched).`);
} catch (e) {
  console.error("seed failed:", String(e?.message || e).slice(0, 300));
  process.exitCode = 2;
}
await sql.end();
