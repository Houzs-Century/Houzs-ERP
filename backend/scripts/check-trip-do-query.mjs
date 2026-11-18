// Read-only: dry-runs Trip Pay's new DO query (PR #5783) on production so a wrong
// column fails here, not in Trip Pay. Prints counts and DO numbers only (no names,
// no money, no addresses). One SELECT; exits 0 for every real answer.
import postgres from "postgres";
const url = process.env.DATABASE_URL;
if (!url) { console.log("::error::DATABASE_URL is not set"); process.exit(2); }
const companyId = Number(process.env.COMPANY_ID || 1);
const first = process.env.FIRST || "2026-10-23";
const last = process.env.LAST || "2026-11-22";
const sql = postgres(url, { max: 1, prepare: false });
try {
  const dos = await sql`
    SELECT d.id::text AS do_id, d.do_number, d.so_doc_no, d.debtor_name, d.status::text AS do_status,
           LEFT(d.do_date::text, 10) AS do_date, d.local_total_sen,
           COALESCE(NULLIF(d.state, ''), d.customer_state) AS do_state, d.postcode AS do_postcode, d.is_dropship,
           EXISTS (SELECT 1 FROM scm.threepl_do_charges x WHERE x.do_id = d.id) AS has_3pl,
           EXISTS (SELECT 1 FROM scm.trip_stops s JOIN scm.trips t ON t.id = s.trip_id
                    WHERE s.do_id = d.id AND s.company_id = ${companyId} AND t.status::text <> 'CANCELLED') AS on_live_trip,
           cr.lorry_plate AS crew_plate, lm.plate AS lorry_plate, lm.is_internal AS lorry_internal,
           COALESCE(cr.driver_1_id::text, d.driver_id::text) AS d1, cr.driver_2_id::text AS d2,
           cr.helper_1_id::text AS h1, cr.helper_2_id::text AS h2,
           cr.driver_1_name AS d1_name, cr.driver_2_name AS d2_name, cr.helper_1_name AS h1_name, cr.helper_2_name AS h2_name
      FROM scm.delivery_orders d
      LEFT JOIN scm.delivery_order_crew cr ON cr.do_id = d.id
      LEFT JOIN LATERAL (
           SELECT l.plate, l.is_internal FROM scm.lorries l
            WHERE l.id = cr.lorry_id
               OR (cr.lorry_id IS NULL AND UPPER(REPLACE(l.plate, ' ', '')) = UPPER(REPLACE(cr.lorry_plate, ' ', '')))
            ORDER BY (l.id = cr.lorry_id) DESC NULLS LAST
            LIMIT 1) lm ON cr.do_id IS NOT NULL
     WHERE d.company_id = ${companyId} AND d.do_date BETWEEN ${first} AND ${last}
       AND d.status::text NOT IN ('DRAFT', 'CANCELLED')
     ORDER BY d.do_date, d.do_number`;
  const withLorry = dos.filter((d) => d.crew_plate || d.lorry_plate);
  const own = withLorry.filter((d) => d.lorry_internal !== false && !d.is_dropship && !d.has_3pl && !d.on_live_trip);
  console.log(`query OK: ${dos.length} shipped DOs in ${first}..${last}; with a crew lorry ${withLorry.length}; counted as our own runs ${own.length}`);
  console.log(`  with a driver: ${own.filter((d) => d.d1 || d.d1_name).length}; with any helper: ${own.filter((d) => d.h1 || d.h1_name).length}`);
  console.log(`  2026-11-17 sample: ${own.filter((d) => d.do_date === "2026-11-17").map((d) => d.do_number).join(", ")}`);
} catch (e) {
  console.log(`::error::query failed: ${e.message}`);
  process.exitCode = 1;
} finally { await sql.end(); }
