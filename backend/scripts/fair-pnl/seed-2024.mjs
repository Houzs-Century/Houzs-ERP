// FAIR PNL 2024 backfill — creates the 146 historical 2024 roadshow projects that
// are absent from PMS (verified: PMS holds only 3 projects with any 2024 date).
// DRY-RUN by default (reads only). Pass --commit to write.
// Data: seed2024_final.json (146 records, owner-reviewed; venue/organizer/brand/
// event_type all aligned to the maintained pickers; rental/setup already
// revenue-split for Solo multi-brand; 2024 COGS is total-only in cogs_matt_sofa).
import postgres from "postgres";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMMIT = process.argv.includes("--commit");
const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(1); }
const sql = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 30 });

const norm = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const slug = (s) => String(s ?? "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "");
const toRm = (v) => Math.round(Number(v || 0));
const days = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);

async function main() {
  const rows = JSON.parse(fs.readFileSync(path.join(HERE, "seed2024_final.json"), "utf8"));
  const [brands, venues, organizers, etypes, existing, houzs, codes] = await Promise.all([
    sql`SELECT name FROM project_brands WHERE COALESCE(active,1)=1`,
    sql`SELECT name, state FROM project_venues`,
    sql`SELECT name FROM project_organizers`,
    sql`SELECT id, name FROM project_event_types`,
    sql`SELECT brand, venue, start_date FROM projects WHERE archived_at IS NULL`,
    sql`SELECT id FROM companies WHERE code = 'HOUZS' LIMIT 1`,
    sql`SELECT code FROM projects`,
  ]);
  const companyId = houzs[0]?.id ?? null;
  const brandSet = new Set(brands.map((b) => norm(b.name)));
  const orgSet = new Set(organizers.map((o) => norm(o.name)));
  const venueByNorm = new Map(venues.map((v) => [norm(v.name), v]));
  const etByName = new Map(etypes.map((e) => [norm(e.name), e]));

  console.log(`\n=== FAIR PNL 2024 seed — ${COMMIT ? "COMMIT" : "DRY-RUN (read-only)"} ===`);
  console.log(`company HOUZS(id ${companyId})  |  seed rows ${rows.length}  |  existing projects ${existing.length}`);

  // ── validate every value resolves to a picker ──
  const problems = [];
  for (const r of rows) {
    if (!brandSet.has(norm(r.brand))) problems.push(`brand not in picker: ${r.brand}`);
    if (r.organizer && !orgSet.has(norm(r.organizer))) problems.push(`organizer not in picker: ${r.organizer}`);
    if (!etByName.has(norm(r.event_type))) problems.push(`event_type not in picker: ${r.event_type}`);
    if (!r.start || !/^\d{4}-\d{2}-\d{2}$/.test(r.start)) problems.push(`bad start: ${r.brand} ${r.venue} ${r.start}`);
  }
  if (problems.length) { console.log(`\nBLOCKERS (${problems.length}):`); [...new Set(problems)].forEach((p) => console.log("  - " + p)); console.log("\nAbort — fix picker values first."); return; }

  // ── new venues to create ──
  const toCreate = new Map();
  for (const r of rows) if (!venueByNorm.has(norm(r.venue))) toCreate.set(norm(r.venue), { name: r.venue, state: r.state || null });
  console.log(`\n[NEW venues to create in project_venues — ${toCreate.size}]`);
  for (const nv of toCreate.values()) console.log(`  + ${nv.name}  [${nv.state}]`);

  // ── dedup vs existing (idempotency): skip if same brand+venue within 10 days already exists ──
  const exByBV = new Map();
  for (const p of existing) { const k = `${norm(p.brand)}|${norm(p.venue)}`; (exByBV.get(k) || exByBV.set(k, []).get(k)).push(p.start_date); }
  const toInsert = [], skipped = [];
  for (const r of rows) {
    const hits = (exByBV.get(`${norm(r.brand)}|${norm(r.venue)}`) || []).filter((d) => days(d, r.start) <= 10);
    if (hits.length) skipped.push(r); else toInsert.push(r);
  }
  console.log(`\nto INSERT: ${toInsert.length}   already-present (SKIP): ${skipped.length}`);
  for (const r of skipped) console.log(`  skip: ${r.start} [${r.brand}] @ ${r.venue}`);

  const sumL = (f) => toInsert.reduce((a, r) => a + toRm(r[f]), 0);
  console.log(`\nfinance to write (RM): sales ${sumL("sales").toLocaleString()} | cogs ${sumL("cogs_matt_sofa").toLocaleString()} | rental ${sumL("rental").toLocaleString()} | setup ${sumL("setup").toLocaleString()}`);

  if (!COMMIT) {
    console.log(`\nDRY-RUN OK — --commit would create ${toCreate.size} venue(s) + insert ${toInsert.length} project(s) with finance lines.`);
    return;
  }

  // ── COMMIT ──
  for (const nv of toCreate.values()) {
    await sql`INSERT INTO project_venues (name, state, created_by, company_id) VALUES (${nv.name}, ${nv.state}, 0, ${companyId})`;
    venueByNorm.set(norm(nv.name), nv);
  }
  console.log(`created ${toCreate.size} venues`);
  const used = new Set(codes.map((c) => c.code));
  const uniqueCode = (base) => { if (!used.has(base)) { used.add(base); return base; } let n = 2; while (used.has(`${base}-${n}`)) n++; const c = `${base}-${n}`; used.add(c); return c; };
  let done = 0;
  for (const r of toInsert) {
    const start = r.start, end = String(r.end || r.start).slice(0, 10);
    const [yy, mm] = start.split("-");
    const et = etByName.get(norm(r.event_type));
    const orgSlug = r.organizer ? slug(r.organizer) : "SOLO";
    const code = uniqueCode(`${yy}-${mm}-${orgSlug}-${slug(r.state)}-${slug(r.venue)}-${slug(r.brand)}`);
    const [proj] = await sql`
      INSERT INTO projects (code, name, stage, status, event_type_id, brand, start_date, end_date, venue, state, organizer, created_by, company_id)
      VALUES (${code}, ${r.name}, 'completed', 'confirmed', ${et.id}, ${r.brand}, ${start}, ${end}, ${r.venue}, ${r.state || null}, ${r.organizer || null}, 0, ${companyId})
      RETURNING id`;
    const lines = [["income", "sales", r.sales], ["cost", "cogs_matt_sofa", r.cogs_matt_sofa], ["cost", "rental", r.rental], ["cost", "setup", r.setup]]
      .filter(([, , amt]) => toRm(amt) > 0);
    for (const [kind, cat, amt] of lines)
      await sql`INSERT INTO project_finance_lines (project_id, kind, category, description, amount, occurred_at, company_id)
                VALUES (${proj.id}, ${kind}, ${cat}, ${cat + " (FAIR PNL 2024 seed)"}, ${toRm(amt)}, ${start}, ${companyId})`;
    if (++done % 25 === 0) console.log(`  inserted ${done}/${toInsert.length}...`);
  }
  console.log(`\nCOMMIT DONE — created ${toCreate.size} venues + ${done} projects.`);
}
main().then(() => sql.end()).catch((e) => { console.error(e); process.exit(1); });
