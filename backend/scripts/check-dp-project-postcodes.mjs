// Read-only: which projects reach Delivery Planning (a Setup or Dismantle from
// FROM onwards) but have no postcode for their venue, so Last Mile and the map
// can only guess the address. Venue / project names are public event places;
// no people, no money. One SELECT; exits 0 for every real answer.
import postgres from "postgres";
const url = process.env.DATABASE_URL;
if (!url) { console.log("::error::DATABASE_URL is not set"); process.exit(2); }
const from = process.env.FROM || "2026-10-01";
const sql = postgres(url, { max: 1, prepare: false });
try {
  const rows = await sql`
    SELECT p.company_id, p.code, p.venue, p.state AS project_state,
           LEFT(p.setup_start_at, 10) AS setup, LEFT(p.dismantle_start_at, 10) AS dismantle,
           v.id AS venue_id, v.postcode, v.state AS venue_state
      FROM public.projects p
      LEFT JOIN LATERAL (
           SELECT pv.id, pv.postcode, pv.state FROM public.project_venues pv
            WHERE pv.company_id = p.company_id AND UPPER(TRIM(pv.name)) = UPPER(TRIM(p.venue))
            ORDER BY pv.id LIMIT 1) v ON TRUE
     WHERE p.archived_at IS NULL
       AND (LEFT(p.setup_start_at, 10) >= ${from} OR LEFT(p.dismantle_start_at, 10) >= ${from})
     ORDER BY COALESCE(LEFT(p.setup_start_at, 10), LEFT(p.dismantle_start_at, 10))`;
  const ok = rows.filter((r) => r.postcode);
  const noVenue = rows.filter((r) => !r.venue_id);
  const noPc = rows.filter((r) => r.venue_id && !r.postcode);
  console.log(`projects with Setup/Dismantle from ${from}: ${rows.length}; venue has postcode: ${ok.length}; venue in master but no postcode: ${noPc.length}; venue name not in the venue master: ${noVenue.length}`);
  for (const r of noPc) console.log(`  NO POSTCODE   co=${r.company_id} ${r.code ?? "-"} | ${r.venue ?? "-"} | setup ${r.setup ?? "-"} dismantle ${r.dismantle ?? "-"}`);
  for (const r of noVenue) console.log(`  NOT IN MASTER co=${r.company_id} ${r.code ?? "-"} | ${r.venue ?? "(no venue)"} | setup ${r.setup ?? "-"} dismantle ${r.dismantle ?? "-"}`);
} catch (e) {
  console.log(`::error::query failed: ${e.message}`);
  process.exitCode = 1;
} finally { await sql.end(); }
