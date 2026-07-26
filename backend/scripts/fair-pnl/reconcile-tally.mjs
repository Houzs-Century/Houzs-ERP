// STEP 6 TALLY (READ-ONLY, no commit mode). Reconciles the PMS against the owner's Excel
// (seed_data_final.json) for scope 2024-01-01..2026-06-30, per YEAR and per MONTH and grand
// total, on: event/project COUNT, REVENUE, COGS, RENTAL, SETUP. PMS metrics use the SAME
// definitions the app's Profitability report uses (backend/src/routes/projects.ts): revenue =
// finance lines kind='income'; COGS = kind='cost' AND category IN
// ('cogs','cogs_matt_sofa','cogs_bedframe','cogs_accessories'); rental = category='rental';
// setup = category='setup'; all archived_at IS NULL. PMS lines are bucketed by their PROJECT's
// start month (event month), to compare like-for-like with the Excel event month. Excel events
// are counted as raw JSON rows (two brands at one venue+date = two events). Writes NOTHING.
import postgres from "postgres";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(1); }
const sql = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 30 });

const toRm = (v) => Math.round(Number(v || 0));
const ym = (d) => String(d || "").slice(0, 7);       // YYYY-MM
const yr = (d) => String(d || "").slice(0, 4);       // YYYY
const COGS_CATS = new Set(["cogs", "cogs_matt_sofa", "cogs_bedframe", "cogs_accessories"]);
const METRICS = ["count", "revenue", "cogs", "rental", "setup"];
const blank = () => ({ count: 0, revenue: 0, cogs: 0, rental: 0, setup: 0 });
const add = (a, b) => { for (const m of METRICS) a[m] += b[m]; return a; };
const fmt = (n) => Math.round(n).toLocaleString("en-US");
const pad = (s, w) => String(s).padStart(w);
const padr = (s, w) => String(s).padEnd(w);
const pct = (pms, ex) => { if (ex === 0) return pms === 0 ? "0.0%" : "n/a"; return ((pms - ex) / ex * 100).toFixed(1) + "%"; };

function row(label, pms, ex) {
  const diff = pms - ex;
  const flag = Math.abs(diff) >= 1 ? "  <== DIFF" : "";
  return `   ${padr(label, 9)} PMS ${pad(fmt(pms), 15)}  Excel ${pad(fmt(ex), 15)}  diff ${pad(fmt(diff), 15)}  ${pad(pct(pms, ex), 8)}${flag}`;
}
function block(title, pms, ex) {
  console.log(`\n--- ${title} ---`);
  console.log(row("COUNT", pms.count, ex.count));
  console.log(row("REVENUE", pms.revenue, ex.revenue));
  console.log(row("COGS", pms.cogs, ex.cogs));
  console.log(row("RENTAL", pms.rental, ex.rental));
  console.log(row("SETUP", pms.setup, ex.setup));
}

async function main() {
  // ---- Excel side (per project/event row) ----
  const events = JSON.parse(fs.readFileSync(path.join(HERE, "seed_data_final.json"), "utf8"))
    .filter((r) => r.start && r.start >= "2024-01-01" && r.start < "2026-07-01");
  const exMonth = new Map();
  const exEvents = new Map(); // month -> events (for contributor drill-down)
  for (const e of events) {
    const k = ym(e.start);
    const bucket = exMonth.get(k) || exMonth.set(k, blank()).get(k);
    bucket.count += 1;
    bucket.revenue += toRm(e.sales);
    bucket.cogs += toRm(e.cogs_m) + toRm(e.cogs_b) + toRm(e.cogs_a);
    bucket.rental += toRm(e.rental);
    bucket.setup += toRm(e.setup);
    (exEvents.get(k) || exEvents.set(k, []).get(k)).push(e);
  }

  // ---- PMS side (per project, bucketed by project start month) ----
  const projRows = await sql`
    SELECT p.id, p.brand, p.venue, p.start_date, p.created_by,
           COALESCE(SUM(l.amount) FILTER (WHERE l.kind='income' AND l.archived_at IS NULL), 0) AS revenue,
           COALESCE(SUM(l.amount) FILTER (WHERE l.kind='cost' AND l.archived_at IS NULL
                     AND l.category IN ('cogs','cogs_matt_sofa','cogs_bedframe','cogs_accessories')), 0) AS cogs,
           COALESCE(SUM(l.amount) FILTER (WHERE l.kind='cost' AND l.archived_at IS NULL AND l.category='rental'), 0) AS rental,
           COALESCE(SUM(l.amount) FILTER (WHERE l.kind='cost' AND l.archived_at IS NULL AND l.category='setup'), 0) AS setup
    FROM projects p LEFT JOIN project_finance_lines l ON l.project_id = p.id
    WHERE p.archived_at IS NULL AND p.start_date >= '2024-01-01' AND p.start_date < '2026-07-01'
    GROUP BY p.id`;
  const pmsMonth = new Map();
  const pmsProjs = new Map();
  for (const p of projRows) {
    const k = ym(p.start_date);
    const bucket = pmsMonth.get(k) || pmsMonth.set(k, blank()).get(k);
    bucket.count += 1;
    bucket.revenue += toRm(p.revenue);
    bucket.cogs += toRm(p.cogs);
    bucket.rental += toRm(p.rental);
    bucket.setup += toRm(p.setup);
    (pmsProjs.get(k) || pmsProjs.set(k, []).get(k)).push(p);
  }

  const months = [...new Set([...exMonth.keys(), ...pmsMonth.keys()])].sort();
  const years = [...new Set(months.map((m) => m.slice(0, 4)))].sort();

  console.log(`\n=================================================================`);
  console.log(`  FAIR PNL TALLY — PMS vs Excel  (READ-ONLY)  scope 2024-01..2026-06`);
  console.log(`=================================================================`);
  console.log(`  Excel event rows in scope: ${events.length}   PMS projects in scope: ${projRows.length}`);

  // Grand total
  const gPms = blank(), gEx = blank();
  for (const b of pmsMonth.values()) add(gPms, b);
  for (const b of exMonth.values()) add(gEx, b);
  block("GRAND TOTAL 2024-01..2026-06", gPms, gEx);

  // Per year
  for (const y of years) {
    const pms = blank(), ex = blank();
    for (const [m, b] of pmsMonth) if (m.slice(0, 4) === y) add(pms, b);
    for (const [m, b] of exMonth) if (m.slice(0, 4) === y) add(ex, b);
    block(`YEAR ${y}`, pms, ex);
  }

  // Per month
  console.log(`\n\n================  PER-MONTH  ================`);
  const mism = []; // {month, metric, pms, ex}
  for (const m of months) {
    const pms = pmsMonth.get(m) || blank();
    const ex = exMonth.get(m) || blank();
    block(`MONTH ${m}`, pms, ex);
    for (const metric of METRICS) if (Math.abs(pms[metric] - ex[metric]) >= 1) mism.push({ month: m, metric, pms: pms[metric], ex: ex[metric] });
  }

  // Mismatch drill-down: top contributors per (month, metric)
  console.log(`\n\n================  MISMATCH DRILL-DOWN (${mism.length} month/metric cells differ)  ================`);
  const field = { revenue: "revenue", cogs: "cogs", rental: "rental", setup: "setup" };
  for (const mm of mism.sort((a, b) => Math.abs(b.pms - b.ex) - Math.abs(a.pms - a.ex)).slice(0, 40)) {
    console.log(`\n  ${mm.month}  ${mm.metric.toUpperCase()}  PMS ${fmt(mm.pms)} vs Excel ${fmt(mm.ex)}  (diff ${fmt(mm.pms - mm.ex)})`);
    if (mm.metric === "count") {
      console.log(`     PMS ${mm.pms} project(s), Excel ${mm.ex} event(s) that month`);
      continue;
    }
    const f = field[mm.metric];
    const exTop = (exEvents.get(mm.month) || []).map((e) => ({ label: `${e.start} [${e.brand}] @ ${e.venue}`, v: mm.metric === "cogs" ? toRm(e.cogs_m) + toRm(e.cogs_b) + toRm(e.cogs_a) : toRm(e[f]) }))
      .filter((x) => x.v > 0).sort((a, b) => b.v - a.v).slice(0, 4);
    const pmsTop = (pmsProjs.get(mm.month) || []).map((p) => ({ label: `p${p.id} [${p.brand}] @ ${p.venue} by=${p.created_by}`, v: toRm(p[f]) }))
      .filter((x) => x.v > 0).sort((a, b) => b.v - a.v).slice(0, 4);
    console.log(`     Excel top: ${exTop.map((x) => `${x.label}=${fmt(x.v)}`).join(" | ") || "(none)"}`);
    console.log(`     PMS   top: ${pmsTop.map((x) => `${x.label}=${fmt(x.v)}`).join(" | ") || "(none)"}`);
  }
  if (mism.length > 40) console.log(`\n   ... +${mism.length - 40} more month/metric diffs (top 40 shown by magnitude)`);
  console.log(`\nTALLY complete (read-only). ${mism.length} month/metric cells differ between PMS and Excel.`);
}
main().then(() => sql.end()).catch((e) => { console.error(e); process.exit(1); });
