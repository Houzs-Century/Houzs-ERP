#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-branding-vocabulary.mjs — every stored branding value must be a brand
// the owner actually maintains.
//
// OWNER RULE (2026-08-18): the brand list is maintained in PMS — Project
// Maintenance -> BRANDS, which is `project_brands`, per company — and he asked
// for a check rather than a one-off repair: the branding stored across SCM must
// stay aligned with that list, "不是只修这一次".
//
// WHAT IT READS. Four tables carry a branding a human sees:
//   scm.mfg_products         the catalogue — the source everything else copies
//   scm.product_models       models, which mint SKUs via generate-skus
//   scm.mfg_sales_order_items  the line snapshot
//   scm.mfg_sales_orders     the SO header, which the list renders first
// Each non-blank value is looked up in ITS OWN company's active project_brands.
// Company scope matters here and is not decoration: "Bedframe" is 2990's brand
// and "BEDFRAME" is Houzs's, and a value valid under one company is a finding
// under the other.
//
// THREE VERDICTS, because "not equal" hides the interesting half:
//   OK          exact member of that company's list
//   CASE        matches only case-insensitively — the value and the dropdown
//               have drifted apart in spelling, which is what makes a rename in
//               PMS stop cascading
//   NOT-IN-LIST no member at all
//
// A VERDICT COMPUTED OVER NOTHING MUST NOT READ AS A PASS. This repo has been
// burned three times by checkers that matched nothing and reported clean
// (CLAUDE.md, "a checker that cannot match reports a clean run"). So this one
// REFUSES rather than passes when its own inputs are empty: no companies, a
// company with no active brands, or a table that returned no rows at all. Each
// refusal exits 2 and names what was missing.
//
// READ-ONLY. One SELECT per table, no DDL, no writes, no transaction.
//
// EXIT CODES. Default reports and exits 0 — a red job reads as "the check
// broke", and the answer is the output (CLAUDE.md, the read-only diagnostic
// rules). `--strict` exits 1 when any NOT-IN-LIST or CASE row is found, for a
// caller that wants a gate.
//
// WHAT THIS CANNOT DO, stated so nobody reads more into a green run than is
// there: branding drifts when DATA changes, and data changes without a pull
// request. So this cannot be a per-PR gate the way a typecheck is — it is an
// on-demand audit (Actions -> "Branding vocabulary check (read-only)"). The
// PR-time half of the same problem is a different check: that the display rule
// only emits values the vocabulary contains, which lives with the rule in
// backend/src/scm/shared/so-branding-label.ts.
// ---------------------------------------------------------------------------
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const STRICT = process.argv.includes("--strict");
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const warn = (m) => console.log(process.env.GITHUB_ACTIONS ? `::warning::${m}` : m);
const tidy = (v) => String(v ?? "").trim();

const TABLES = [
  { name: "scm.mfg_products", where: "" },
  { name: "scm.product_models", where: "" },
  { name: "scm.mfg_sales_order_items", where: " AND cancelled = false" },
  { name: "scm.mfg_sales_orders", where: "" },
];

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
try {
  const companies = await sql`SELECT id, code, name FROM companies ORDER BY id`;
  if (companies.length === 0) { console.error("REFUSING: no companies — the check would compare against nothing"); process.exit(2); }

  const vocab = new Map();
  for (const co of companies) {
    const rows = await sql`
      SELECT name FROM project_brands WHERE company_id = ${co.id} AND active = 1`;
    if (rows.length === 0) {
      console.error(`REFUSING: company ${co.code} has no active project_brands — every value would report as a finding, which is not a verdict`);
      process.exit(2);
    }
    vocab.set(Number(co.id), rows.map((r) => tidy(r.name)));
  }
  log(`companies: ${companies.map((c) => `${c.code}(${vocab.get(Number(c.id)).length} brands)`).join("  ")}`);

  let scanned = 0, findings = 0, caseOnly = 0;
  for (const t of TABLES) {
    const rows = await sql.unsafe(`
      SELECT company_id, TRIM(branding) AS value, count(*)::int AS rows
      FROM ${t.name}
      WHERE COALESCE(TRIM(branding), '') <> ''${t.where}
      GROUP BY 1, 2 ORDER BY 1, 3 DESC`);
    if (rows.length === 0) {
      console.error(`REFUSING: ${t.name} returned no branded rows at all — a table this check exists to scan cannot be empty; the query or the schema has moved`);
      process.exit(2);
    }
    const bad = [];
    for (const r of rows) {
      scanned += r.rows;
      const list = vocab.get(Number(r.company_id)) ?? [];
      if (list.includes(r.value)) continue;
      const ci = list.find((b) => b.toLowerCase() === r.value.toLowerCase());
      if (ci) { caseOnly += 1; bad.push(`   co=${r.company_id}  "${r.value}"  x${r.rows}   CASE — the list spells it "${ci}"`); }
      else { findings += 1; bad.push(`   co=${r.company_id}  "${r.value}"  x${r.rows}   NOT-IN-LIST`); }
    }
    log(`\n=== ${t.name} — ${rows.length} distinct value(s), ${bad.length} not clean`);
    for (const line of bad) warn(line);
  }

  log(`\nscanned ${scanned} branded rows across ${TABLES.length} tables: ${findings} NOT-IN-LIST, ${caseOnly} CASE-only`);
  if (findings + caseOnly === 0) log("every stored branding is a brand maintained in PMS");
  else log("fix by adding the brand in PMS (Project Maintenance -> BRANDS) or by aligning the stored value — backfill-2990-branding-to-sku.mjs copies the catalogue value onto lines, headers and models");
  if (STRICT && findings + caseOnly > 0) process.exitCode = 1;
} finally { await sql.end(); }
