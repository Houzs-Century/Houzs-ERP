// Read-only report: ACTIVE SKUs that have NO supplier binding, per company.
//
// WHY THIS EXISTS. The owner's decision (2026-09-16) is that the Product
// Maintenance cost price stops being hand-typed and instead AUTO-DERIVES from
// the supplier side: one supplier -> that price, several -> the most expensive.
// A SKU with no supplier binding therefore derives NOTHING — an empty price.
// The owner does not want that to be a silently blank field; he wants the gap
// surfaced so he can go add the missing supplier binding. This is that list.
//
// It is also the pre-flight for the risky production reprice (plan stage 3):
// run it first, fix the gaps, then reprice, so the flip cannot blank a price
// that was carrying a real value.
//
// A gap = an ACTIVE scm.mfg_products row whose (company_id, code) has no
// scm.supplier_material_bindings row with material_kind = 'mfg_product'. That
// is the exact predicate the derivation reads, so this list is what would
// derive empty.
//
// SELECT only. No DDL, no writes, no transaction. Reads COMPANY_ID (blank =
// both companies) and LIST_LIMIT (blank = 80 named per company) from the env,
// exactly as the shared runner passes them. Exits 0 for every real answer — a
// red job would read as "the check broke", and the point is that the ANSWER is
// the output. Only an unreachable database or a query error exits non-zero.
//
// Run it: Actions -> "Run a backend script on production (plan / apply)" ->
// script = report-product-binding-gaps.mjs, mode = plan,
// env = COMPANY_ID=1 (or blank for both), optional LIST_LIMIT=200.
import { readFileSync } from "node:fs";
import postgres from "postgres";

// Same resolution order as pg-migrate.mjs: env wins so CI needs no .dev.vars.
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

// `notice` surfaces the verdict on the workflow run's summary page, so the
// answer is readable without opening the log.
const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

const companyFilter = (() => {
  const raw = String(process.env.COMPANY_ID ?? "").trim();
  if (!raw) return null; // both companies
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`COMPANY_ID must be a positive integer or blank; got '${raw}'.`);
    process.exit(1);
  }
  return n;
})();

const listLimit = (() => {
  const raw = String(process.env.LIST_LIMIT ?? "").trim();
  if (!raw) return 80;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 80;
})();

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  // Which companies to report on: the ones that actually own active products.
  const companies = (
    await pg`
      SELECT DISTINCT company_id
      FROM scm.mfg_products
      WHERE status = 'ACTIVE'
        AND (${companyFilter}::int IS NULL OR company_id = ${companyFilter})
      ORDER BY company_id`
  ).map((r) => r.company_id);

  if (companies.length === 0) {
    notice(
      companyFilter == null
        ? "No ACTIVE products found in any company — nothing to report (is this the right database?)."
        : `No ACTIVE products for company ${companyFilter}.`,
    );
  }

  for (const co of companies) {
    // SELF-TEST: a company with active products but ZERO mfg_product bindings
    // would make every SKU look like a gap. That is far more likely a broken
    // read than a real state, so say so distinctly instead of reporting the
    // whole catalogue as gaps (repo rule: refuse to report from a dead match).
    const [{ binding_rows }] = await pg`
      SELECT count(*)::int AS binding_rows
      FROM scm.supplier_material_bindings
      WHERE material_kind = 'mfg_product' AND company_id = ${co}`;

    const [{ active_skus, without_binding, with_manual_price }] = await pg`
      WITH prod AS (
        SELECT code, base_price_sen
        FROM scm.mfg_products
        WHERE status = 'ACTIVE' AND company_id = ${co}
      ),
      b AS (
        SELECT DISTINCT item_code
        FROM scm.supplier_material_bindings
        WHERE material_kind = 'mfg_product' AND company_id = ${co}
      )
      SELECT count(*)::int AS active_skus,
             count(*) FILTER (WHERE b.item_code IS NULL)::int AS without_binding,
             count(*) FILTER (WHERE b.item_code IS NULL AND COALESCE(prod.base_price_sen, 0) > 0)::int AS with_manual_price
      FROM prod LEFT JOIN b ON b.item_code = prod.code`;

    notice("");
    notice(`===== Company ${co} =====`);
    if (binding_rows === 0) {
      notice(
        `SELF-TEST FAILED: company ${co} has ${active_skus} active SKUs but ZERO ` +
          `mfg_product supplier bindings. That is almost certainly a bad read, not ` +
          `a real state — NOT reporting all ${active_skus} as gaps. Investigate the ` +
          `supplier_material_bindings read before trusting any gap count.`,
      );
      continue;
    }
    notice(`active SKUs             : ${active_skus}`);
    notice(`with NO supplier binding: ${without_binding}  <-- these derive an EMPTY price`);
    notice(`  of which still carry a hand-typed cost today: ${with_manual_price}`);

    if (without_binding === 0) {
      notice("No binding gaps — every active SKU has at least one supplier binding.");
      continue;
    }

    const rows = await pg`
      SELECT prod.code, prod.name, prod.category, prod.base_price_sen
      FROM scm.mfg_products prod
      LEFT JOIN (
        SELECT DISTINCT item_code
        FROM scm.supplier_material_bindings
        WHERE material_kind = 'mfg_product' AND company_id = ${co}
      ) b ON b.item_code = prod.code
      WHERE prod.status = 'ACTIVE' AND prod.company_id = ${co} AND b.item_code IS NULL
      ORDER BY (COALESCE(prod.base_price_sen, 0) > 0) DESC, prod.category, prod.code
      LIMIT ${listLimit}`;

    notice(
      `Listing ${rows.length} of ${without_binding} (code | category | manual cost RM | name):`,
    );
    for (const r of rows) {
      const rm =
        r.base_price_sen == null ? "-" : (Number(r.base_price_sen) / 100).toFixed(2);
      notice(`  ${r.code} | ${r.category ?? "-"} | ${rm} | ${r.name ?? ""}`);
    }
    if (without_binding > rows.length) {
      notice(
        `  ... ${without_binding - rows.length} more not listed (raise LIST_LIMIT to see them).`,
      );
    }
  }
} finally {
  await pg.end({ timeout: 5 });
}
