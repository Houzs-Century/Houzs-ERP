// Read-only: why do some DOs Last Mile shows on our lorry have no Trip Pay row?
// For the DOs named in DO_NOS (default HC-DO-2611-219..226) and the trip in TRIP_NO,
// prints statuses, dates, flags and trip-stop linkage only (no names, no money,
// no addresses). SELECTs only; exits 0 for every real answer.
import postgres from "postgres";
const url = process.env.DATABASE_URL;
if (!url) { console.log("::error::DATABASE_URL is not set"); process.exit(2); }
const doNos = (process.env.DO_NOS || "HC-DO-2611-219,HC-DO-2611-220,HC-DO-2611-221,HC-DO-2611-222,HC-DO-2611-223,HC-DO-2611-224,HC-DO-2611-225,HC-DO-2611-226").split(",").map((s) => s.trim()).filter(Boolean);
const tripNo = process.env.TRIP_NO || "TRIP-2611-042";
const sql = postgres(url, { max: 1, prepare: false });
try {
  const dos = await sql`
    SELECT d.do_number, d.company_id, d.status::text AS status, LEFT(d.do_date::text, 10) AS do_date,
           LEFT((d.delivered_at::timestamptz AT TIME ZONE 'Asia/Kuala_Lumpur')::text, 16) AS delivered_myt,
           d.so_doc_no IS NOT NULL AS has_so, d.is_dropship,
           LEFT(COALESCE(so.amended_delivery_date::text, NULLIF(so.customer_delivery_date::text, '')), 10) AS so_due,
           so.company_id AS so_company,
           cr.do_id IS NOT NULL AS has_crew, cr.lorry_id IS NOT NULL AS crew_lorry_id, cr.lorry_plate AS crew_plate,
           cr.driver_1_id IS NOT NULL AS crew_d1, cr.company_id AS crew_company,
           (SELECT l.is_internal FROM scm.lorries l WHERE l.id = cr.lorry_id) AS lorry_internal,
           EXISTS (SELECT 1 FROM scm.threepl_do_charges x WHERE x.do_id = d.id) AS has_3pl,
           (SELECT count(*) FROM scm.delivery_orders o WHERE o.so_doc_no = d.so_doc_no AND o.status::text <> 'CANCELLED') AS live_dos_of_so
      FROM scm.delivery_orders d
      LEFT JOIN scm.mfg_sales_orders so ON so.doc_no = d.so_doc_no
      LEFT JOIN scm.delivery_order_crew cr ON cr.do_id = d.id
     WHERE d.do_number IN ${sql(doNos)}
     ORDER BY d.do_number`;
  console.log(`DOs found: ${dos.length} of ${doNos.length}`);
  for (const r of dos) console.log(JSON.stringify(r));
  const crew = await sql`
    SELECT d.do_number, dr.in_house AS driver_1_in_house,
           (cr.driver_1_id = (SELECT c2.driver_1_id FROM scm.delivery_order_crew c2 JOIN scm.delivery_orders d2 ON d2.id = c2.do_id WHERE d2.do_number = ${doNos[doNos.length - 1]})) AS same_driver_as_last,
           l.is_internal, l.active, to_jsonb(l) ? 'threepl_company_id' AS lorry_has_3pl_col,
           (to_jsonb(l) ->> 'threepl_company_id') IS NOT NULL AS lorry_linked_3pl
      FROM scm.delivery_orders d
      JOIN scm.delivery_order_crew cr ON cr.do_id = d.id
      LEFT JOIN scm.drivers dr ON dr.id = cr.driver_1_id
      LEFT JOIN scm.lorries l ON l.id = cr.lorry_id
     WHERE d.do_number IN ${sql(doNos)}
     ORDER BY d.do_number`;
  console.log("crew / lorry flags:");
  for (const r of crew) console.log(JSON.stringify(r));
  const stops = await sql`
    SELECT d.do_number, s.stop_no, s.stop_type::text AS stop_type, s.company_id AS stop_company,
           s.assr_case_id IS NOT NULL AS is_case, t.trip_no, t.status::text AS trip_status, LEFT(t.trip_date::text, 10) AS trip_date,
           t.is_outsourced, t.company_id AS trip_company, t.lorry_id IS NOT NULL AS trip_has_lorry
      FROM scm.trip_stops s
      JOIN scm.trips t ON t.id = s.trip_id
      JOIN scm.delivery_orders d ON d.id = s.do_id
     WHERE d.do_number IN ${sql(doNos)}
     ORDER BY d.do_number, t.trip_no`;
  console.log(`stops carrying these DOs (by do_id): ${stops.length}`);
  for (const r of stops) console.log(JSON.stringify(r));
  const trip = await sql`
    SELECT t.trip_no, t.status::text AS status, LEFT(t.trip_date::text, 10) AS trip_date, t.is_outsourced, t.company_id,
           s.stop_no, s.stop_type::text AS stop_type, s.company_id AS stop_company, s.do_id IS NOT NULL AS has_do_id,
           s.so_id IS NOT NULL AS has_so_id, s.assr_case_id IS NOT NULL AS is_case, d.do_number,
           LEFT(s.created_at::text, 16) AS stop_created
      FROM scm.trips t
      LEFT JOIN scm.trip_stops s ON s.trip_id = t.id
      LEFT JOIN scm.delivery_orders d ON d.id = s.do_id
     WHERE t.trip_no = ${tripNo}
     ORDER BY s.stop_no`;
  console.log(`${tripNo}: ${trip.length} row(s)`);
  for (const r of trip) console.log(JSON.stringify(r));
  const rows = await sql`
    SELECT r.transfer_to, r.trip_date, r.source, r.source_ref LIKE 'do:%' AS do_ref, r.removed_at IS NOT NULL AS removed,
           r.source_missing_at IS NOT NULL AS missing, r.hr_edited, r.job_type
      FROM public.hr_trip_rows r
     WHERE r.trip_month = '2026-11' AND (r.transfer_to IN ${sql(doNos)} OR r.doc_no IN (SELECT so_doc_no FROM scm.delivery_orders WHERE do_number IN ${sql(doNos)}))
     ORDER BY r.transfer_to`;
  console.log(`hr_trip_rows 2026-11 for these: ${rows.length}`);
  for (const r of rows) console.log(JSON.stringify(r));
} catch (e) {
  console.log(`::error::query failed: ${e.message}`);
  process.exitCode = 1;
} finally { await sql.end(); }
