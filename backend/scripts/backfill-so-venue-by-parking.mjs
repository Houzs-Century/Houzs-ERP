// Backfill blank SO venues FROM THE SALESPERSON'S SHOWROOM PARKING.
//
// venue-binding's iron rule: the venue is the rep's binding (PMS-period ->
// showroom parking -> NOTHING), and it is stamped at SO CREATE. An SO raised
// BEFORE its salesperson was parked keeps a blank venue forever — nothing
// re-runs the binding on an existing order. Owner 2026-08-02 parked the 2990
// Sales-department reps; this stamps the venue their parking now implies onto
// their EXISTING blank-venue SOs.
//
// PARKING-AWARE, NOT A BLANKET STAMP. It resolves each blank SO's venue from
// ITS OWN salesperson's showroom (scm.staff.showroom_warehouse_id ->
// scm.warehouses.venue_name). A rep who is NOT parked, or parked under a
// showroom with no venue_name, leaves the SO blank — the same "never guess a
// venue" rule the create path and backfill-2990-so-venue follow. This is the
// difference from the blanket tool: it will not attribute an unparked manager's
// (Kris's) orders to a venue he is not bound to.
//
// It does NOT touch a PMS/MANUAL venue — only rows whose venue is blank. It
// writes venue (legacy text) + venue_source='SHOWROOM'. No PMS re-resolution:
// a rep on an exhibition during the SO's date is a rarer case the owner can
// correct per-order; this closes the common showroom case without guessing.
//
// Env: DATABASE_URL. APPLY=1 to write (default DRY-RUN). Read-then-write; the
// dry-run lists every SO it would stamp, grouped by rep.
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
  notice("=== Backfill blank SO venue FROM the salesperson's showroom parking ===");
  notice(APPLY ? "MODE: APPLY (will COMMIT)" : "MODE: DRY-RUN (no writes)");

  // Every blank-venue SO whose salesperson is parked under a showroom that
  // actually carries a venue_name. NOT company-restricted in SQL — a parked rep
  // in any company is valid — but in practice this is the 2990 set today.
  const rows = await sql`
    SELECT s.doc_no, s.company_id, s.so_date,
           st.name AS rep_name, w.code AS showroom_code, w.venue_name
      FROM scm.mfg_sales_orders s
      JOIN scm.staff st ON st.id = s.salesperson_id
      JOIN scm.warehouses w ON w.id = st.showroom_warehouse_id
     WHERE (s.venue IS NULL OR btrim(s.venue) = '')
       AND w.venue_name IS NOT NULL AND btrim(w.venue_name) <> ''
       AND UPPER(COALESCE(s.status::text,'')) NOT IN ('CANCELLED','DRAFT')
     ORDER BY st.name, s.doc_no`;

  if (rows.length === 0) {
    notice("Nothing to backfill: every blank-venue SO either has an unparked salesperson or a showroom with no venue_name. Clean.");
    await sql.end();
    return;
  }

  const byRep = new Map();
  for (const r of rows) {
    const arr = byRep.get(r.rep_name) ?? [];
    arr.push(r); byRep.set(r.rep_name, arr);
  }
  notice(`Blank-venue SOs whose PARKED rep implies a venue: ${rows.length} across ${byRep.size} rep(s).`);
  notice("");
  for (const [rep, arr] of byRep) {
    notice(`  ${pad(rep, 24)} -> venue "${arr[0].venue_name}" (${arr[0].showroom_code}) : ${arr.length} SO(s)`);
    for (const r of arr) notice(`      ${pad(r.doc_no, 20)} so_date=${r.so_date ?? "?"}`);
  }
  notice("");

  if (!APPLY) {
    notice(`DRY-RUN — would stamp venue + venue_source='SHOWROOM' on ${rows.length} SO(s). Re-run APPLY=1 to write.`);
    await sql.end();
    return;
  }

  let written = 0;
  await sql.begin(async (tx) => {
    for (const r of rows) {
      const res = await tx`
        UPDATE scm.mfg_sales_orders
           SET venue = ${r.venue_name}, venue_source = 'SHOWROOM'
         WHERE doc_no = ${r.doc_no} AND company_id = ${r.company_id}
           AND (venue IS NULL OR btrim(venue) = '')`;
      written += res.count;
    }
  });
  notice(`APPLIED: stamped venue on ${written} SO(s) from their salesperson's showroom parking.`);
  const [{ remaining }] = await sql`
    SELECT count(*)::int AS remaining
      FROM scm.mfg_sales_orders s JOIN scm.staff st ON st.id = s.salesperson_id
      JOIN scm.warehouses w ON w.id = st.showroom_warehouse_id
     WHERE (s.venue IS NULL OR btrim(s.venue)='') AND w.venue_name IS NOT NULL AND btrim(w.venue_name)<>''
       AND UPPER(COALESCE(s.status::text,'')) NOT IN ('CANCELLED','DRAFT')`;
  notice(`Parked-rep blank-venue SOs remaining after apply: ${remaining} (expect 0).`);
  if (remaining > 0) warn(`${remaining} still blank — investigate.`);
}

main().then(() => sql.end()).catch(async (e) => {
  console.error("BACKFILL_SO_VENUE_BY_PARKING_FAIL", e?.message ?? e);
  await sql.end();
  process.exit(1);
});
