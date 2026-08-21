#!/usr/bin/env node
// ----------------------------------------------------------------------------
// check-project-cost-rates.mjs — is the Fair P&L rate card shared across
// companies today, and is anything actually mis-rated because of it?
//
// ── WHY ─────────────────────────────────────────────────────────────────────
// `public.project_cost_rates` (mig 063, and in 0000_baseline.sql before that)
// predates multi-company and has NO company_id. It is keyed by brand NAME:
//
//   routes/projects.ts   GET  /cost-rates          JOIN project_brands ON name
//   routes/projects.ts   PUT  /cost-rates/:brand   UPDATE ... WHERE brand = ?
//   services/projectCostRates.ts                   SELECT ... WHERE brand = ?
//   scm/routes/reports.ts  resolveFairRate         SELECT ... WHERE brand = ?
//
// `project_brands` DOES carry company_id (mig 0093), and brand names are known
// to collide across the two companies. A colliding name therefore resolves to
// ONE rate row for BOTH companies — transport %, merchandise % and COMMISSION %.
//
// This script MEASURES that before anything is changed. No customer-visible
// harm is assumed; the point is to find out whether any exists.
//
// ── WHAT IT ANSWERS ─────────────────────────────────────────────────────────
//   1. how many rows project_cost_rates holds, and which brand names
//   2. which of those names exist under MORE THAN ONE company in project_brands
//   3. whether live projects on more than one company resolve a colliding name,
//      and how much auto-derived money (project_finance_lines.auto_source)
//      currently hangs off each shared card
//   4. which rate rows have no brand row at all (orphans), and which brand rows
//      have no rate row (the engine silently skips those)
//
// ── EVIDENCE IS NOT A SETTING ───────────────────────────────────────────────
// A zero anywhere here is a FINDING and is reported as one. Nothing is written,
// nothing is created to make an answer look tidy.
//
// Read-only: SELECTs only, no DDL, no writes, no transaction. Exits 0 for every
// legitimate answer — the answer IS the output. Non-zero only when the database
// is unreachable or a shape this script depends on is missing.
// ----------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const url =
  process.env.DATABASE_URL ??
  (() => {
    try {
      return fs
        .readFileSync(path.join(backendRoot, ".dev.vars"), "utf8")
        .match(/DATABASE_URL="([^"]+)"/)?.[1];
    } catch {
      return undefined;
    }
  })();
if (!url) {
  console.error("DATABASE_URL not set (env var or backend/.dev.vars). Aborting.");
  process.exit(1);
}

const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const h = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 68 - t.length))}`);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  // ── 0. the shapes this script depends on ──────────────────────────────────
  const shape = await pg`
    SELECT c.relname AS tbl, a.attname AS col
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE n.nspname = 'public'
       AND c.relname IN ('project_cost_rates','project_brands','projects','companies','project_finance_lines')`;
  const has = (t, c) => shape.some((r) => r.tbl === t && r.col === c);
  const missing = [
    ["project_cost_rates", "brand"],
    ["project_brands", "company_id"],
    ["projects", "brand"],
    ["companies", "code"],
  ].filter(([t, c]) => !has(t, c));
  if (missing.length) {
    console.error(
      "SHAPE CHECK FAILED - the columns this measurement is about are not there:\n  " +
        missing.map((m) => m.join(".")).join("\n  ") +
        "\n  Refusing to report numbers computed over a different schema.",
    );
    process.exit(2);
  }
  const rateHasCompany = has("project_cost_rates", "company_id");
  console.log(`project_cost_rates.company_id present: ${rateHasCompany}`);

  // ── 1. the companies ──────────────────────────────────────────────────────
  h("companies");
  const companies = await pg`SELECT id, code, name FROM public.companies ORDER BY id`;
  for (const c of companies) console.log(`  ${String(c.id).padStart(3)}  ${(c.code ?? "").padEnd(10)} ${c.name ?? ""}`);
  if (!companies.length) notice("companies is EMPTY - that is a finding, not a setting.");

  // ── 2. the rate card ──────────────────────────────────────────────────────
  h("project_cost_rates");
  const rates = rateHasCompany
    ? await pg`SELECT id, company_id, brand, transport_pct, merchandise_pct, commission_normal_pct,
                      commission_boost_pct, boost_min_gp_pct, boost_min_sales, updated_at, updated_by
                 FROM public.project_cost_rates ORDER BY brand`
    : await pg`SELECT id, NULL::bigint AS company_id, brand, transport_pct, merchandise_pct, commission_normal_pct,
                      commission_boost_pct, boost_min_gp_pct, boost_min_sales, updated_at, updated_by
                 FROM public.project_cost_rates ORDER BY brand`;
  console.log(`  ${rates.length} row(s).`);
  console.log(
    "  " +
      ["id", "company", "brand", "trans%", "merch%", "comm%", "boost%", "minGP%", "minSales", "updated_at"]
        .map((s, i) => s.padEnd([5, 8, 22, 7, 7, 7, 7, 7, 12, 22][i]))
        .join(""),
  );
  for (const r of rates) {
    console.log(
      "  " +
        [
          String(r.id),
          r.company_id == null ? "-" : String(r.company_id),
          String(r.brand),
          String(r.transport_pct ?? ""),
          String(r.merchandise_pct ?? ""),
          String(r.commission_normal_pct ?? ""),
          String(r.commission_boost_pct ?? ""),
          String(r.boost_min_gp_pct ?? ""),
          String(r.boost_min_sales ?? ""),
          String(r.updated_at ?? ""),
        ]
          .map((s, i) => s.padEnd([5, 8, 22, 7, 7, 7, 7, 7, 12, 22][i]))
          .join(""),
    );
  }
  if (!rates.length) notice("project_cost_rates is EMPTY - reported as a finding; nothing was inserted.");

  // ── 3. brand rows per company ─────────────────────────────────────────────
  h("project_brands (name -> companies)");
  const brands = await pg`
    SELECT name, company_id, active, count(*) OVER (PARTITION BY lower(name)) AS name_uses
      FROM public.project_brands ORDER BY lower(name), company_id`;
  const byName = new Map();
  for (const b of brands) {
    const k = String(b.name).toLowerCase();
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(b);
  }
  const colliding = [...byName.entries()].filter(
    ([, rows]) => new Set(rows.map((r) => String(r.company_id))).size > 1,
  );
  console.log(`  ${brands.length} brand row(s), ${byName.size} distinct name(s).`);
  console.log(`  names held by MORE THAN ONE company: ${colliding.length}`);
  for (const [name, rows] of colliding) {
    console.log(
      `    ${name.padEnd(24)} ${rows
        .map((r) => `company ${r.company_id}${Number(r.active) === 1 ? "" : " (inactive)"}`)
        .join(", ")}`,
    );
  }

  // ── 4. do the collisions actually carry a rate card? ──────────────────────
  h("collision x rate card");
  const rateNames = new Set(rates.map((r) => String(r.brand).toLowerCase()));
  const collidingWithRate = colliding.filter(([n]) => rateNames.has(n));
  console.log(`  colliding names that HAVE a rate row: ${collidingWithRate.length}`);
  for (const [name, rows] of collidingWithRate) {
    console.log(`    ${name} -> one card shared by companies ${[...new Set(rows.map((r) => r.company_id))].join(", ")}`);
  }
  const orphanRates = rates.filter((r) => !byName.has(String(r.brand).toLowerCase()));
  console.log(`  rate rows whose brand has NO project_brands row at all: ${orphanRates.length}`);
  for (const r of orphanRates) console.log(`    ${r.brand}`);
  const brandsWithoutRate = [...byName.keys()].filter((n) => !rateNames.has(n));
  console.log(`  brand names with NO rate row (engine silently skips them): ${brandsWithoutRate.length}`);
  if (brandsWithoutRate.length) console.log(`    ${brandsWithoutRate.join(", ")}`);

  // ── 5. is anything actually mis-rated TODAY? ──────────────────────────────
  h("projects that resolve a rate card, by company");
  /* projects.brand is free text and joins the card by NAME, exactly as
     services/projectCostRates.ts does. Counting per (brand, company) shows
     whether a single card is being applied to two companies' project cohorts. */
  const cohorts = await pg`
    SELECT lower(btrim(p.brand)) AS brand,
           p.company_id,
           count(*) FILTER (WHERE p.archived_at IS NULL) AS live_projects,
           count(*) AS all_projects
      FROM public.projects p
     WHERE p.brand IS NOT NULL AND btrim(p.brand) <> ''
     GROUP BY 1, 2
     ORDER BY 1, 2`;
  const cohortByBrand = new Map();
  for (const r of cohorts) {
    if (!cohortByBrand.has(r.brand)) cohortByBrand.set(r.brand, []);
    cohortByBrand.get(r.brand).push(r);
  }
  const misRated = [];
  for (const [brand, rows] of cohortByBrand) {
    if (!rateNames.has(brand)) continue;
    const companiesWithLive = rows.filter((r) => Number(r.live_projects) > 0).map((r) => r.company_id);
    if (new Set(companiesWithLive.map(String)).size > 1) misRated.push({ brand, rows });
  }
  for (const [brand, rows] of cohortByBrand) {
    const card = rateNames.has(brand) ? "card" : "no card";
    console.log(
      `  ${brand.padEnd(24)} ${card.padEnd(8)} ` +
        rows.map((r) => `co ${r.company_id}: ${r.live_projects} live / ${r.all_projects} total`).join("   |   "),
    );
  }
  console.log("");
  if (misRated.length === 0) {
    notice(
      "MIS-RATED TODAY: none. No brand name with a rate card has LIVE projects on more " +
        "than one company, so no fair is currently being costed from the other company's card.",
    );
  } else {
    notice(`MIS-RATED TODAY: ${misRated.length} brand name(s) with a shared card and live projects on 2+ companies.`);
    for (const m of misRated) {
      console.log(`    ${m.brand}: ${m.rows.map((r) => `co ${r.company_id} = ${r.live_projects} live`).join(", ")}`);
    }
  }

  // ── 6. how much money already hangs off each card ─────────────────────────
  h("auto-derived money per (brand, company)");
  if (!has("project_finance_lines", "auto_source")) {
    console.log("  project_finance_lines.auto_source absent - skipped.");
  } else {
    const money = await pg`
      SELECT lower(btrim(p.brand)) AS brand,
             p.company_id,
             l.auto_source,
             count(*) AS lines,
             sum(l.amount) AS total_amount
        FROM public.project_finance_lines l
        JOIN public.projects p ON p.id = l.project_id
       WHERE l.auto_source IS NOT NULL
         AND l.archived_at IS NULL
       GROUP BY 1, 2, 3
       ORDER BY 1, 2, 3`;
    if (!money.length) {
      notice("ZERO auto-derived finance lines exist today - a finding, not something to seed.");
    }
    for (const m of money) {
      console.log(
        `  ${String(m.brand).padEnd(24)} co ${String(m.company_id).padEnd(4)} ` +
          `${String(m.auto_source).padEnd(18)} ${String(m.lines).padStart(5)} line(s)  ` +
          `amount ${m.total_amount}`,
      );
    }
  }

  // ── 7. who last touched each card ─────────────────────────────────────────
  h("last writer per card (which company's user edited it)");
  const writers = await pg`
    SELECT r.brand, r.updated_by, r.updated_at, u.email,
           (SELECT array_agg(DISTINCT uc.company_id ORDER BY uc.company_id)
              FROM public.user_companies uc WHERE uc.user_id = r.updated_by) AS writer_companies
      FROM public.project_cost_rates r
      LEFT JOIN public.users u ON u.id = r.updated_by
     ORDER BY r.brand`;
  for (const w of writers) {
    console.log(
      `  ${String(w.brand).padEnd(24)} updated_by=${String(w.updated_by ?? "-").padEnd(6)} ` +
        `companies=${w.writer_companies ? `{${w.writer_companies.join(",")}}` : "-"}  at=${w.updated_at ?? "-"}`,
    );
  }

  h("verdict");
  notice(
    `project_cost_rates: ${rates.length} row(s); ${colliding.length} brand name(s) held by 2+ companies; ` +
      `${collidingWithRate.length} of those have a rate card; mis-rated today: ${misRated.length}.`,
  );
} catch (e) {
  console.error(`check-project-cost-rates: DB error - ${e.message}`);
  process.exit(1);
} finally {
  await pg.end({ timeout: 5 });
}
