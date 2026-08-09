#!/usr/bin/env node
// Post-import repair for the AutoCount->ERP company-1 Sales Orders:
//  1. VENUE: scm.venues had ZERO company-1 rows, so every imported order carried
//     venue TEXT but venue_id NULL — the list showed the venue, the Edit form's
//     venue picker showed blank. Create the venues from the distinct texts, then
//     backfill venue_id.
//  2. ADDRESS: postcode/city were only filled when the address literally
//     contained a 5-digit postcode. Derive them for the rest from a place-name
//     lookup (kepong -> 52100 Kuala Lumpur, etc.), matching how a real order
//     stores them (postcode="54200", city="Kuala Lumpur", state="Kuala Lumpur").
// DRY-RUN by default; APPLY=1 to write.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");
function stateOf(pc) {
  if (!pc) return null; const p = +String(pc).slice(0, 2);
  const R = [[[1, 2], "Perlis"], [[5, 9], "Kedah"], [[10, 14], "Penang"], [[15, 18], "Kelantan"], [[20, 24], "Terengganu"], [[25, 28], "Pahang"], [[30, 36], "Perak"], [[39, 39], "Pahang"], [[40, 48], "Selangor"], [[49, 49], "Pahang"], [[50, 60], "Kuala Lumpur"], [[62, 62], "Putrajaya"], [[63, 64], "Selangor"], [[68, 68], "Selangor"], [[69, 69], "Pahang"], [[70, 73], "Negeri Sembilan"], [[75, 78], "Melaka"], [[79, 86], "Johor"], [[87, 87], "Labuan"], [[88, 91], "Sabah"], [[93, 98], "Sarawak"]];
  for (const [[a, b], s] of R) if (p >= a && p <= b) return s; return null;
}
// place name -> [postcode, city] for common Malaysian localities seen in these addresses
const PLACES = [
  [/\bKEPONG\b/i, ["52100", "Kuala Lumpur"]], [/\bWANGSA\s*MAJU\b/i, ["53300", "Kuala Lumpur"]],
  [/\bSETAPAK\b/i, ["53000", "Kuala Lumpur"]], [/\bCHERAS\b/i, ["56000", "Kuala Lumpur"]],
  [/\bAMPANG\b/i, ["68000", "Selangor"]], [/\bPUCHONG\b/i, ["47100", "Selangor"]],
  [/\bSHAH\s*ALAM\b/i, ["40000", "Selangor"]], [/\bSUBANG\s*JAYA\b/i, ["47500", "Selangor"]],
  [/\bPETALING\s*JAYA\b|\bPJ\b/i, ["46000", "Selangor"]], [/\bKLANG\b/i, ["41000", "Selangor"]],
  [/\bRAWANG\b/i, ["48000", "Selangor"]], [/\bKAJANG\b/i, ["43000", "Selangor"]],
  [/\bSERI\s*KEMBANGAN\b/i, ["43300", "Selangor"]], [/\bSEPANG\b/i, ["43900", "Selangor"]],
  [/\bBANGI\b/i, ["43650", "Selangor"]], [/\bSEMENYIH\b/i, ["43500", "Selangor"]],
  [/\bGOMBAK\b/i, ["53100", "Kuala Lumpur"]], [/\bSENTUL\b/i, ["51100", "Kuala Lumpur"]],
  [/\bBUKIT\s*JALIL\b/i, ["57000", "Kuala Lumpur"]], [/\bSRI\s*PETALING\b/i, ["57000", "Kuala Lumpur"]],
  [/\bMONT\s*KIARA\b/i, ["50480", "Kuala Lumpur"]], [/\bBANGSAR\b/i, ["59100", "Kuala Lumpur"]],
  [/\bKUALA\s*LUMPUR\b|\bK\.?L\.?\b/i, ["50000", "Kuala Lumpur"]],
  [/\bBUTTERWORTH\b/i, ["12300", "Penang"]], [/\bBUKIT\s*MERTAJAM\b/i, ["14000", "Penang"]],
  [/\bGEORGETOWN\b|\bGEORGE\s*TOWN\b/i, ["10200", "Penang"]], [/\bBAYAN\s*LEPAS\b/i, ["11900", "Penang"]],
  [/\bPENANG\b|\bPULAU\s*PINANG\b/i, ["10000", "Penang"]],
  [/\bJOHOR\s*BAHRU\b|\bJB\b/i, ["80000", "Johor"]], [/\bJOHOR\b/i, ["80000", "Johor"]],
  [/\bMELAKA\b|\bMALACCA\b/i, ["75000", "Melaka"]], [/\bSEREMBAN\b/i, ["70000", "Negeri Sembilan"]],
  [/\bIPOH\b/i, ["30000", "Perak"]], [/\bKUANTAN\b/i, ["25000", "Pahang"]],
  [/\bKOTA\s*KINABALU\b/i, ["88000", "Sabah"]], [/\bKUCHING\b/i, ["93000", "Sarawak"]],
  [/\bALOR\s*SETAR\b/i, ["05000", "Kedah"]], [/\bKOTA\s*BHARU\b/i, ["15000", "Kelantan"]],
];

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}`);

  // ---------- 1. venues — match against the PMS venue master (public.project_venues).
  // Owner: the venues ALREADY EXIST in PMS; do NOT create new ones. Match exact,
  // then on a normalised base name (drop SOLO/MALL/CONVENTION CENTRE/AEON noise).
  // Anything still unmatched is REPORTED for the owner, never invented.
  const master = await sql`SELECT id, name FROM public.project_venues WHERE company_id = 1 OR company_id IS NULL`;
  const baseName = (s) => norm(s).replace(/\b(SOLO|ROADSHOW|EVENT|MALL|CONVENTION CENTRE|CONVENTION CENTER|SHOPPING CENTRE|AEON BIG|AEON)\b/g, " ").replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const byExact = new Map(master.map((v) => [norm(v.name), v]));
  const byBase = new Map(); for (const v of master) { const b = baseName(v.name); if (b && !byBase.has(b)) byBase.set(b, v); }
  const resolveVenue = (txt) => {
    const nm = norm(txt); if (byExact.has(nm)) return byExact.get(nm);
    const b = baseName(txt); if (!b) return null;
    if (byBase.has(b)) return byBase.get(b);
    for (const [k, v] of byBase) if (k.includes(b) || b.includes(k)) return v;
    return null;
  };
  const texts = await sql`SELECT venue, count(*)::int n FROM scm.mfg_sales_orders WHERE company_id = 1 AND venue IS NOT NULL AND venue <> '' GROUP BY venue`;
  const pairs = []; const unmatched = [];
  for (const t of texts) { const v = resolveVenue(t.venue); if (v) pairs.push([t.venue, v.id]); else unmatched.push(`${t.venue}(${t.n})`); }
  log(`PMS venue master (project_venues): ${master.length}; order venue texts: ${texts.length}; matched: ${pairs.length}; UNMATCHED: ${unmatched.length}`);
  if (unmatched.length) log(`  unmatched venues (owner to map/add in PMS): ${unmatched.join(" | ")}`);
  if (APPLY && pairs.length) {
    let n = 0;
    for (let i = 0; i < pairs.length; i += 100) {
      const b = pairs.slice(i, i + 100);
      await sql.begin(async (tx) => { for (const [txt, id] of b) { const r = await tx`UPDATE scm.mfg_sales_orders SET venue_id = ${id} WHERE company_id = 1 AND venue = ${txt}`; n += r.count; } });
    }
    log(`venue_id backfilled on ${n} orders (from PMS master)`);
  }

  // ---------- 2. address postcode/city/state ----------
  const rows = await sql`SELECT doc_no, address1, address2, address3, address4, postcode, city, customer_state
    FROM scm.mfg_sales_orders WHERE company_id = 1 AND (postcode IS NULL OR postcode = '' OR city IS NULL OR city = '')`;
  log(`orders missing postcode/city: ${rows.length}`);
  let fixed = 0; const updates = [];
  for (const o of rows) {
    const addr = [o.address1, o.address2, o.address3, o.address4].filter(Boolean).join(", ");
    if (!addr) continue;
    let pc = o.postcode || null, city = o.city || null, st = o.customer_state || null;
    const m = /\b(\d{5})\b/.exec(addr); if (!pc && m) pc = m[1];
    if (!pc || !city) { for (const [re, [p, c]] of PLACES) if (re.test(addr)) { if (!pc) pc = p; if (!city) city = c; break; } }
    if (!st && pc) st = stateOf(pc);
    if (pc !== o.postcode || city !== o.city || st !== o.customer_state) { updates.push({ d: o.doc_no, pc, city, st }); fixed++; }
  }
  log(`address rows to update: ${fixed}`);
  for (const u of updates.slice(0, 8)) log(`   ${u.d}: postcode=${u.pc} city=${u.city} state=${u.st}`);
  if (APPLY) {
    for (let i = 0; i < updates.length; i += 200) {
      const b = updates.slice(i, i + 200);
      await sql.begin(async (tx) => { for (const u of b) await tx`UPDATE scm.mfg_sales_orders SET postcode=${u.pc}, city=${u.city}, customer_state=${u.st} WHERE doc_no=${u.d} AND company_id=1`; });
    }
    log(`address updated on ${updates.length} orders`);
  }
  if (!APPLY) log("\nDRY-RUN — set APPLY=1 to write.");
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
