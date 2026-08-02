// READ-ONLY. Owner 2026-08-02: "2990 开单的 sales 全部我都没有 park under 什么
// showroom 吗?" — for every salesperson who writes 2990 (company_2) SOs, show
// whether they are parked under a showroom (scm.staff.showroom_warehouse_id),
// what that showroom's venue_name is (scm.warehouses.venue_name), and how many
// of their live SOs carry a venue vs not.
//
// This is the ground truth behind the empty-venue rows: venue-binding resolves
// PMS-period -> showroom-parking -> NOTHING, so an unparked rep with no active
// project gets an empty venue BY DESIGN. If a rep IS parked yet some SOs are
// blank, those are backfillable; if the rep is NOT parked, blank is expected
// until they are parked on the Members page.
//
// SELECT only. No writes.
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(1); }
const sql = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 60 });
const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const pad = (s, n) => String(s ?? "").slice(0, n).padEnd(n);
const blank = (v) => v == null || String(v).trim() === "";

async function main() {
  notice("=== 2990 SALES — showroom parking + venue fill (READ-ONLY) ===");

  // Warehouses that are showrooms carry a venue_name; map id -> {code, venue}.
  const whs = await sql`SELECT id, code, name, venue_name FROM scm.warehouses`;
  const whById = new Map(whs.map((w) => [w.id, w]));
  const showrooms = whs.filter((w) => !blank(w.venue_name));
  notice(`warehouses with a venue_name (i.e. usable as a showroom venue): ${showrooms.length}`);
  for (const s of showrooms) notice(`   ${pad(s.code ?? "", 16)} venue_name = ${JSON.stringify(s.venue_name)}`);

  // Every salesperson that authored a live company_2 SO, with their parking.
  const companyId = 2;
  const reps = await sql`
    SELECT st.id, st.name, st.showroom_warehouse_id,
           COUNT(s.doc_no)::int AS so_total,
           COUNT(s.doc_no) FILTER (WHERE NOT (s.venue IS NULL OR btrim(s.venue) = ''))::int AS so_with_venue,
           COUNT(s.doc_no) FILTER (WHERE s.venue IS NULL OR btrim(s.venue) = '')::int AS so_blank_venue
      FROM scm.mfg_sales_orders s
      JOIN scm.staff st ON st.id = s.salesperson_id
     WHERE s.company_id = ${companyId}
       AND UPPER(COALESCE(s.status::text,'')) NOT IN ('CANCELLED','DRAFT')
     GROUP BY st.id, st.name, st.showroom_warehouse_id
     ORDER BY so_total DESC`;

  // SOs whose salesperson_id is NULL or not in scm.staff — can't bind at all.
  const [{ orphan }] = await sql`
    SELECT COUNT(*)::int AS orphan
      FROM scm.mfg_sales_orders s
     WHERE s.company_id = ${companyId}
       AND UPPER(COALESCE(s.status::text,'')) NOT IN ('CANCELLED','DRAFT')
       AND (s.salesperson_id IS NULL OR NOT EXISTS (SELECT 1 FROM scm.staff st WHERE st.id = s.salesperson_id))`;

  let parked = 0, unparked = 0;
  notice("");
  notice(`  ${pad("salesperson", 22)} ${pad("parked showroom", 22)} ${pad("showroom venue", 16)} SOs  w/venue  blank`);
  for (const r of reps) {
    const wh = r.showroom_warehouse_id ? whById.get(r.showroom_warehouse_id) : null;
    const parkedLabel = wh ? (wh.code ?? wh.name ?? "?") : "— NOT PARKED —";
    const venueLabel = wh ? (blank(wh.venue_name) ? "(showroom has no venue)" : wh.venue_name) : "";
    if (r.showroom_warehouse_id) parked += 1; else unparked += 1;
    notice(`  ${pad(r.name ?? r.id, 22)} ${pad(parkedLabel, 22)} ${pad(venueLabel, 16)} ${pad(r.so_total, 4)} ${pad(r.so_with_venue, 8)} ${r.so_blank_venue}`);
  }
  notice("");
  notice(`  2990 salespeople with live SOs        : ${reps.length}`);
  notice(`   - PARKED under a showroom            : ${parked}`);
  notice(`   - NOT parked under any showroom      : ${unparked}`);
  notice(`  live 2990 SOs with NO/unknown salesperson (can never bind): ${orphan}`);
  notice("");
  notice("  READING IT: a rep PARKED under a showroom whose venue_name is set should have venue on");
  notice("  ALL their SOs — any blank ones are backfillable (re-run the binding). A rep NOT parked");
  notice("  (or parked under a showroom with no venue_name) has blank venue BY DESIGN until parked");
  notice("  on the Members page. The venue was never a per-SO field the salesperson types.");
  notice("=== END — read-only, nothing written. ===");
}

main().then(() => sql.end()).catch((e) => {
  console.error("VENUE_SHOWROOM_FAIL", e?.message ?? e);
  process.exit(1);
});
