// READ-ONLY. For the WH_NONE SOs (no warehouse, no sales_location, no
// customer_state that maps), dump EVERY location-bearing field the header
// carries — customer_state, postcode, city, address1..4, country — and try to
// recover the state (and therefore the warehouse, by the owner's rule "有 state
// 就知道什么仓库") from the POSTCODE when customer_state is blank.
//
// Owner 2026-08-02: warehouse follows the SO's STATE via state_warehouse_mappings.
// So a WH_NONE line is only a genuine dead-end if NEITHER a usable state NOR a
// postcode we can map to one exists. This proves which of the two it is, per SO.
//
// SELECT only. No writes.
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(1); }
const sql = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 60 });
const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const pad = (s, n) => String(s ?? "").slice(0, n).padEnd(n);
const blank = (v) => v == null || String(v).trim() === "";

/* Malaysian postcode -> state. First 2 digits are the deterministic key; ranges
   from Pos Malaysia's allocation. Only the states we actually warehouse matter,
   but the full map keeps a KL 5xxxx from being mislabelled Selangor. */
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
  if (p === 39 || p === 49 || (p >= 69 && p <= 69)) return "Pahang"; // Genting/Cameron pockets
  if (p >= 30 && p <= 36) return "Perak";
  if (p >= 40 && p <= 48) return "Selangor";
  if (p >= 50 && p <= 60) return "Kuala Lumpur";
  if (p >= 62 && p <= 62) return "Putrajaya";
  if (p >= 63 && p <= 68) return "Selangor";
  if (p >= 70 && p <= 73) return "Negeri Sembilan";
  if (p >= 75 && p <= 78) return "Melaka";
  if (p >= 79 && p <= 86) return "Johor";
  if (p >= 87 && p <= 87) return "Labuan";
  if (p >= 88 && p <= 91) return "Sabah";
  if (p >= 93 && p <= 98) return "Sarawak";
  return null;
};

const STATE_ALIASES = {
  "wilayah persekutuan kuala lumpur": "kuala lumpur", "wp kuala lumpur": "kuala lumpur",
  kl: "kuala lumpur", penang: "pulau pinang", malacca: "melaka",
};
const canonState = (s) => {
  if (!s) return "";
  const t = String(s).trim().toLowerCase().replace(/\s+/g, " ");
  return STATE_ALIASES[t] ?? t;
};

async function main() {
  notice("=== WH_NONE SOs — is the STATE recoverable (owner rule: state -> warehouse)? READ-ONLY ===");
  const warehouses = await sql`SELECT id, code, name FROM scm.warehouses`;
  const whById = new Map(warehouses.map((w) => [w.id, w]));
  const stateMaps = await sql`SELECT state, warehouse_id FROM scm.state_warehouse_mappings`;
  const whFromState = (state) => {
    const want = canonState(state);
    if (!want) return null;
    for (const m of stateMaps) if (m.warehouse_id && canonState(m.state) === want) return m.warehouse_id;
    return null;
  };
  const whFromLoc = (loc) => {
    const needle = (loc ?? "").trim().toLowerCase();
    if (!needle) return null;
    const hit = warehouses.find((w) => (w.code ?? "").trim().toLowerCase() === needle || (w.name ?? "").trim().toLowerCase() === needle);
    return hit?.id ?? null;
  };

  const companies = (await sql`SELECT DISTINCT company_id FROM scm.mfg_sales_orders ORDER BY company_id`).map((r) => r.company_id);
  let recoverable = 0, deadEnd = 0;
  for (const companyId of companies) {
    // SO headers with at least one physical line that resolves to no warehouse.
    const rows = await sql`
      SELECT DISTINCT s.doc_no, s.status::text AS status, s.sales_location, s.customer_state,
             s.city, s.postcode, s.address1, s.address2, s.address3, s.address4,
             s.customer_country, s.debtor_code, s.debtor_name
        FROM scm.mfg_sales_orders s
        JOIN scm.mfg_sales_order_items i ON i.doc_no = s.doc_no AND i.company_id = s.company_id
       WHERE s.company_id = ${companyId} AND i.cancelled = FALSE
         AND i.warehouse_id IS NULL
         AND UPPER(COALESCE(s.status::text,'')) NOT IN ('CANCELLED','DRAFT','DELIVERED','INVOICED','CLOSED','SHIPPED')
       ORDER BY s.doc_no`;
    const whNone = rows.filter((r) => !whFromLoc(r.sales_location) && !whFromState(r.customer_state));
    if (whNone.length === 0) continue;
    notice("");
    notice(`######## COMPANY ${companyId} — ${whNone.length} WH_NONE SO(s) ########`);
    for (const r of whNone) {
      const pcState = postcodeState(r.postcode);
      const derivedWh = pcState ? whFromState(pcState) : null;
      const anyAddr = [r.address1, r.address2, r.address3, r.address4].filter((x) => !blank(x)).join(" | ");
      const verdict = derivedWh
        ? `RECOVERABLE -> state '${pcState}' (from postcode ${r.postcode}) -> ${whById.get(derivedWh)?.code ?? derivedWh}`
        : !blank(r.postcode)
          ? `postcode ${r.postcode} present but maps to state '${pcState ?? "?"}' with NO warehouse mapping`
          : !blank(r.city) || anyAddr
            ? "has city/address text but NO postcode and NO state — needs a human read of the address"
            : "NO location data at all (no state, no postcode, no city, no address) — genuine dead end";
      if (derivedWh) recoverable += 1; else deadEnd += 1;
      notice(`  ${pad(r.doc_no, 18)} [${pad(r.status, 12)}] ${pad(r.debtor_name ?? r.debtor_code ?? "", 22)}`);
      notice(`      state=${JSON.stringify(r.customer_state)} postcode=${JSON.stringify(r.postcode)} city=${JSON.stringify(r.city)} country=${JSON.stringify(r.customer_country)}`);
      if (anyAddr) notice(`      address: ${anyAddr}`);
      notice(`      => ${verdict}`);
    }
  }
  notice("");
  notice(`SUMMARY: ${recoverable} WH_NONE SO(s) RECOVERABLE from postcode->state->warehouse; ${deadEnd} need a human (no usable location field).`);
  notice("=== END — read-only, nothing written. ===");
}

main().then(() => sql.end()).catch((e) => {
  console.error("WH_NONE_STATE_FAIL", e?.message ?? e);
  process.exit(1);
});
