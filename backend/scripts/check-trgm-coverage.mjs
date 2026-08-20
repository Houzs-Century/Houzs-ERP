// Report every column searched with `ILIKE '%term%'` through PostgREST that has
// no pg_trgm GIN index behind it.
//
// WHY THIS EXISTS AS A SCRIPT
//
// The gap it finds is invisible by construction. An unindexed contains-scan is
// a sequential scan on every keystroke, and at a few hundred rows that is a few
// milliseconds — so nothing looks wrong until the tables have grown, by which
// point the change that caused it is months old.
//
// It has happened twice. `0074_search_trgm_indexes.sql` shipped in the same PR
// as global search v1 and got it right. PR #1269 (2026-07-25) then added five
// document sources to the same route with fifteen ILIKE columns and no
// migration; the module LIST search boxes had accumulated their own unindexed
// columns over a longer period. Both were found by hand-diffing `.or(...ilike...)`
// against `gin_trgm_ops`, which is exactly the kind of mechanical comparison a
// person should never be the one to run.
//
// So: add a searched column, run this, and the missing index is named before it
// becomes a performance mystery.
//
// NOT A DEPLOY GATE, deliberately. It is a static approximation — it reads
// source text, not a query plan — and the sibling `audit:routes` gate jammed
// prod twice in one day. A false positive here must cost a conversation, never
// a deploy. That reasoning is still correct and is why this script appears in
// ci.yml and in NEITHER deploy workflow.
//
// TWO MODES, because until 2026-08-13 there was only one and it was a no-op.
//
//   node scripts/check-trgm-coverage.mjs            exit 0 always — the question
//   node scripts/check-trgm-coverage.mjs --check    exit 1 on a gap — the gate
//
// The original wrote "Exit code is 0 for every legitimate answer, including
// 'gaps found'", and both exit paths were `process.exit(0)`. Combined with
// being wired into zero workflows, that made it a check that could not fail and
// that nobody ran — while sitting in package.json under `audit:` beside five
// real gates, which is how it reads as coverage it never provided. A guard
// everyone trusts that does not work is worse than no guard.
//
// The escape hatch for a false positive already exists and predates this
// change: add the column to ACCEPTED below WITH a reason. That is a code review
// about one line, which is exactly the "conversation" the paragraph above asks
// for — and it happens on a PR, not on a deploy.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCM_DIR = join(ROOT, "src", "scm");
const MIG_DIR = join(ROOT, "src", "db", "migrations-pg");

/**
 * Columns that are searched but deliberately NOT indexed. Each needs a reason —
 * an entry without one is how a real gap gets silenced.
 */
const ACCEPTED = new Map([
  ["fabric_colours.colour_id", "lookup table, a few dozen rows: seq scan is the cheaper plan"],
  ["fabric_colours.label", "same lookup table"],
]);

/**
 * Views cannot carry an index. For a simple view the planner pushes the
 * predicate down to the base table, so the BASE column is what must be indexed.
 * Anything listed here is checked against its base relation instead.
 */
const VIEW_BASE = new Map([
  ["suppliers_with_derived_category", { table: "suppliers", columns: {} }],
  ["mfg_sales_orders_with_payment_totals", { table: "mfg_sales_orders", columns: {} }],
  ["v_inventory_product_totals", {
    table: "mfg_products",
    columns: { item_code: "code", product_name: "name" },
  }],
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

// --- what is indexed -------------------------------------------------------
const indexed = new Set();
for (const f of readdirSync(MIG_DIR)) {
  if (!f.endsWith(".sql")) continue;
  const sql = readFileSync(join(MIG_DIR, f), "utf8");
  for (const m of sql.matchAll(/ON\s+([a-z_.]+)\s+USING\s+gin\s*\(\s*([a-z_0-9]+)\s+gin_trgm_ops/gi)) {
    const rel = m[1].includes(".") ? m[1].split(".").pop() : m[1];
    indexed.add(`${rel}.${m[2]}`);
  }
}

// --- what is searched ------------------------------------------------------
const searched = new Map(); // "relation.column" -> Set<"file:line">
for (const file of walk(SCM_DIR)) {
  const src = readFileSync(file, "utf8");
  const short = file.slice(file.indexOf("src")).replace(/\\/g, "/");
  for (const fm of src.matchAll(/\.from\(\s*['"`]([a-zA-Z_0-9]+)['"`]\s*\)/g)) {
    const relation = fm[1];
    // Attribute ILIKE columns to THIS .from(), never the next one.
    const window = src.slice(fm.index, fm.index + 2000);
    const nextFrom = window.indexOf(".from(", 6);
    const scope = nextFrom > 0 ? window.slice(0, nextFrom) : window;
    for (const om of scope.matchAll(/([a-z_0-9]+)\.ilike\./g)) {
      const line = src.slice(0, fm.index).split("\n").length;
      const key = `${relation}.${om[1]}`;
      if (!searched.has(key)) searched.set(key, new Set());
      searched.get(key).add(`${short}:${line}`);
    }
  }
}

// --- compare ---------------------------------------------------------------
const missing = [];
let acceptedCount = 0;
for (const [key, where] of searched) {
  const [relation, column] = key.split(".");
  let checkKey = key;
  const view = VIEW_BASE.get(relation);
  if (view) checkKey = `${view.table}.${view.columns[column] ?? column}`;
  if (indexed.has(checkKey)) continue;
  if (ACCEPTED.has(key)) { acceptedCount++; continue; }
  missing.push({ key, checkKey, where: [...where] });
}

const total = searched.size;
console.log(`pg_trgm coverage for PostgREST ILIKE searches`);
console.log(`  searched columns : ${total}`);
console.log(`  indexed          : ${total - missing.length - acceptedCount}`);
console.log(`  accepted as-is   : ${acceptedCount}`);
console.log(`  MISSING an index : ${missing.length}`);

if (missing.length === 0) {
  console.log(`\nEvery searched column is backed by a trigram index.`);
  process.exit(0);
}

console.log(`\nEach line below is a sequential scan on every keystroke once the`);
console.log(`table grows. Add the index in the SAME PR as the searched column.\n`);
const byRelation = {};
for (const m of missing) {
  const rel = m.key.split(".")[0];
  (byRelation[rel] ??= []).push(m);
}
for (const [rel, cols] of Object.entries(byRelation).sort()) {
  console.log(`  ${rel}`);
  for (const { key, checkKey, where } of cols) {
    const col = key.split(".")[1];
    const via = checkKey !== key ? `  (index on ${checkKey})` : "";
    console.log(`      ${col.padEnd(22)}${via}`);
    console.log(`          ${where.slice(0, 3).join("  ")}`);
  }
}
console.log(`\nIf a column genuinely should not be indexed, add it to ACCEPTED in`);
console.log(`this script WITH a reason. An entry without one silences a real gap.`);

// `--check` is the gate form (ci.yml). Bare invocation stays exit-0 so running
// it by hand to ASK the question never looks like a broken script.
if (process.argv.includes("--check")) {
  console.error(`\n${missing.length} searched column(s) have no trigram index. Add the`);
  console.error(`migration in this PR, or add each column to ACCEPTED with a reason.`);
  process.exit(1);
}
process.exit(0);
