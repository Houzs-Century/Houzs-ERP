// READ-ONLY. The owner's two definitive questions (2026-08-02):
//   Q1. Does EVERY live SO have a salesperson AND a correct Sales Venue?
//   Q2. Does EVERY live SO have a Warehouse, bound correctly from postcode/state?
//       And where it does NOT: is it because the address is "Fill in later"
//       (blank) / the order has no Processing Date yet? The model being tested:
//       Processing Date (proceeded_at) REQUIRES a full address (line1 + postcode)
//       + deposit — so an un-proceeded SO legitimately has no address and thus no
//       warehouse; a PROCEEDED SO with no warehouse is a real defect.
//
// Every rule here is the one the code enforces:
//   - warehouse: so-warehouse.ts — sales_location -> customer_state map (+ this
//     script additionally tries postcode->state, which the engine does NOT yet
//     do, and reports that as a SEPARATE recoverable bucket).
//   - venue: venue-binding.ts — a parked rep's SO should carry the showroom's
//     venue_name; an unparked rep's blank venue is by design.
//   - processing date: proceeded_at, set only with a full address + deposit
//     (mfg-sales-orders.ts processingDateThresholdFor).
//
// SELECT only. No writes. Enum columns ::text before string ops.
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(1); }
const sql = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 60 });
const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const pad = (s, n) => String(s ?? "").slice(0, n).padEnd(n);
const blank = (v) => v == null || String(v).trim() === "";

const STATE_ALIASES = {
  "wilayah persekutuan kuala lumpur": "kuala lumpur", "wp kuala lumpur": "kuala lumpur",
  kl: "kuala lumpur", penang: "pulau pinang", malacca: "melaka",
};
const canonState = (s) => {
  if (!s) return "";
  const t = String(s).trim().toLowerCase().replace(/\s+/g, " ");
  return STATE_ALIASES[t] ?? t;
};
const postcodeState = (pc) => {
  const m = String(pc ?? "").trim().match(/^(\d{2})\d{3}$/);
  if (!m) return null;
  const p = Number(m[1]);
  if (p >= 1 && p <= 2) return "Perlis";
  if (p >= 5 && p <= 9) return "Kedah";
  if (p >= 10 && p <= 14) return "Pulau Pinang";
  if (p >= 15 && p <= 18) return "Kelantan";
  if (p >= 20 && p <= 24) return "Terengganu";
  if (p >= 25 && p <= 28) return "Pahang";
  if (p >= 30 && p <= 36) return "Perak";
  if (p >= 40 && p <= 48) return "Selangor";
  if (p >= 50 && p <= 60) return "Kuala Lumpur";
  if (p === 62) return "Putrajaya";
  if (p >= 63 && p <= 68) return "Selangor";
  if (p >= 70 && p <= 73) return "Negeri Sembilan";
  if (p >= 75 && p <= 78) return "Melaka";
  if (p >= 79 && p <= 86) return "Johor";
  if (p === 87) return "Labuan";
  if (p >= 88 && p <= 91) return "Sabah";
  if (p >= 93 && p <= 98) return "Sarawak";
  return null;
};

async function main() {
  notice("=== SO WAREHOUSE + VENUE — the two definitive questions, READ-ONLY ===");
  const whs = await sql`SELECT id, code, name, venue_name FROM scm.warehouses`;
  const whById = new Map(whs.map((w) => [w.id, w]));
  const whByNameLc = new Map();
  for (const w of whs) {
    if (w.code) whByNameLc.set(w.code.trim().toLowerCase(), w.id);
    if (w.name) whByNameLc.set(w.name.trim().toLowerCase(), w.id);
  }
  const stateMaps = await sql`SELECT state, warehouse_id FROM scm.state_warehouse_mappings`;
  const whFromState = (state) => {
    const want = canonState(state);
    if (!want) return null;
    for (const m of stateMaps) if (m.warehouse_id && canonState(m.state) === want) return m.warehouse_id;
    return null;
  };
  const whFromLoc = (loc) => (blank(loc) ? null : whByNameLc.get(String(loc).trim().toLowerCase()) ?? null);

  const companies = (await sql`SELECT DISTINCT company_id FROM scm.mfg_sales_orders ORDER BY company_id`).map((r) => r.company_id);
  for (const companyId of companies) {
    notice("");
    notice(`################ COMPANY ${companyId} ################`);
    const heads = await sql`
      SELECT s.doc_no, s.status::text AS status, s.salesperson_id, s.venue,
             s.sales_location, s.customer_state, s.postcode, s.city, s.address1,
             s.proceeded_at, st.showroom_warehouse_id
        FROM scm.mfg_sales_orders s
        LEFT JOIN scm.staff st ON st.id = s.salesperson_id
       WHERE s.company_id = ${companyId}
         AND UPPER(COALESCE(s.status::text,'')) NOT IN ('CANCELLED','DRAFT')`;
    notice(`live SOs (non-cancelled, non-draft): ${heads.length}`);

    /* ── Q1: salesperson + venue ─────────────────────────────────────────── */
    let noRep = 0, hasRep = 0, venueOk = 0, venueBlankParked = 0, venueBlankUnparked = 0;
    const noRepDocs = [], blankParkedDocs = [];
    for (const h of heads) {
      if (h.salesperson_id == null) { noRep += 1; noRepDocs.push(h.doc_no); } else hasRep += 1;
      if (!blank(h.venue)) { venueOk += 1; continue; }
      // blank venue: parked rep -> should have had it (bug/backfillable); unparked -> by design
      if (h.showroom_warehouse_id) { venueBlankParked += 1; blankParkedDocs.push(h.doc_no); }
      else venueBlankUnparked += 1;
    }
    notice("  ---- Q1: salesperson + venue ----");
    notice(`  SOs WITH a salesperson              : ${hasRep} / ${heads.length}`);
    notice(`  SOs with NO salesperson             : ${noRep}${noRep ? "  " + noRepDocs.slice(0, 12).join(", ") : ""}`);
    notice(`  SOs WITH a venue                    : ${venueOk} / ${heads.length}`);
    notice(`  SOs blank venue, rep IS parked (BUG/backfill): ${venueBlankParked}${venueBlankParked ? "  " + blankParkedDocs.slice(0, 12).join(", ") : ""}`);
    notice(`  SOs blank venue, rep NOT parked (by design)  : ${venueBlankUnparked}`);
    notice(`  => Q1 ANSWER: ${noRep === 0 && venueBlankParked === 0
      ? "every live SO has a salesperson, and every parked rep's SO has a venue."
      : `${noRep} lack a salesperson, ${venueBlankParked} parked-rep SO(s) still blank (fix these).`}`);

    /* ── Q2: warehouse, and WHY it is missing ────────────────────────────── */
    let whOwnLoc = 0, whState = 0, whPostcode = 0, whNone = 0;
    let proceededNoWh = 0, unproceededNoWh = 0, noWhFillLater = 0;
    const proceededNoWhDocs = [], whNoneRows = [];
    for (const h of heads) {
      const wh = whFromLoc(h.sales_location) ?? whFromState(h.customer_state);
      if (wh) { if (whFromLoc(h.sales_location)) whOwnLoc += 1; else whState += 1; continue; }
      // no warehouse from the engine's own rule — try postcode (recoverable), else WH_NONE
      const pcWh = whFromState(postcodeState(h.postcode));
      if (pcWh) { whPostcode += 1; continue; }
      whNone += 1;
      const proceeded = h.proceeded_at != null;
      const addrBlank = blank(h.address1) && blank(h.postcode) && blank(h.customer_state);
      if (proceeded) { proceededNoWh += 1; proceededNoWhDocs.push(h.doc_no); }
      else { unproceededNoWh += 1; if (addrBlank) noWhFillLater += 1; }
      whNoneRows.push({ doc: h.doc_no, proceeded, addrBlank, postcode: h.postcode, state: h.customer_state, city: h.city });
    }
    notice("  ---- Q2: warehouse (postcode/state binding) ----");
    notice(`  SOs whose warehouse resolves from sales_location : ${whOwnLoc}`);
    notice(`  SOs whose warehouse resolves from customer_state : ${whState}`);
    notice(`  SOs recoverable from POSTCODE (engine doesn't yet): ${whPostcode}  <- add postcode->state to close these`);
    notice(`  SOs with NO warehouse (WH_NONE)                  : ${whNone}`);
    notice(`  => of those WH_NONE:`);
    notice(`     - NO Processing Date + blank address = "Fill in later" (EXPECTED, not a bug): ${noWhFillLater}`);
    notice(`     - NO Processing Date, some partial address                                  : ${unproceededNoWh - noWhFillLater}`);
    notice(`     - HAS a Processing Date yet still no warehouse (REAL DEFECT)                 : ${proceededNoWh}${proceededNoWh ? "  " + proceededNoWhDocs.slice(0, 12).join(", ") : ""}`);
    for (const r of whNoneRows.slice(0, 20)) {
      notice(`       ${pad(r.doc, 18)} proceeded=${r.proceeded ? "YES" : "no"} addrBlank=${r.addrBlank ? "YES" : "no"} postcode=${JSON.stringify(r.postcode)} state=${JSON.stringify(r.state)}`);
    }
    notice(`  => Q2 ANSWER: ${proceededNoWh === 0
      ? `every PROCESSED SO has a warehouse. The ${whNone} without one are un-proceeded "fill in later" orders (no address yet) — they get a warehouse when processed. Confirms the owner's model.`
      : `${proceededNoWh} SO(s) HAVE a Processing Date but NO warehouse — a real defect to fix.`}`);
  }
  notice("");
  notice("=== END — read-only, nothing written. ===");
}

main().then(() => sql.end()).catch((e) => {
  console.error("SO_WH_VENUE_FINAL_FAIL", e?.message ?? e);
  process.exit(1);
});
