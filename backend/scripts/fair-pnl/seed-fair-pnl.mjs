#!/usr/bin/env node
// FAIR PNL historical seed — backfill 2025/2026 roadshow projects into the PMS.
//
// DRY-RUN by default (read-only, safe): loads the MAINTAINED picker lists
// (project_brands / project_venues / project_organizers / project_event_types) +
// existing projects, matches EVERY seed value to a maintained one (owner hard rule
// 2026-07-26: never free text), dedups vs existing, and prints:
//   - would INSERT vs would SKIP(dedup) counts + RM totals
//   - an UNMATCHED section: any brand/venue/organizer/event_type with no maintained
//     entry (owner adds it in Project Maintenance, or maps it, before seeding)
// It REFUSES to write while anything is unmatched.
//
// --commit writes: INSERT project (code = deriveProjectCode, state from the matched
// venue, event_type_id from the matched type, stage 'completed', Houzs company) +
// its finance lines (amount in SEN). Run ONLY from the workflow, owner-triggered.
//
// Data: seed_data_final.json (produced by build_seed_data.py from the two Excel
// files — cross-month merged, COGS split, setup/rental apportioned, corrections).
import postgres from "postgres";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COMMIT = process.argv.includes("--commit");
const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const rows = JSON.parse(fs.readFileSync(path.join(HERE, "seed_data_final.json"), "utf8"));

const norm = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
// Malaysian state / region tokens the FAIR PNL venues tack on the end but the
// maintained venue list usually omits ("AEON BIG KEPONG KL" -> "AEON BIG KEPONG").
const STATE_TAIL = /\b(KL|PG|PNG|JB|JHB|PJ|MLK|NS|SWK|SEL|SELANGOR|PENANG|JOHOR|KEDAH|PERAK|PERLIS|PAHANG|MELAKA|MALACCA|KELANTAN|TERENGGANU|SABAH|SARAWAK|NEGERI\s*SEMBILAN|PUTRAJAYA|IPOH|KUANTAN|SEREMBAN)\b\s*$/i;
// The 16 valid Malaysian states/territories (must match the Project Maintenance picker).
const VALID_STATES = new Set(["Johor", "Kedah", "Kelantan", "Kuala Lumpur", "Labuan", "Melaka", "Negeri Sembilan", "Pahang", "Perak", "Perlis", "Pulau Pinang", "Putrajaya", "Sabah", "Sarawak", "Selangor", "Terengganu"]);
// Expand Malaysian venue abbreviations so "AEON TMN EQUINE" == "AEON TAMAN EQUINE".
const ABBR = [[/\bTMN\b/gi, "TAMAN"], [/\bBKT\b/gi, "BUKIT"], [/\bBUKTI\b/gi, "BUKIT"], [/\bMILLENIUM\b/gi, "MILLENNIUM"]];
const expandAbbr = (s) => { let v = String(s ?? ""); for (const [re, to] of ABBR) v = v.replace(re, to); return v; };
const venueNorm = (s) => { let v = expandAbbr(String(s ?? "").trim()); for (let i = 0; i < 3; i++) v = v.replace(STATE_TAIL, "").trim(); return norm(v); };
// Readable name for a NEW venue: state tail stripped, tidied.
const cleanVenueName = (s) => { let v = expandAbbr(String(s ?? "").trim()); for (let i = 0; i < 3; i++) v = v.replace(STATE_TAIL, "").trim(); return v.replace(/\s+/g, " ").replace(/[,\s]+$/, "").trim(); };
// Derive the Malaysian state from a venue string (for auto-created venues).
const MY_STATES = [
  [/PUTRAJAYA/, "Putrajaya"],
  [/PENANG|PULAU PINANG|\bPG\b|\bPNG\b|BUTTERWORTH|KEPALA BATAS|SEBERANG|BUKIT MERTAJAM|STRAITS QUAY/, "Pulau Pinang"],
  [/JOHOR|\bJB\b|\bJHB\b|TEBRAU|TERBAU|KLUANG|KULAI|\bAUSTIN\b|PERSADA/, "Johor"],
  [/SELANGOR|SUBANG|SHAH ALAM|\bKLANG\b|RAWANG|BUKIT RAJA|SETIA CITY|EQUINE|PUCHONG|DAMANSARA/, "Selangor"],
  [/PERAK|IPOH|TAIPING|MANJUNG|\bSITIAWAN\b/, "Perak"],
  [/KEDAH|ALOR|SUNGAI PETANI|AMANJAYA|\bALMA\b/, "Kedah"],
  [/KELANTAN|KOTA BHARU|\bKB MALL\b/, "Kelantan"],
  [/MELAKA|MALACCA|PAHLAWAN|\bMITC\b/, "Melaka"],
  [/NEGERI SEMBILAN|SEREMBAN|\bNILAI\b|\bNS\b|MESA MALL|PALM MALL/, "Negeri Sembilan"],
  [/PAHANG|KUANTAN/, "Pahang"],
  [/SABAH|KOTA KINABALU|CENTRE POINT/, "Sabah"],
  [/SARAWAK|KUCHING|\bSWK\b|BCCK|VIVACITY|\bMIRI\b|METROCITY/, "Sarawak"],
  [/KUALA LUMPUR|\bKL\b|MONT KIARA|CHERAS|KEPONG|WANGSA|SETAPAK|BUKIT JALIL|MID VALLEY|PAVILION|AVENUE K|GATEWAY|MELAWATI|SENTUL|TITIWANGSA|BANGSAR|SETIAWANGSA|\bKERAMAT\b|\bAU2\b/, "Kuala Lumpur"],
];
const deriveState = (name) => { const u = String(name).toUpperCase(); for (const [re, st] of MY_STATES) if (re.test(u)) return st; return null; };
const slug = (s) => String(s ?? "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "");
const sen = (rm) => Math.round(Number(rm || 0) * 100);
const rm = (n) => `RM ${Number(n).toLocaleString("en-MY", { maximumFractionDigits: 0 })}`;

async function main() {
  // ── Load maintained lists + existing projects + Houzs company ──────────────
  const [brands, venues, organizers, etypes, existing, houzs] = await Promise.all([
    sql`SELECT name FROM project_brands WHERE COALESCE(active,1)=1`,
    sql`SELECT name, state FROM project_venues`,
    sql`SELECT name FROM project_organizers`,
    sql`SELECT id, name, slug FROM project_event_types`,
    sql`SELECT brand, venue, start_date FROM projects WHERE archived_at IS NULL`,
    sql`SELECT id FROM companies WHERE code = 'HOUZS' LIMIT 1`,
  ]);
  const companyId = houzs[0]?.id ?? null;
  // Owner-confirmed aliases (norm-space): seed value -> maintained value.
  const BRAND_ALIAS = { CARRESS: "CARRESMATTRESS" };
  const ORG_ALIAS = { BEDDINGFAIR: "MLE", SIGNATUREHOME: "REX", ERGOTEXMLE: "MLE", HOMEEXPOREX: "REX", MALLMGT: "MALLMGMT",
    HOMELIVING: "BIGHOME", HOMES: "BIGHOME", HOMETECH: "MYHOME", FHL: "HOMELOVE", HOMEEXPO: "HOMECARNIVAL",
    // solo-roadshow coordinators -> their maintained parenthetical names
    KAIHAO: "KAIHAOKLCHEN", SYELIN: "SYELINEVPLANMKTG", VINCENT: "VINCENTVTEAMEVENT", MROOI: "MROOITSMOON", MR001: "MR001TSMOON" };
  const ETYPE_ALIAS = { ROADSHOW: "SOLO" };
  const bAlias = (s) => BRAND_ALIAS[norm(s)] || norm(s);
  const oAlias = (s) => ORG_ALIAS[norm(s)] || norm(s);
  const etAlias = (s) => ETYPE_ALIAS[norm(s)] || norm(s);
  // Venue canonicaliser (owner-confirmed keyword rules) -> a maintained venue name.
  function canonVenue(raw) {
    const u = norm(raw);
    if (u.includes("SOUTHKEY")) return "MVEC SOUTHKEY";
    if (u.includes("MVEC") || u.includes("MIDVALLEY")) return "MID VALLEY";
    if (u.includes("PAVILION") || u.includes("PAVILLION")) return "PAVILION BUKIT JALIL";
    if (u.includes("STADIUM") && u.includes("JALIL")) return "STADIUM BUKIT JALIL";
    if (u.includes("STARLING")) return "THE STARLING MALL";
    if (u.includes("SPCC") || u.includes("SUNWAYPYRAMID")) return "SPCC";
    if (u.includes("SSCC") || u.includes("SETIASPICE")) return "SETIA SPICE CONVENTION CENTRE"; // SSCC = Setia
    if (u.includes("SPICEARENA") || u.includes("PISA")) return "PISA SPICE ARENA CONVENTION CENTRE"; // Spice Arena = Pisa
    if (u.includes("IOICITYMALL")) return "IOI MALL PUTRAJAYA"; // IOI City Mall = maintained "IOI MALL PUTRAJAYA" (owner 2026-07-26)
    if (u.includes("IOIDAMANSARA")) return "IOI MALL DAMANSARA";
    if (u.includes("TERBAU") || u.includes("TEBRAU")) return "AEON TEBRAU CITY"; // "AEON MALL TERBAU" typo -> AEON Tebrau City, JB
    if (u.includes("PERSADA")) return "PERSADA JOHOR INTERNATIONAL CONVENTION CENTRE"; // convention centre -> full name
    if (u.includes("VIVACITY")) return "VIVACITY MEGAMALL"; // "VIVACITY, KUCHING" -> proper name
    if (u.includes("ALMA") && u.includes("MERTAJAM")) return "AEON BUKIT MERTAJAM"; // AEON Alma = AEON Bukit Mertajam (same mall, Alma = neighbourhood)
    if (u.includes("BCCK")) return "BCCK KUCHING";
    if (u.includes("SCCC") || u.includes("SETIACITY")) return "SCCC SHAH ALAM";
    if (u.includes("METROCITY") || (u.includes("MCC") && u.includes("KUCHING"))) return "KUCHING METROCITY CONVENTION CENTRE";
    if ((u.includes("INDERAMULIA") || u.includes("ENDERAMULIA")) || (u.includes("STADIUM") && u.includes("IPOH"))) return "STADIUM INDERA MULIA IPOH";
    return raw;
  }

  // Duplicate check on the maintained lists themselves (owner asked).
  const dups = (arr, key) => { const m = new Map(); for (const x of arr) { const k = norm(key(x)); m.set(k, (m.get(k) || []).concat(key(x))); } return [...m.values()].filter((a) => a.length > 1); };
  const vDup = dups(venues, (v) => v.name), oDup = dups(organizers, (o) => o.name), bDup = dups(brands, (b) => b.name);

  const brandMap = new Map(brands.map((b) => [norm(b.name), b.name]));
  const venueMap = new Map(venues.map((v) => [venueNorm(v.name), v])); // state-tail-stripped key -> {name, state}
  const orgMap = new Map(organizers.map((o) => [norm(o.name), o.name]));
  const etypeMap = new Map(etypes.map((e) => [norm(e.name), e])); // -> {id, name, slug}
  const existKey = new Set(existing.map((e) => `${norm(e.brand)}|${venueNorm(e.venue)}|${String(e.start_date || "").slice(0, 10)}`));
  // Fuzzy venue: after canon + state-strip, accept the maintained venue whose
  // normalized name contains mine or vice versa (catches "BLOOMSVALE MALL" vs
  // "BLOOMSVALE"). Longest maintained match wins; >=5 chars to avoid junk hits.
  const venueList = venues.map((x) => [venueNorm(x.name), x]);
  const fuzzyVenue = (myn) => {
    if (!myn || myn.length < 5) return undefined;
    const c = venueList.filter(([mn]) => mn.length >= 5 && (myn.includes(mn) || mn.includes(myn))).sort((a, b) => b[0].length - a[0].length);
    return c[0] && c[0][1];
  };

  // ── Match + dedup ──────────────────────────────────────────────────────────
  const un = { brand: new Set(), venue: new Set(), organizer: new Set(), event_type: new Set() };
  const toInsert = [];
  let skip = 0, insSales = 0;
  const toCreate = new Map(); // venueNorm -> {name, state} : new venues to add to project_venues
  let emptyVenue = 0;
  for (const r of rows) {
    const b = brandMap.get(bAlias(r.brand));
    let v = venueMap.get(venueNorm(canonVenue(r.venue))) || fuzzyVenue(venueNorm(canonVenue(r.venue)));
    const et = etypeMap.get(etAlias(r.event_type));
    const orgN = norm(r.organizer);
    const isMarker = orgN === "" || orgN === "SOLO" || orgN === "ROADSHOW"; // Excel "SOLO" = no named coordinator
    const o = isMarker ? null : orgMap.get(oAlias(r.organizer)); // keep real coordinators (KAI HAO, MALL MGMT) even on Solo
    if (!b) un.brand.add(r.brand);
    if (!isMarker && !o) un.organizer.add(r.organizer);
    if (!et) un.event_type.add(r.event_type);
    if (!v) { // genuinely new venue -> queue for creation with a derived state
      const cn = cleanVenueName(canonVenue(r.venue)), vk = venueNorm(cn);
      if (!vk) { emptyVenue++; continue; } // empty venue name -> cannot seed
      if (!toCreate.has(vk)) toCreate.set(vk, { name: cn, state: deriveState(r.venue) });
      v = { name: cn, state: toCreate.get(vk).state, _new: true };
    }
    const key = `${norm(b || r.brand)}|${venueNorm(v.name)}|${String(r.start || "").slice(0, 10)}`;
    if (existKey.has(key)) { skip++; continue; }
    toInsert.push({ r, b, v, o, et });
    insSales += Number(r.sales || 0);
  }

  // ── Report ─────────────────────────────────────────────────────────────────
  console.log(`\n=== FAIR PNL seed — ${COMMIT ? "COMMIT" : "DRY-RUN (read-only)"} ===`);
  console.log(`company: HOUZS (id ${companyId})   seed rows: ${rows.length}`);
  console.log(`would INSERT: ${toInsert.length}   would SKIP (already in PMS): ${skip}   new-project sales: ${rm(insSales)}`);
  const rep = (label, set, n) => {
    if (!set.size) { console.log(`  ${label}: all ${n} matched the maintained list ✓`); return; }
    console.log(`  ${label}: ${set.size} UNMATCHED — add in Project Maintenance or give a mapping:`);
    [...set].sort().forEach((x) => console.log(`      - ${JSON.stringify(x)}`));
  };
  console.log(`\n[maintained lists on prod — to build the mapping]`);
  console.log(`  event_types: ${etypes.map((e) => `${e.name}(${e.slug})`).join(", ")}`);
  console.log(`  brands (${brands.length}): ${brands.map((b) => b.name).join(", ")}`);
  console.log(`  organizers (${organizers.length}): ${organizers.map((o) => o.name).join(", ")}`);
  console.log(`  venues: ${venues.length} maintained; sample: ${venues.slice(0, 30).map((v) => v.name).join(" | ")}`);
  if (vDup.length || oDup.length || bDup.length) {
    console.log(`\n[DUPLICATE maintained entries — clean in Project Maintenance]`);
    vDup.forEach((a) => console.log(`  venue dup: ${a.join("  ==  ")}`));
    oDup.forEach((a) => console.log(`  organizer dup: ${a.join("  ==  ")}`));
    bDup.forEach((a) => console.log(`  brand dup: ${a.join("  ==  ")}`));
  }

  console.log(`\n[match vs maintained picker lists]`);
  rep("BRAND", un.brand, brandMap.size);
  rep("ORGANIZER", un.organizer, orgMap.size);
  rep("EVENT_TYPE", un.event_type, etypeMap.size);

  console.log(`\n[MAINTAINED venues — ${venues.length} (ground truth; cross-check new ones against these)]`);
  [...venues].map((v) => `${v.name}${v.state ? `  (${v.state})` : "  (no state)"}`).sort().forEach((s) => console.log(`   . ${s}`));

  console.log(`\n[NEW venues to create in project_venues — ${toCreate.size}]`);
  [...toCreate.values()].sort((a, b) => a.name.localeCompare(b.name)).forEach((x) => console.log(`      + ${x.name}  (state: ${x.state || "??? SET MANUALLY"})`));
  const noState = [...toCreate.values()].filter((x) => !x.state);
  if (noState.length) console.log(`  WARNING: ${noState.length} new venue(s) have no derivable state.`);
  const badState = [...toCreate.values()].filter((x) => x.state && !VALID_STATES.has(x.state));
  if (badState.length) console.log(`  WARNING: ${badState.length} new venue(s) have a NON-MAINTAINED state -> ${badState.map((x) => `${x.name}=${x.state}`).join(", ")}`);
  if (emptyVenue) console.log(`  NOTE: skipped ${emptyVenue} row(s) with an empty venue name.`);

  const blocking = un.brand.size + un.organizer.size + un.event_type.size;
  if (blocking) {
    console.log(`\nRESULT: ${blocking} unmatched brand/organizer/event_type — map these first (script aliases). NOTHING WRITTEN.`);
    process.exit(0);
  }
  if (!COMMIT) {
    console.log(`\nDRY-RUN OK — brand/organizer/event_type all matched. --commit will create ${toCreate.size} venue(s) + insert ${toInsert.length} project(s).`);
    process.exit(0);
  }

  // COMMIT: create the new venues first (owner-approved via the dry-run list).
  for (const nv of toCreate.values()) {
    await sql`INSERT INTO project_venues (name, state, created_by, company_id) VALUES (${nv.name}, ${nv.state}, 0, ${companyId})`;
  }
  console.log(`created ${toCreate.size} new venues`);

  // ── COMMIT: insert projects + finance lines ────────────────────────────────
  const usedCodes = new Set((await sql`SELECT code FROM projects`).map((x) => x.code));
  function uniqueCode(base) { if (!usedCodes.has(base)) { usedCodes.add(base); return base; } let n = 2; while (usedCodes.has(`${base}-${n}`)) n++; const c = `${base}-${n}`; usedCodes.add(c); return c; }

  let done = 0;
  for (const { r, b, v, o, et } of toInsert) {
    const start = String(r.start || "").slice(0, 10);
    const [yy, mm] = start.split("-");
    const state = v.state || null;
    const orgSlug = o ? slug(o) : "SOLO"; // pure-solo (no coordinator) -> "SOLO"; else the organizer
    const base = `${yy}-${mm}-${orgSlug}-${slug(state)}-${slug(v.name)}-${slug(b)}`;
    const code = uniqueCode(base);
    const name = `${state ? state + " " : ""}[${b}] ${o || "SOLO"} @ ${v.name}`;

    const [proj] = await sql`
      INSERT INTO projects (code, name, stage, event_type_id, brand, start_date, end_date, venue, state, organizer, created_by, company_id)
      VALUES (${code}, ${name}, 'completed', ${et.id}, ${b}, ${start}, ${String(r.end || start).slice(0,10)}, ${v.name}, ${state}, ${o}, 0, ${companyId})
      RETURNING id`;
    const pid = proj.id;
    const lines = [
      ["income", "sales", r.sales], ["cost", "cogs_matt_sofa", r.cogs_m], ["cost", "cogs_bedframe", r.cogs_b],
      ["cost", "cogs_accessories", r.cogs_a], ["cost", "rental", r.rental], ["cost", "setup", r.setup],
    ].filter(([, , amt]) => Number(amt) > 0);
    for (const [kind, cat, amt] of lines) {
      await sql`INSERT INTO project_finance_lines (project_id, kind, category, description, amount, company_id)
                VALUES (${pid}, ${kind}, ${cat}, ${cat + " (FAIR PNL seed)"}, ${sen(amt)}, ${companyId})`;
    }
    done++;
    if (done % 50 === 0) console.log(`  inserted ${done}/${toInsert.length}...`);
  }
  console.log(`\nCOMMIT done: inserted ${done} projects. NOTE: run recomputeAutoCostLines (transport/commission/merchandise) via the app or a follow-up.`);
}
main().then(() => sql.end()).catch((e) => { console.error(e); process.exit(1); });
