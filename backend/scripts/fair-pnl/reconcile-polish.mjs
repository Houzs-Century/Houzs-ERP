// FAIR PNL POLISH (owner 2026-07-27). Three independently dry-runnable passes; --commit gates writes.
// Scope 2024-01-01 .. 2026-07-01 (through June; July+ future placeholders never touched).
//
//   --pass=fields   (safe UPDATEs, no deletes): fixes the calendar PENDING badge (status
//                   pending->confirmed for past events), canonicalizes STATE to the 16 Title-Case
//                   names, aligns VENUE/BRAND/ORGANIZER to the maintained pickers, and rebuilds the
//                   project NAME from the app template <state> [<brand>] <organizer|SOLO> @ <venue>
//                   so casing is uniform (fixes the ALL-CAPS-vs-Title-Case mix).
//   --pass=autocost (money INSERT/UPDATE): backfills the auto cost lines transport_fee / merchandise
//                   / commission from project_cost_rates, replicating recomputeAutoCostLines() to the
//                   ringgit (all % of sales, boost only if commission_boost_pct set AND gp%>=boost_min_gp
//                   AND sales>=boost_min_sales). Keyed by auto_source, so re-runs update in place.
//   --pass=dedup    (destructive, conservative): one Excel event matched by >1 live project -> keep the
//                   richest; DELETE only the duplicates that are empty AND hold zero photos/attachments.
//                   Data- or file-carrying duplicates are FLAGGED for the owner, never auto-deleted.
import postgres from "postgres";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PASS = (process.argv.find((a) => a.startsWith("--pass=")) || "").split("=")[1] || "";
const COMMIT = process.argv.includes("--commit");
const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(1); }
if (!["fields", "autocost", "dedup"].includes(PASS)) { console.error("need --pass=fields|autocost|dedup"); process.exit(1); }
const sql = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 30 });

const SCOPE_LO = "2024-01-01", SCOPE_HI = "2026-07-01";
const norm = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const rm = (n) => Number(n || 0).toLocaleString();

// ---- STATE: canonicalize to the 16 Title-Case names (mirrors scm/lib/canonical-state.ts) ----
const CANON_STATE = {
  JOHOR: "Johor", JB: "Johor", JHB: "Johor", JOHORBAHRU: "Johor",
  KEDAH: "Kedah", KELANTAN: "Kelantan",
  KL: "Kuala Lumpur", KUALALUMPUR: "Kuala Lumpur", WPKUALALUMPUR: "Kuala Lumpur", WILAYAHPERSEKUTUAN: "Kuala Lumpur",
  LABUAN: "Labuan", WPLABUAN: "Labuan",
  MELAKA: "Melaka", MALACCA: "Melaka", MLK: "Melaka",
  NEGERISEMBILAN: "Negeri Sembilan", NS: "Negeri Sembilan", NSEMBILAN: "Negeri Sembilan",
  PAHANG: "Pahang", PERAK: "Perak", PERLIS: "Perlis",
  PENANG: "Pulau Pinang", PULAUPINANG: "Pulau Pinang", PG: "Pulau Pinang", PNG: "Pulau Pinang",
  PUTRAJAYA: "Putrajaya", WPPUTRAJAYA: "Putrajaya",
  SABAH: "Sabah", SARAWAK: "Sarawak", SELANGOR: "Selangor", SEL: "Selangor",
  TERENGGANU: "Terengganu", TRENGGANU: "Terengganu",
};
const canonState = (s) => CANON_STATE[norm(s)] ?? (String(s ?? "").trim() || null);

// ---- VENUE canonicalization (same rules as reconcile-audit) then match to maintained picker ----
const STATE_TAIL = /\b(KL|PG|PNG|JB|JHB|PJ|MLK|NS|SWK|SEL|SELANGOR|PENANG|JOHOR|KEDAH|PERAK|PERLIS|PAHANG|MELAKA|MALACCA|KELANTAN|TERENGGANU|SABAH|SARAWAK|NEGERI\s*SEMBILAN|PUTRAJAYA|IPOH|KUANTAN|SEREMBAN)\b\s*$/i;
const ABBR = [[/\bTMN\b/gi, "TAMAN"], [/\bBKT\b/gi, "BUKIT"], [/\bBUKTI\b/gi, "BUKIT"], [/\bMILLENIUM\b/gi, "MILLENNIUM"]];
const expandAbbr = (s) => { let v = String(s ?? ""); for (const [re, to] of ABBR) v = v.replace(re, to); return v; };
const venueNorm = (s) => { let v = expandAbbr(String(s ?? "").trim()); for (let i = 0; i < 3; i++) v = v.replace(STATE_TAIL, "").trim(); return norm(v); };
function canonVenueOld(raw) {
  const u = norm(raw);
  if (u.includes("SOUTHKEY")) return "MVEC SOUTHKEY";
  if (u.includes("MVEC") || u.includes("MIDVALLEY")) return "MID VALLEY";
  if (u.includes("PAVILION") || u.includes("PAVILLION")) return "PAVILION BUKIT JALIL";
  if (u.includes("STADIUM") && u.includes("JALIL")) return "STADIUM BUKIT JALIL";
  if (u.includes("STARLING")) return "THE STARLING MALL";
  if (u.includes("SUNWAYCARNIVAL")) return "SUNWAY CARNIVAL MALL";
  if (u.includes("SPCC") || u.includes("SUNWAYPYRAMID")) return "SPCC";
  if (u.includes("SSCC") || u.includes("SETIASPICE")) return "SETIA SPICE CONVENTION CENTRE";
  if (u.includes("SPICEARENA") || u.includes("PISA")) return "PISA SPICE ARENA CONVENTION CENTRE";
  if (u.includes("IOICITYMALL")) return "IOI MALL PUTRAJAYA";
  if (u.includes("IOIDAMANSARA")) return "IOI MALL DAMANSARA";
  if (u.includes("TERBAU") || u.includes("TEBRAU")) return "AEON TEBRAU CITY";
  if (u.includes("PERSADA")) return "PERSADA JOHOR INTERNATIONAL CONVENTION CENTRE";
  if (u.includes("VIVACITY")) return "VIVACITY MEGAMALL";
  if (u.includes("BOULEVARD") && u.includes("MIRI")) return "BOULEVARD SHOPPING MALL MIRI";
  if (u.includes("ALMA") && u.includes("MERTAJAM")) return "AEON BUKIT MERTAJAM";
  if (u.includes("AEONCHERAS") && !u.includes("SELATAN")) return "AEON TAMAN MALURI";
  if (u.includes("BCCK")) return "BCCK KUCHING";
  if (u.includes("SCCC") || u.includes("SETIACITY")) return "SCCC SHAH ALAM";
  if (u.includes("METROCITY") || (u.includes("MCC") && u.includes("KUCHING"))) return "KUCHING METROCITY CONVENTION CENTRE";
  if ((u.includes("INDERAMULIA") || u.includes("ENDERAMULIA")) || (u.includes("STADIUM") && u.includes("IPOH"))) return "STADIUM INDERA MULIA IPOH";
  return raw;
}
const RENAME = {
  MITC: "MELAKA INTERNATIONAL TRADE CENTRE", MITEC: "MALAYSIA INTERNATIONAL TRADE AND EXHIBITION CENTRE",
  "BCCK KUCHING": "BORNEO CONVENTION CENTRE KUCHING", "SCCC SHAH ALAM": "SETIA CITY CONVENTION CENTRE",
  "KLCC CONVENTION CENTRE": "KUALA LUMPUR CONVENTION CENTRE", PWCC: "PENANG WATERFRONT CONVENTION CENTRE",
  SPCC: "SUNWAY PYRAMID CONVENTION CENTRE", SICC: "SABAH INTERNATIONAL CONVENTION CENTRE",
  ITCC: "INTERNATIONAL TECHNOLOGY AND COMMERCIAL CENTRE", "AICC AUSTIN": "AUSTIN INTERNATIONAL CONVENTION CENTRE",
  "PICCA BUTTERWORTH ARENA": "PENANG INTERNATIONAL CONVENTION CULTURAL AND ARTS CENTRE",
  "DATARAN PAHLAWAN": "DATARAN PAHLAWAN MELAKA MEGAMALL",
  "DATARAN CENTRIO SEREMBAN": "DATARAN CENTRIO", "EAST COAST MALL KUANTAN": "EAST COAST MALL",
  "IOI DAMANSARA": "IOI MALL DAMANSARA", "MCCC KUCHING": "KUCHING METROCITY CONVENTION CENTRE",
};
const KWRENAME = [
  [/\bMITEC\b/, "MALAYSIA INTERNATIONAL TRADE AND EXHIBITION CENTRE"], [/\bMITC\b/, "MELAKA INTERNATIONAL TRADE CENTRE"],
  [/\bKLCC\b/, "KUALA LUMPUR CONVENTION CENTRE"], [/\bPWCC\b/, "PENANG WATERFRONT CONVENTION CENTRE"],
  [/\bSPCC\b|SUNWAY\s*PYRAMID/, "SUNWAY PYRAMID CONVENTION CENTRE"], [/\bSCCC\b|SETIA\s*CITY/, "SETIA CITY CONVENTION CENTRE"],
  [/\bBCCK\b/, "BORNEO CONVENTION CENTRE KUCHING"], [/\bSICC\b/, "SABAH INTERNATIONAL CONVENTION CENTRE"],
  [/\bITCC\b/, "INTERNATIONAL TECHNOLOGY AND COMMERCIAL CENTRE"], [/\bAICC\b/, "AUSTIN INTERNATIONAL CONVENTION CENTRE"],
  [/\bPICCA\b/, "PENANG INTERNATIONAL CONVENTION CULTURAL AND ARTS CENTRE"],
];
const canonVenue = (raw) => {
  const u = " " + String(raw ?? "").toUpperCase() + " ";
  for (const [re, name] of KWRENAME) if (re.test(u)) return name;
  const old = canonVenueOld(raw);
  return RENAME[old] ?? old;
};
const bnorm = (b) => { const n = norm(b); return n === "AKEMICC" ? "AKEMI" : n; };
const days = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);
const deriveName = (state, brand, org, venue) =>
  `${(state && state.trim()) || "—"} [${(brand && brand.trim()) || "—"}] ${(org && org.trim()) || "SOLO"} @ ${(venue && venue.trim()) || "—"}`;

async function loadPicker(table) {
  try {
    const rows = await sql`SELECT name, active FROM ${sql(table)}`;
    const byNorm = new Map();
    for (const r of rows.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0))) if (!byNorm.has(norm(r.name))) byNorm.set(norm(r.name), r.name);
    return byNorm;
  } catch { return new Map(); }
}

async function passFields() {
  const venuesByNorm = new Map(); // venueNorm -> maintained name
  try {
    const vrows = await sql`SELECT name, active FROM project_venues`;
    for (const r of vrows.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0))) { const k = venueNorm(r.name); if (!venuesByNorm.has(k)) venuesByNorm.set(k, r.name); }
  } catch {}
  const brandByNorm = await loadPicker("project_brands");
  const orgByNorm = await loadPicker("project_organizers");

  const projects = await sql`
    SELECT id, state, venue, brand, organizer, name, status, start_date, created_by
    FROM projects WHERE archived_at IS NULL AND start_date >= ${SCOPE_LO} AND start_date < ${SCOPE_HI}`;

  const changes = []; const venueUnmatched = new Map(); let statusFix = 0, stateFix = 0, venueFix = 0, brandFix = 0, orgFix = 0, nameFix = 0;
  for (const p of projects) {
    const newState = canonState(p.state);
    const newBrand = brandByNorm.get(norm(p.brand)) ?? (p.brand ? String(p.brand).trim() : p.brand);
    const newOrg = p.organizer ? (orgByNorm.get(norm(p.organizer)) ?? String(p.organizer).trim()) : p.organizer;
    // venue: canonicalize then require a maintained-picker match; otherwise keep as-is and flag.
    const canon = canonVenue(p.venue);
    const vk = venueNorm(canon);
    let newVenue = p.venue;
    if (venuesByNorm.has(vk)) newVenue = venuesByNorm.get(vk);
    else if (String(canon).trim() && norm(canon) !== norm(p.venue)) { newVenue = canon; venueUnmatched.set(p.id, `${p.venue} -> ${canon} (not in picker)`); }
    else if (!venuesByNorm.has(vk)) venueUnmatched.set(p.id, `${p.venue} (not in picker)`);
    // status: a past event cannot be "pending" (tentative). confirmed/cancelled left alone.
    const newStatus = p.status === "pending" ? "confirmed" : p.status;
    const newName = deriveName(newState, newBrand, newOrg, newVenue);

    const diff = {};
    if ((newStatus ?? "") !== (p.status ?? "")) { diff.status = [p.status, newStatus]; statusFix++; }
    if ((newState ?? "") !== (p.state ?? "")) { diff.state = [p.state, newState]; stateFix++; }
    if ((newVenue ?? "") !== (p.venue ?? "")) { diff.venue = [p.venue, newVenue]; venueFix++; }
    if ((newBrand ?? "") !== (p.brand ?? "")) { diff.brand = [p.brand, newBrand]; brandFix++; }
    if ((newOrg ?? "") !== (p.organizer ?? "")) { diff.organizer = [p.organizer, newOrg]; orgFix++; }
    if ((newName ?? "") !== (p.name ?? "")) { diff.name = [p.name, newName]; nameFix++; }
    if (Object.keys(diff).length) changes.push({ p, newState, newVenue, newBrand, newOrg, newName, newStatus, diff });
  }

  console.log(`\n=== POLISH pass=fields — ${COMMIT ? "COMMIT" : "DRY-RUN"} (scope ${SCOPE_LO}..${SCOPE_HI}) ===`);
  console.log(`in-scope projects: ${projects.length}   projects changing: ${changes.length}`);
  console.log(`  status pending->confirmed: ${statusFix}   state canon: ${stateFix}   venue: ${venueFix}   brand: ${brandFix}   organizer: ${orgFix}   name rebuilt: ${nameFix}`);
  console.log(`\n[sample changes — up to 40]`);
  for (const c of changes.slice(0, 40)) {
    const parts = Object.entries(c.diff).map(([k, [a, b]]) => `${k}: "${a ?? ""}" -> "${b ?? ""}"`);
    console.log(`  p${c.p.id} by${c.p.created_by} ${c.p.start_date}\n     ${parts.join("\n     ")}`);
  }
  if (venueUnmatched.size) {
    console.log(`\n[VENUE not in maintained picker: ${venueUnmatched.size} — owner may need to add these to the venue list]`);
    for (const [id, msg] of [...venueUnmatched].slice(0, 30)) console.log(`   p${id}: ${msg}`);
  }
  if (!COMMIT) { console.log(`\nDRY-RUN OK. --commit will UPDATE ${changes.length} project(s). No deletes, no finance lines touched.`); return; }
  for (const c of changes)
    await sql`UPDATE projects SET status=${c.newStatus}, state=${c.newState}, venue=${c.newVenue}, brand=${c.newBrand}, organizer=${c.newOrg}, name=${c.newName} WHERE id=${c.p.id}`;
  console.log(`\nCOMMIT done: updated ${changes.length} project(s).`);
}

async function passAutocost() {
  const rates = await sql`SELECT brand, transport_pct, merchandise_pct, commission_normal_pct, commission_boost_pct, boost_min_gp_pct, boost_min_sales FROM project_cost_rates`;
  const rateByNorm = new Map(); for (const r of rates) rateByNorm.set(norm(r.brand), r);
  const projects = await sql`
    SELECT p.id, p.brand, p.start_date, p.company_id,
           COALESCE(SUM(l.amount) FILTER (WHERE l.kind='income' AND l.category='sales' AND l.auto_source IS NULL AND l.archived_at IS NULL),0) sales,
           COALESCE(SUM(l.amount) FILTER (WHERE l.kind='cost' AND l.category IN ('cogs','cogs_matt_sofa','cogs_bedframe','cogs_accessories') AND l.auto_source IS NULL AND l.archived_at IS NULL),0) cogs
    FROM projects p LEFT JOIN project_finance_lines l ON l.project_id = p.id
    WHERE p.archived_at IS NULL AND p.start_date >= ${SCOPE_LO} AND p.start_date < ${SCOPE_HI}
    GROUP BY p.id`;

  const plan = []; const noRate = new Set(); let tT = 0, tM = 0, tC = 0;
  for (const p of projects) {
    const sales = Number(p.sales); if (sales <= 0) continue;
    const rate = rateByNorm.get(norm(p.brand)) ?? rateByNorm.get(bnorm(p.brand));
    if (!rate) { noRate.add(p.brand); continue; }
    const cogs = Number(p.cogs);
    const gpPct = ((sales - cogs) / sales) * 100;
    const gpGate = rate.boost_min_gp_pct == null || gpPct >= Number(rate.boost_min_gp_pct);
    const salesGate = rate.boost_min_sales == null || sales >= Number(rate.boost_min_sales);
    const useBoost = rate.commission_boost_pct != null && gpGate && salesGate;
    const commPct = useBoost ? Number(rate.commission_boost_pct) : Number(rate.commission_normal_pct);
    const lines = [
      ["auto:transport", "transport_fee", `Transport Fee (auto . ${Number(rate.transport_pct)}% of sales)`, Math.round((sales * Number(rate.transport_pct)) / 100)],
      ["auto:merchandise", "merchandise", `Merchandise (auto . ${Number(rate.merchandise_pct)}% of sales)`, Math.round((sales * Number(rate.merchandise_pct)) / 100)],
      ["auto:commission", "commission", `Commission (auto . ${commPct}% of sales${useBoost ? " - boost tier" : ""})`, Math.round((sales * commPct) / 100)],
    ].filter((x) => x[3] > 0);
    tT += lines.find((l) => l[0] === "auto:transport")?.[3] || 0;
    tM += lines.find((l) => l[0] === "auto:merchandise")?.[3] || 0;
    tC += lines.find((l) => l[0] === "auto:commission")?.[3] || 0;
    plan.push({ p, sales, cogs, gpPct, useBoost, commPct, lines });
  }

  console.log(`\n=== POLISH pass=autocost — ${COMMIT ? "COMMIT" : "DRY-RUN"} (scope ${SCOPE_LO}..${SCOPE_HI}) ===`);
  console.log(`projects with sales>0 to backfill: ${plan.length}`);
  console.log(`totals to add:  transport RM ${rm(tT)}   merchandise RM ${rm(tM)}   commission RM ${rm(tC)}   (grand RM ${rm(tT + tM + tC)})`);
  if (noRate.size) console.log(`  NO cost_rates row for brand(s): ${JSON.stringify([...noRate])} — those projects skipped`);
  console.log(`\n[sample — up to 30]`);
  for (const { p, sales, useBoost, commPct, lines } of plan.slice(0, 30))
    console.log(`  p${p.id} [${p.brand}] sales=${rm(sales)} comm=${commPct}%${useBoost ? "(boost)" : ""}  ->  ${lines.map((l) => `${l[1]}=${rm(l[3])}`).join(", ")}`);

  if (!COMMIT) { console.log(`\nDRY-RUN OK. --commit will upsert up to ${plan.length * 3} auto cost line(s) (keyed by auto_source).`); return; }
  let ins = 0, upd = 0;
  for (const { p, lines } of plan) {
    for (const [src, cat, desc, amt] of lines) {
      const ex = await sql`SELECT id FROM project_finance_lines WHERE project_id=${p.id} AND auto_source=${src} AND archived_at IS NULL LIMIT 1`;
      if (ex.length) { await sql`UPDATE project_finance_lines SET amount=${amt}, category=${cat}, description=${desc}, occurred_at=${p.start_date} WHERE id=${ex[0].id}`; upd++; }
      else { await sql`INSERT INTO project_finance_lines (project_id, kind, category, description, amount, occurred_at, company_id, auto_source) VALUES (${p.id},'cost',${cat},${desc},${amt},${p.start_date},${p.company_id},${src})`; ins++; }
    }
  }
  console.log(`\nCOMMIT done: inserted ${ins}, updated ${upd} auto cost line(s) across ${plan.length} project(s).`);
}

async function passDedup() {
  const events = JSON.parse(fs.readFileSync(path.join(HERE, "seed_data_final.json"), "utf8")).filter((r) => r.start && r.start >= SCOPE_LO && r.start < SCOPE_HI);
  const eidx = new Map();
  for (const e of events) { const k = `${bnorm(e.brand)}|${venueNorm(canonVenue(e.venue))}`; (eidx.get(k) || eidx.set(k, []).get(k)).push(e); }
  const projects = await sql`
    SELECT p.id, p.brand, p.venue, p.start_date, p.created_by,
           COALESCE(SUM(l.amount) FILTER (WHERE l.kind='income' AND l.archived_at IS NULL),0) income,
           COUNT(l.id) FILTER (WHERE l.archived_at IS NULL) nlines,
           (SELECT COUNT(*)::int FROM project_phase_photos ph WHERE ph.project_id = p.id) nphotos,
           (SELECT COUNT(*)::int FROM project_attachments a WHERE a.project_id = p.id) nattach
    FROM projects p LEFT JOIN project_finance_lines l ON l.project_id = p.id
    WHERE p.archived_at IS NULL AND p.start_date >= ${SCOPE_LO} AND p.start_date < ${SCOPE_HI}
    GROUP BY p.id`;
  const groups = new Map();
  for (const p of projects) {
    const cands = (eidx.get(`${bnorm(p.brand)}|${venueNorm(p.venue)}`) || []).filter((e) => days(e.start, p.start_date) <= 10);
    if (!cands.length) continue;
    const e = cands.sort((a, b) => days(a.start, p.start_date) - days(b.start, p.start_date))[0];
    const ek = `${bnorm(e.brand)}|${venueNorm(canonVenue(e.venue))}|${e.start}`;
    (groups.get(ek) || groups.set(ek, { e, ps: [] }).get(ek)).ps.push(p);
  }
  const score = (p) => [Number(p.income), p.nlines, p.nphotos + p.nattach, -p.id];
  const cmp = (a, b) => { const A = score(a), B = score(b); for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) return B[i] - A[i]; return 0; };
  const autoDel = []; const flagged = [];
  for (const g of [...groups.values()].filter((g) => g.ps.length > 1)) {
    const sorted = [...g.ps].sort(cmp); const keeper = sorted[0];
    for (const d of sorted.slice(1)) {
      if (Number(d.income) === 0 && d.nphotos === 0 && d.nattach === 0) autoDel.push({ d, keeper, e: g.e });
      else flagged.push({ d, keeper, e: g.e });
    }
  }
  console.log(`\n=== POLISH pass=dedup — ${COMMIT ? "COMMIT" : "DRY-RUN"} (scope ${SCOPE_LO}..${SCOPE_HI}) ===`);
  console.log(`duplicate-event groups: ${[...groups.values()].filter((g) => g.ps.length > 1).length}`);
  console.log(`  AUTO-DELETE (empty + zero files, keep richest twin): ${autoDel.length}`);
  console.log(`  FLAGGED (dup carries data or files — owner decides, NOT deleted): ${flagged.length}`);
  console.log(`\n[AUTO-DELETE]`);
  for (const { d, keeper, e } of autoDel) console.log(`   del p${d.id} (${d.start_date}, empty) keep p${keeper.id} (inc=${rm(keeper.income)})  <- Excel ${e.start} [${e.brand}] @ ${canonVenue(e.venue)}`);
  console.log(`\n[FLAGGED — needs owner call]`);
  for (const { d, keeper, e } of flagged) console.log(`   ? p${d.id} by${d.created_by} inc=${rm(d.income)} photos=${d.nphotos} attach=${d.nattach}  vs keeper p${keeper.id} inc=${rm(keeper.income)}  <- Excel ${e.start} [${e.brand}] @ ${canonVenue(e.venue)} "${d.venue}"`);
  if (!COMMIT) { console.log(`\nDRY-RUN OK. --commit deletes ONLY the ${autoDel.length} empty+fileless dup(s). Flagged ones are never touched.`); return; }
  const ids = autoDel.map((x) => x.d.id);
  if (ids.length) { await sql`DELETE FROM project_finance_lines WHERE project_id = ANY(${ids})`; await sql`DELETE FROM projects WHERE id = ANY(${ids})`; }
  console.log(`\nCOMMIT done: deleted ${ids.length} empty duplicate project(s). ${flagged.length} data/file dup(s) left for owner review.`);
}

async function main() {
  if (PASS === "fields") await passFields();
  else if (PASS === "autocost") await passAutocost();
  else if (PASS === "dedup") await passDedup();
}
main().then(() => sql.end()).catch((e) => { console.error(e); process.exit(1); });
