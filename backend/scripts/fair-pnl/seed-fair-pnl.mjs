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
const STATE_TAIL = /\b(KL|PG|JB|PJ|MLK|NS|SWK|SEL|SELANGOR|PENANG|JOHOR|KEDAH|PERAK|PERLIS|PAHANG|MELAKA|MALACCA|KELANTAN|TERENGGANU|SABAH|SARAWAK|NEGERI\s*SEMBILAN|PUTRAJAYA|IPOH|KUANTAN|SEREMBAN)\b\s*$/i;
const venueNorm = (s) => { let v = String(s ?? "").trim(); for (let i = 0; i < 3; i++) v = v.replace(STATE_TAIL, "").trim(); return norm(v); };
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
    HOMELIVING: "BIGHOME", HOMES: "BIGHOME", HOMETECH: "MYHOME", FHL: "HOMELOVE" };
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
  for (const r of rows) {
    const b = brandMap.get(bAlias(r.brand));
    const v = venueMap.get(venueNorm(canonVenue(r.venue))) || fuzzyVenue(venueNorm(canonVenue(r.venue)));
    const et = etypeMap.get(etAlias(r.event_type));
    const isSolo = !!(et && String(et.slug || "").toLowerCase() === "solo");
    const o = isSolo ? null : orgMap.get(oAlias(r.organizer)); // SOLO events carry no organizer
    if (!b) un.brand.add(r.brand);
    if (!v) un.venue.add(r.venue);
    if (!isSolo && !o) un.organizer.add(r.organizer);
    if (!et) un.event_type.add(r.event_type);
    const key = `${norm(b || r.brand)}|${venueNorm(v ? v.name : r.venue)}|${String(r.start || "").slice(0, 10)}`;
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
  rep("VENUE", un.venue, venueMap.size);
  rep("ORGANIZER", un.organizer, orgMap.size);
  rep("EVENT_TYPE", un.event_type, etypeMap.size);

  const unmatched = un.brand.size + un.venue.size + un.organizer.size + un.event_type.size;
  if (unmatched) {
    console.log(`\nRESULT: ${unmatched} unmatched value(s). Resolve them in Project Maintenance (or map), then re-run. NOTHING WRITTEN.`);
    process.exit(0);
  }
  if (!COMMIT) {
    console.log(`\nDRY-RUN OK — every value matches the maintained lists. Re-run with --commit to write ${toInsert.length} project(s).`);
    process.exit(0);
  }

  // ── COMMIT: insert projects + finance lines ────────────────────────────────
  const usedCodes = new Set((await sql`SELECT code FROM projects`).map((x) => x.code));
  function uniqueCode(base) { if (!usedCodes.has(base)) { usedCodes.add(base); return base; } let n = 2; while (usedCodes.has(`${base}-${n}`)) n++; const c = `${base}-${n}`; usedCodes.add(c); return c; }

  let done = 0;
  for (const { r, b, v, o, et } of toInsert) {
    const start = String(r.start || "").slice(0, 10);
    const [yy, mm] = start.split("-");
    const state = v.state || null;
    const isSolo = (et.slug || "").toLowerCase() === "solo" || r.event_type === "Roadshow";
    const orgSlug = isSolo ? "SOLO" : (slug(o) || "SOLO");
    const base = `${yy}-${mm}-${orgSlug}-${slug(state)}-${slug(v.name)}-${slug(b)}`;
    const code = uniqueCode(base);
    const name = `${state ? state + " " : ""}[${b}] ${o} @ ${v.name}`;

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
