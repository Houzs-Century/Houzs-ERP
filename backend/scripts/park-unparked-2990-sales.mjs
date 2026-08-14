// Park the UNPARKED 2990 salespeople under the 2990 showroom.
//
// Owner 2026-08-02: every 2990 (company_2) sales rep should be parked under the
// 2990 showroom so their orders default to its venue. The venue-showroom check
// found one rep who authors live 2990 SOs yet has scm.staff.showroom_warehouse_id
// = NULL (Kris, the Sales Manager). This parks each such rep under the single
// flagged 2990 showroom (is_showroom = true with a venue_name).
//
// SAFE + NON-GUESSING:
//   - Targets ONLY scm.staff rows that are the salesperson on >=1 live 2990 SO
//     AND are currently unparked. It never re-parks someone already parked, and
//     never touches a rep with no 2990 sales.
//   - Requires EXACTLY ONE flagged 2990 showroom with a venue_name. If there are
//     zero or several, it prints them and writes NOTHING (the owner picks) — the
//     same "never guess a venue" rule the create path follows.
//   - Parking sets the DEFAULT venue for FUTURE orders (resolveVenueBinding at SO
//     create). It does NOT backfill existing SOs — that is
//     backfill-so-venue-by-parking.mjs, run AFTER this.
//
// Env: DATABASE_URL. APPLY=1 to write (default DRY-RUN).
//
// RE-RUN: inert. Only staff with no showroom are parked, which the write fills.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const APPLY = process.env.APPLY === "1";
const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const warn = (m) => console.log(process.env.GITHUB_ACTIONS ? `::warning::${m}` : m);
const pad = (s, n) => String(s ?? "").slice(0, n).padEnd(n);

function fromDevVars(field) {
  try { return readFileSync(".dev.vars", "utf8").match(new RegExp(`^${field}="?([^"\\n]+)"?`, "m"))?.[1]; }
  catch { return undefined; }
}
const DATABASE_URL = process.env.DATABASE_URL || fromDevVars("DATABASE_URL");
if (!DATABASE_URL) { console.error("DATABASE_URL not set. Aborting."); process.exit(1); }
const sql = postgres(DATABASE_URL, { ssl: "require", prepare: false, max: 1 });

async function main() {
  notice("=== Park UNPARKED 2990 salespeople under the 2990 showroom ===");
  notice(APPLY ? "MODE: APPLY (will COMMIT)" : "MODE: DRY-RUN (no writes)");

  const [c2990] = await sql`SELECT id FROM public.companies WHERE code = '2990'`;
  if (!c2990) { warn("No company with code '2990'. Nothing to do."); await sql.end(); return; }
  const cid = c2990.id;

  // The flagged 2990 showroom(s) that actually carry a venue_name.
  const showrooms = await sql`
    SELECT id, code, name, venue_name
      FROM scm.warehouses
     WHERE company_id = ${cid} AND (is_showroom = true OR type = 'showroom')
       AND venue_name IS NOT NULL AND btrim(venue_name) <> ''`;
  notice(`2990 flagged showrooms with a venue_name: ${showrooms.length}`);
  for (const w of showrooms) notice(`   [${w.code}] ${w.name} — venue_name="${w.venue_name}"`);
  if (showrooms.length !== 1) {
    warn(showrooms.length === 0
      ? "No flagged 2990 showroom has a venue_name. Set one in Warehouses first. Writing nothing."
      : "More than one flagged 2990 showroom has a venue_name. Ambiguous — writing nothing. Park via the Members page, or narrow this script.");
    await sql.end();
    return;
  }
  const showroom = showrooms[0];

  // Unparked staff who are the salesperson on >=1 live 2990 SO.
  const targets = await sql`
    SELECT DISTINCT st.id, st.name, st.showroom_warehouse_id,
           (SELECT COUNT(*)::int FROM scm.mfg_sales_orders s2
             WHERE s2.salesperson_id = st.id AND s2.company_id = ${cid}
               AND UPPER(COALESCE(s2.status::text,'')) NOT IN ('CANCELLED','DRAFT')) AS so_count
      FROM scm.staff st
      JOIN scm.mfg_sales_orders s ON s.salesperson_id = st.id
     WHERE s.company_id = ${cid}
       AND st.showroom_warehouse_id IS NULL
       AND UPPER(COALESCE(s.status::text,'')) NOT IN ('CANCELLED','DRAFT')
     ORDER BY st.name`;

  if (targets.length === 0) {
    notice("Every 2990 salesperson with live SOs is already parked. Nothing to do.");
    await sql.end();
    return;
  }
  notice("");
  notice(`Unparked 2990 salespeople to park under [${showroom.code}] (venue "${showroom.venue_name}"): ${targets.length}`);
  for (const t of targets) notice(`   ${pad(t.name, 24)} staff=${t.id}  (${t.so_count} live 2990 SO(s))`);
  notice("");

  if (!APPLY) {
    notice(`DRY-RUN — would set showroom_warehouse_id=${showroom.id} on ${targets.length} staff row(s). Re-run APPLY=1 to write.`);
    await sql.end();
    return;
  }

  let written = 0;
  await sql.begin(async (tx) => {
    for (const t of targets) {
      const res = await tx`
        UPDATE scm.staff SET showroom_warehouse_id = ${showroom.id}
         WHERE id = ${t.id} AND showroom_warehouse_id IS NULL`;
      written += res.count;
    }
  });
  notice(`APPLIED: parked ${written} salesperson(s) under [${showroom.code}]. Their FUTURE orders default to venue "${showroom.venue_name}".`);
  notice("Next: run backfill-so-venue-by-parking to stamp their EXISTING blank-venue SOs.");
}

main().then(() => sql.end()).catch(async (e) => {
  console.error("PARK_2990_SALES_FAIL", e?.message ?? e);
  await sql.end();
  process.exit(1);
});
