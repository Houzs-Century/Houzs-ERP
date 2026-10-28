// Seeds the single system staff row the SCM auth bridge maps every Houzs caller
// to (see backend/src/scm/middleware/auth.ts). The ported 2990's routes stamp
// created_by (uuid FK -> scm.staff) and look up staff.role by user.id, so a real
// scm.staff row must exist for that uuid. /api/scm/* is owner-gated, so a single
// super_admin system identity is correct. Idempotent.
//
//   node scripts/scm-schema/seed-scm-staff.mjs
import { readFileSync } from "node:fs";
import postgres from "postgres";

const SCM_SYSTEM_STAFF_ID = "00000000-0000-4000-8000-000000000001";

const dv = readFileSync(".dev.vars", "utf8");
const url = dv.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim().replace(/^"|"$/g, "");
if (!url) { console.error("DATABASE_URL missing"); process.exit(1); }
const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 25 });

try {
  await sql`
    INSERT INTO scm.staff (id, staff_code, name, role, initials, color, active)
    VALUES (${SCM_SYSTEM_STAFF_ID}, 'HOUZS', 'Houzs ERP', 'super_admin', 'HZ', '#8a6d3b', true)
    ON CONFLICT (id) DO NOTHING
  `;
  const r = await sql`select id, staff_code, name, role from scm.staff where id = ${SCM_SYSTEM_STAFF_ID}`;
  console.log("system staff:", r.length ? JSON.stringify(r[0]) : "MISSING");
} catch (e) {
  console.error("seed failed:", String(e?.message || e).slice(0, 200));
  process.exitCode = 2;
}
await sql.end();
