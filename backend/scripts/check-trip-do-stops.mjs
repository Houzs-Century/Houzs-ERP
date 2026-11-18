// Read-only: why Trip Pay's Delivery Planning read finds no DO deliveries for a
// trip month. Counts the month's trip stops by stop type, company stamps and DO
// link, for our own (not outsourced, not cancelled) runs. Counts only; no names,
// no money, no addresses. One SELECT; exits 0 for every real answer.
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) { console.log("::error::DATABASE_URL is not set"); process.exit(2); }
const FIRST = process.env.FIRST || "2026-10-23";
const LAST = process.env.LAST || "2026-11-22";
const sql = postgres(url, { max: 1, prepare: false });
try {
  const rows = await sql`
    SELECT s.stop_type::text AS stop_type,
           t.company_id AS trip_co, s.company_id AS stop_co,
           (s.do_id IS NOT NULL) AS has_do, (s.assr_case_id IS NOT NULL) AS has_case,
           t.is_outsourced, t.status::text AS trip_status,
           count(*)::int AS n
      FROM scm.trip_stops s
      JOIN scm.trips t ON t.id = s.trip_id
     WHERE t.trip_date BETWEEN ${FIRST} AND ${LAST}
     GROUP BY 1,2,3,4,5,6,7
     ORDER BY 1,2,3`;
  console.log(`trip stops ${FIRST}..${LAST} by type / trip company / stop company / has DO / has case / outsourced / trip status`);
  for (const r of rows) console.log(`  ${r.stop_type} | trip_co=${r.trip_co} | stop_co=${r.stop_co} | do=${r.has_do} | case=${r.has_case} | outsourced=${r.is_outsourced} | ${r.trip_status} | ${r.n}`);
} catch (e) {
  console.log(`::error::${e.message}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
