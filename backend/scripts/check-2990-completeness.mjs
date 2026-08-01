// Read-only completeness check for the 2990 (company_2) side of the DB, ahead
// of the final cutover to Houzs.
//
// WHY THIS EXISTS
//
// The 2990 source system is being retired. The audit (2026-07-22) traced a
// list of tables the sofa/fabric/pricing paths read from, and the static
// analysis flagged some as "probably empty on company_2". The owner asked the
// right question: BEFORE building a backfill, verify with a live count — a
// table that was empty on the old backend and worked fine there is not an
// urgent problem here either.
//
// The answer lives only in production's Postgres, so per the "never ask the
// owner to run a query" rule, this is a script + workflow_dispatch. Read-only:
// one SELECT per row, no writes, no DDL, no transaction. Exits 0 in every
// legitimate case — the answer is the output, not the exit code.
//
// One report on the run's annotations shows the entire completeness picture
// side by side, HOUZS vs 2990, so the owner reads it once and picks what to
// backfill.
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}

const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

// Optional 2990 SOURCE probe. When SOURCE_SUPABASE_URL + SOURCE_SERVICE_ROLE_KEY
// are set (same env vars the importer uses), we also count the same tables on
// the 2990 upstream Supabase and print a THIRD column: "2990 SOURCE" alongside
// "HOUZS" and "2990 (in Houzs DB)". The diff is the gap — exactly what didn't
// get imported.
const SOURCE_URL = process.env.SOURCE_SUPABASE_URL;
const SOURCE_KEY = process.env.SOURCE_SERVICE_ROLE_KEY;
const src = SOURCE_URL && SOURCE_KEY
  ? createClient(SOURCE_URL, SOURCE_KEY, { auth: { persistSession: false } })
  : null;

// count(*) on the source. Uses Supabase's `head + count exact` trick so we
// don't pay for the payload. Returns null if the table is missing / unreadable
// on the source, so a missing 2990-side table renders "(src missing)" rather
// than crashing the whole sweep.
async function srcCount(table) {
  if (!src) return undefined; // "not probed" sentinel — distinct from null
  try {
    const { count, error } = await src
      .schema("public")
      .from(table)
      .select("*", { count: "exact", head: true });
    if (error) return null;
    return count ?? 0;
  } catch {
    return null;
  }
}

// Absent-table safe: to_regclass returns null when the table isn't there, so
// the count query short-circuits to null and we render "(missing)" rather
// than crashing the whole check.
async function countByCompany(tableFqn) {
  const present = await pg`SELECT to_regclass(${tableFqn})::text AS t`;
  if (!present[0].t) return null;
  const rows = await pg.unsafe(
    `SELECT company_id, count(*)::int AS n FROM ${tableFqn} GROUP BY company_id ORDER BY company_id`,
  );
  return rows;
}

async function countGlobal(tableFqn) {
  const present = await pg`SELECT to_regclass(${tableFqn})::text AS t`;
  if (!present[0].t) return null;
  const rows = await pg.unsafe(`SELECT count(*)::int AS n FROM ${tableFqn}`);
  return rows[0].n;
}

function fmt(rows, houzsId, id2990, srcN) {
  const base = rows === null
    ? "(table missing)"
    : (() => {
        const byCo = Object.fromEntries(rows.map((r) => [String(r.company_id), r.n]));
        const houzs = byCo[String(houzsId)] ?? 0;
        const two = byCo[String(id2990)] ?? 0;
        const other = rows
          .filter((r) => r.company_id !== houzsId && r.company_id !== id2990)
          .reduce((a, r) => a + r.n, 0);
        return `HOUZS=${houzs}  2990=${two}` + (other > 0 ? `  other=${other}` : "");
      })();
  // srcN: undefined = not probed, null = probe failed / missing, number = count
  if (srcN === undefined) return base;
  if (srcN === null) return `${base}  |  2990 SOURCE=(missing)`;
  const twoIn = rows === null ? 0
    : (Object.fromEntries(rows.map((r) => [String(r.company_id), r.n]))[String(id2990)] ?? 0);
  const diff = srcN - twoIn;
  const flag = diff > 0 ? `  ← ${diff} MISSING` : diff < 0 ? `  (+${-diff} extra in Houzs?)` : "";
  return `${base}  |  2990 SOURCE=${srcN}${flag}`;
}


try {
  const cos = await pg`SELECT id, code FROM companies WHERE code IN ('HOUZS','2990')`;
  const HOUZS = cos.find((r) => r.code === "HOUZS")?.id;
  const CO2990 = cos.find((r) => r.code === "2990")?.id;
  if (!HOUZS || !CO2990) {
    notice(`FATAL — HOUZS / 2990 companies missing: ${JSON.stringify(cos)}`);
    process.exit(0);
  }
  notice(`companies: HOUZS=${HOUZS}  2990=${CO2990}`);
  notice("");

  // ── § Sofa configurator / fabric backbone ─────────────────────────────
  notice("=== Sofa + fabric masters (per company) ===");
  if (src) notice("  (2990 SOURCE column shows count on the upstream Supabase — diff = missing on Houzs 2990)");
  notice(`  scm.fabric_library         : ${fmt(await countByCompany("scm.fabric_library"), HOUZS, CO2990, await srcCount("fabric_library"))}`);
  notice(`  scm.fabric_colours         : ${fmt(await countByCompany("scm.fabric_colours"), HOUZS, CO2990, await srcCount("fabric_colours"))}`);
  notice(`  scm.fabric_trackings       : ${fmt(await countByCompany("scm.fabric_trackings"), HOUZS, CO2990, await srcCount("fabric_trackings"))}`);
  notice(`  scm.fabric_tier_addon_config: ${fmt(await countByCompany("scm.fabric_tier_addon_config"), HOUZS, CO2990, await srcCount("fabric_tier_addon_config"))}`);
  notice(`  scm.sofa_combo_pricing     : ${fmt(await countByCompany("scm.sofa_combo_pricing"), HOUZS, CO2990, await srcCount("sofa_combo_pricing"))}`);
  notice(`  scm.bundle_library         : ${fmt(await countByCompany("scm.bundle_library"), HOUZS, CO2990, await srcCount("bundle_library"))}`);
  notice(`  scm.compartment_library    : ${fmt(await countByCompany("scm.compartment_library"), HOUZS, CO2990, await srcCount("compartment_library"))}`);
  notice(`  scm.size_library           : ${fmt(await countByCompany("scm.size_library"), HOUZS, CO2990, await srcCount("size_library"))}`);
  notice(`  scm.addons                 : ${fmt(await countByCompany("scm.addons"), HOUZS, CO2990, await srcCount("addons"))}`);
  notice(`  scm.accounts               : ${fmt(await countByCompany("scm.accounts"), HOUZS, CO2990, await srcCount("accounts"))}`);
  notice("");

  // ── § Product catalogue by category ────────────────────────────────────
  notice("=== mfg_products by category (per company) ===");
  // category is the enum mfg_product_category: cast ::text BEFORE the string
  // default, or Postgres coerces '(null)' INTO the enum and the whole section
  // dies with 22P02 at plan time — even when no row is NULL (BUG-HISTORY
  // 2026-07-30, "enum columns treated as text"; same rule as check-po-grouping).
  const prodByCat = await pg`
    SELECT company_id, COALESCE(category::text, '(null)') AS category, count(*)::int AS n
      FROM scm.mfg_products
     WHERE company_id IN (${HOUZS}, ${CO2990})
     GROUP BY company_id, category
     ORDER BY company_id, category`;
  const catRows = new Map();
  for (const r of prodByCat) {
    const list = catRows.get(r.category) ?? { HOUZS: 0, "2990": 0 };
    if (r.company_id === HOUZS) list.HOUZS = r.n;
    else if (r.company_id === CO2990) list["2990"] = r.n;
    catRows.set(r.category, list);
  }
  for (const [cat, counts] of catRows) {
    notice(`  ${cat.padEnd(15)}  HOUZS=${counts.HOUZS}  2990=${counts["2990"]}`);
  }
  notice("");

  // HEADREST SKUs — POS 400s on checkout with a HEADREST cell that has no SKU.
  notice("=== HEADREST SKU coverage ===");
  const hr = await pg`
    SELECT company_id, count(*)::int AS n
      FROM scm.mfg_products
     WHERE company_id IN (${HOUZS}, ${CO2990})
       AND code ILIKE '%HEADREST%'
     GROUP BY company_id
     ORDER BY company_id`;
  notice(`  code ILIKE '%HEADREST%'    : ${fmt(hr, HOUZS, CO2990)}`);
  notice("");

  // ── § Branding NULL coverage ───────────────────────────────────────────
  notice("=== Branding NULL rows (rows where UI shows blank in PDF/print) ===");
  const soNull = await pg`
    SELECT company_id,
           count(*) FILTER (WHERE branding IS NULL OR branding = '')::int AS null_n,
           count(*)::int AS total_n
      FROM scm.mfg_sales_orders
     WHERE company_id IN (${HOUZS}, ${CO2990})
     GROUP BY company_id
     ORDER BY company_id`;
  for (const r of soNull) {
    const co = r.company_id === HOUZS ? "HOUZS" : r.company_id === CO2990 ? "2990" : `co${r.company_id}`;
    notice(`  mfg_sales_orders            [${co}]: ${r.null_n}/${r.total_n} NULL/blank branding`);
  }
  const itemNull = await pg`
    SELECT o.company_id, COALESCE(i.item_group, '(null)') AS item_group,
           count(*) FILTER (WHERE i.branding IS NULL OR i.branding = '')::int AS null_n,
           count(*)::int AS total_n
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders o ON o.doc_no = i.doc_no
     WHERE o.company_id IN (${HOUZS}, ${CO2990})
     GROUP BY o.company_id, i.item_group
     ORDER BY o.company_id, i.item_group`;
  for (const r of itemNull) {
    const co = r.company_id === HOUZS ? "HOUZS" : r.company_id === CO2990 ? "2990" : `co${r.company_id}`;
    notice(`  mfg_sales_order_items       [${co}][${r.item_group}]: ${r.null_n}/${r.total_n} NULL/blank branding`);
  }
  notice("");

  // ── § GL accounts (mid-P1) ─────────────────────────────────────────────
  notice("=== GL accounts (scm.accounts) ===");
  notice(`  scm.accounts               : ${fmt(await countByCompany("scm.accounts"), HOUZS, CO2990)}`);
  notice("");

  // ── § Supplier price coverage (mid-P1 spot-check) ─────────────────────
  notice("=== Supplier price coverage (mfg_products.base_price_sen NULL by category) ===");
  // Same enum-cast rule as the catalogue section above.
  const priceNull = await pg`
    SELECT company_id, COALESCE(category::text, '(null)') AS category,
           count(*) FILTER (WHERE base_price_sen IS NULL)::int AS null_n,
           count(*)::int AS total_n
      FROM scm.mfg_products
     WHERE company_id IN (${HOUZS}, ${CO2990})
     GROUP BY company_id, category
     ORDER BY company_id, category`;
  for (const r of priceNull) {
    const co = r.company_id === HOUZS ? "HOUZS" : r.company_id === CO2990 ? "2990" : `co${r.company_id}`;
    notice(`  ${r.category.padEnd(15)}  [${co}]: ${r.null_n}/${r.total_n} NULL base_price_sen`);
  }
  notice("");

  // ── § Doc-flow linkage (owner concern: outstanding overstates if SOs / POs
  //   were imported without their downstream conversion links) ─────────────
  notice("=== Doc-flow linkage integrity (per company) ===");
  const soDoLink = await pg`
    SELECT o.company_id,
           count(*)::int                                                                  AS so_total,
           count(*) FILTER (WHERE NOT EXISTS (
             SELECT 1 FROM scm.mfg_delivery_orders d WHERE d.so_doc_no = o.doc_no
           ))::int                                                                        AS so_no_do,
           count(*) FILTER (WHERE NOT EXISTS (
             SELECT 1 FROM scm.mfg_sales_invoices s WHERE s.so_doc_no = o.doc_no
           ))::int                                                                        AS so_no_si
      FROM scm.mfg_sales_orders o
     WHERE o.company_id IN (${HOUZS}, ${CO2990})
     GROUP BY o.company_id
     ORDER BY o.company_id`;
  for (const r of soDoLink) {
    const co = r.company_id === HOUZS ? "HOUZS" : r.company_id === CO2990 ? "2990" : `co${r.company_id}`;
    notice(`  SO->DO/SI [${co}]        : total=${r.so_total}  no_DO=${r.so_no_do}  no_SI=${r.so_no_si}  (open outstanding if no_DO high)`);
  }
  // Orphan DOs (imported without a matching SO on this company)
  const doOrphan = await pg`
    SELECT d.company_id, count(*)::int AS n
      FROM scm.mfg_delivery_orders d
     WHERE d.company_id IN (${HOUZS}, ${CO2990})
       AND d.so_doc_no IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM scm.mfg_sales_orders o
          WHERE o.doc_no = d.so_doc_no AND o.company_id = d.company_id
       )
     GROUP BY d.company_id
     ORDER BY d.company_id`;
  for (const r of doOrphan) {
    const co = r.company_id === HOUZS ? "HOUZS" : r.company_id === CO2990 ? "2990" : `co${r.company_id}`;
    notice(`  Orphan DOs [${co}]       : ${r.n} DOs pointing at a doc_no that doesn't exist in this company's SOs`);
  }
  // PO outstanding — remaining_qty > 0 rows per company
  const poOut = await pg`
    SELECT company_id,
           count(*)::int                                                                  AS po_total,
           count(*) FILTER (WHERE remaining_qty IS NOT NULL AND remaining_qty > 0)::int  AS po_open,
           COALESCE(SUM(remaining_qty) FILTER (WHERE remaining_qty > 0), 0)::int         AS open_qty_sum
      FROM public.purchase_orders
     WHERE company_id IN (${HOUZS}, ${CO2990})
     GROUP BY company_id
     ORDER BY company_id`;
  for (const r of poOut) {
    const co = r.company_id === HOUZS ? "HOUZS" : r.company_id === CO2990 ? "2990" : `co${r.company_id}`;
    notice(`  PO outstanding [${co}]   : total=${r.po_total}  open=${r.po_open}  qty_sum=${r.open_qty_sum}`);
  }
  notice("");

  // ── § my_localities size (sanity) ─────────────────────────────────────
  notice("=== my_localities (canonical MY postcode dataset) ===");
  const ml = await countGlobal("scm.my_localities");
  notice(`  scm.my_localities (global) : ${ml ?? "(missing)"} rows`);
  notice("");

  notice("=== END ===");
  notice("Interpret: an empty 2990 count where HOUZS has real rows is worth a look. " +
         "An 'other=N' count means unexpected company_id values are present — investigate.");
} catch (e) {
  console.error("CHECK_FAIL:", e.message);
  await pg.end({ timeout: 5 });
  process.exit(1);
} finally {
  await pg.end({ timeout: 5 });
}
