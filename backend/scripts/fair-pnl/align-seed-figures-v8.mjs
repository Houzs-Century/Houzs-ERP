// FAIR PNL — align SEEDED (created_by=0) project figures to the v8 aligned inventory.
// The 2024/2025/2026 gap seeds were populated from an earlier inventory version, so
// their sales/COGS/rental/setup drifted from v8 (rental especially — v8 introduced the
// revenue-split). This rewrites ONLY the seeded events' income/cost lines in the six
// canonical categories to the v8 target, keyed by project_id (see align_v8_targets.json,
// built from FAIR_PNL_aligned_inventory_v8.xlsx sheet "Events (merged)").
//
// SAFETY:
//   - Touches ONLY projects whose created_by = 0 (the seeds). Owner-entered (by=3) rows
//     are never in the target set and are re-checked here as a guard.
//   - Replaces ONLY the six categories below; transport/merchandise/commission are left to
//     recomputeAutoCostLines (run the polish autocost pass after this).
//   - occurred_at is set to the project's start_date so the finance-by-date dashboard bins
//     it in the right month.
//   - DRY-RUN by default; prints per-year before/after. --commit applies inside one tx-free
//     loop (delete+insert per project).
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const COMMIT = process.argv.includes("--commit");
const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(1); }
const sql = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 30 });
const rm = (n) => `RM ${Number(n || 0).toLocaleString("en-MY", { maximumFractionDigits: 0 })}`;

const CATS = [
  ["income", "sales", "sales"],
  ["cost", "cogs_matt_sofa", "cogs_matt_sofa"],
  ["cost", "cogs_bedframe", "cogs_bedframe"],
  ["cost", "cogs_accessories", "cogs_accessories"],
  ["cost", "rental", "rental"],
  ["cost", "setup", "setup"],
];
const CAT_NAMES = CATS.map((c) => c[1]);

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const targets = JSON.parse(readFileSync(join(here, "align_v8_targets.json"), "utf8"));
  const [{ id: companyId } = {}] = await sql`SELECT id FROM companies WHERE code='HOUZS' LIMIT 1`;

  const ids = targets.map((t) => t.pid);
  const projs = await sql`SELECT id, created_by, start_date, brand, venue FROM projects WHERE id IN ${sql(ids)}`;
  const pById = new Map(projs.map((p) => [Number(p.id), p]));

  // These targets are the EXACT+VENUE high-confidence set (see align_v8_targets.json .conf),
  // which INCLUDES owner-entered (created_by=3) events — the owner asked for those to be aligned
  // to v8 too. Report the split so the dry-run makes clear what is being touched.
  const owner = targets.filter((t) => { const p = pById.get(t.pid); return p && String(p.created_by) === "3"; }).length;
  const seed = targets.filter((t) => { const p = pById.get(t.pid); return p && String(p.created_by) === "0"; }).length;
  console.log(`targets by creator: OWNER(by=3) ${owner} | seed(by=0) ${seed} | other ${targets.length - owner - seed}`);
  const missing = targets.filter((t) => !pById.has(t.pid));
  if (missing.length) console.log(`note: ${missing.length} target project(s) not found (archived?) — skipped`);

  // Current sums per category (live), for before/after.
  const cur = await sql`
    SELECT project_id, category, COALESCE(SUM(amount),0)::bigint amt
    FROM project_finance_lines
    WHERE project_id IN ${sql(ids)} AND category IN ${sql(CAT_NAMES)}
    GROUP BY 1,2`;
  const curBy = new Map();
  for (const r of cur) curBy.set(`${r.project_id}|${r.category}`, Number(r.amt));

  // Per-year before/after tally.
  const yr = {};
  const add = (y, k, v) => { (yr[y] = yr[y] || { beforeInc: 0, afterInc: 0, beforeCost: 0, afterCost: 0 })[k] += v; };
  let changed = 0;
  for (const t of targets) {
    const p = pById.get(t.pid); if (!p) continue;
    const y = String(p.start_date || "").slice(0, 4);
    let diff = false;
    for (const [kind, cat] of CATS) {
      const before = curBy.get(`${t.pid}|${cat}`) || 0;
      const after = Number(t[cat] || 0);
      if (kind === "income") { add(y, "beforeInc", before); add(y, "afterInc", after); }
      else { add(y, "beforeCost", before); add(y, "afterCost", after); }
      if (before !== after) diff = true;
    }
    if (diff) changed++;
  }

  console.log(`\n=== FAIR PNL align seed figures -> v8 — ${COMMIT ? "COMMIT" : "DRY-RUN (read-only)"} ===`);
  console.log(`company HOUZS (id ${companyId ?? "?"}) | target seeds: ${targets.length} | with figure changes: ${changed}`);
  console.log(`\n  year | income  before -> after            | cost    before -> after`);
  for (const y of Object.keys(yr).sort()) {
    const v = yr[y];
    console.log(`  ${y} | ${rm(v.beforeInc).padEnd(14)} -> ${rm(v.afterInc).padEnd(14)} | ${rm(v.beforeCost).padEnd(14)} -> ${rm(v.afterCost)}`);
  }

  if (!COMMIT) {
    console.log(`\nDRY-RUN OK — --commit will, per target project: DELETE its lines in [${CAT_NAMES.join(", ")}] then INSERT the v8 values (>0). Run the autocost pass afterward to refresh transport/commission.`);
    return;
  }

  let done = 0;
  for (const t of targets) {
    const p = pById.get(t.pid); if (!p) continue;
    const occurred = p.start_date;
    await sql`DELETE FROM project_finance_lines WHERE project_id = ${t.pid} AND category IN ${sql(CAT_NAMES)}`;
    for (const [kind, cat] of CATS) {
      const amt = Math.round(Number(t[cat] || 0));
      if (amt > 0)
        await sql`INSERT INTO project_finance_lines (project_id, kind, category, description, amount, occurred_at, company_id)
                  VALUES (${t.pid}, ${kind}, ${cat}, ${cat + " (FAIR PNL v8 align)"}, ${amt}, ${occurred}, ${companyId})`;
    }
    if (++done % 40 === 0) console.log(`  aligned ${done}/${targets.length}...`);
  }
  console.log(`\nCOMMIT DONE — aligned ${done} seed project(s) to v8. Next: run polish-all autocost to refresh transport/commission.`);
}
main().then(() => sql.end()).catch((e) => { console.error(e); process.exit(1); });
