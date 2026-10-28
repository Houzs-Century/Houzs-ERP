// Read-only reachability diagnostic for the supplier 404 class (owner ask
// 2026-07-24: "why does the supplier detail keep 404-ing, and how bad is the
// cross-company / orphan reference problem after the 2990 import?").
//
// WHY THIS EXISTS AS A SCRIPT (see CLAUDE.md "never ask the owner to run a
// query"). The answer lives only in production. GitHub Actions already holds
// secrets.DATABASE_URL for the deploy, so the check runs there and nobody needs
// the credential. Pair it with a manual workflow_dispatch, exactly like
// backend/scripts/check-soak-gate.mjs.
//
// WHAT IT ANSWERS
//   (1) suppliers grouped by company_id (incl NULL) — the population the
//       per-company detail/list scope (scopeToCompany → .eq('company_id',
//       active)) partitions. A supplier in company 2 is invisible + 404s while
//       company 1 is active.
//   (2) supplier_material_bindings whose supplier_id has NO supplier row in the
//       SAME company — split into CROSS-COMPANY (the supplier exists, but under
//       another company) vs DANGLING (no supplier row at all, i.e. an id-remap
//       import stray, see cleanup-2990-import-strays.mjs / BUG-HISTORY).
//   (3) the same orphan check for EVERY scm base table that stores a supplier_id
//       (purchase_orders / grns / purchase_invoices / purchase_returns /
//       payment_vouchers / purchase_consignment_* / dp_orders / ... and
//       products/mfg_products IF either carries a supplier_id column — the set
//       is DISCOVERED from information_schema so a new table is covered
//       automatically).
//   (4) the 20 most-referenced orphan supplier_ids, with the doc types pointing
//       at them — the ids a child-row link (e.g. GoodsReceivedDetail's
//       useSupplierDetail(grn.supplier_id)) would send /suppliers/:id and get a
//       404 for.
//
// STRICTLY READ-ONLY. Only SELECTs — no DDL, no writes, no transaction, no temp
// tables (the top-20 rollup is a CTE, and per-table orphan ids are accumulated
// in JS). Exits 0 for every legitimate answer — a red job would read as "the
// check broke", and the ANSWER is the output. Only an unreachable database or a
// query error exits non-zero. Dynamically-built SQL only ever interpolates table
// names taken from OUR information_schema catalog and re-validated against
// ^[a-z_][a-z0-9_]*$, so there is no user input in any statement.
import { readFileSync } from "node:fs";
import postgres from "postgres";

// Same resolution order as pg-migrate.mjs / check-soak-gate.mjs: env wins so CI
// needs no .dev.vars. Match only the field and print nothing of it (CLAUDE.md
// "never read a secret out").
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

// `notice` surfaces each line on the workflow run's summary page, so the answer
// is readable without opening the log.
const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

// Identifier guard for the discovered table names before they are interpolated
// into dynamic SQL. They come from information_schema (our own catalog), and
// this is the belt-and-braces check that keeps every built statement injection-
// free.
const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  // ── (1) suppliers by company_id (incl NULL) ──────────────────────────────
  const byCompany = await pg`
    SELECT company_id, count(*)::int AS n
    FROM scm.suppliers
    GROUP BY company_id
    ORDER BY company_id NULLS FIRST`;
  notice("── (1) suppliers by company_id ──");
  if (byCompany.length === 0) {
    notice("scm.suppliers is EMPTY.");
  } else {
    for (const r of byCompany) {
      notice(`company_id=${r.company_id ?? "NULL"} : ${r.n} suppliers`);
    }
    const nulls = byCompany.find((r) => r.company_id == null);
    if (nulls) {
      notice(
        `WARNING: ${nulls.n} supplier(s) have NULL company_id — invisible to ` +
          "BOTH the list and the detail (scopeToCompany adds company_id = active), " +
          "yet still linkable from any child row that stored their supplier_id.",
      );
    }
  }

  // ── (2) supplier_material_bindings orphans (headline) ────────────────────
  const [smb] = await pg`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE same.id IS NULL)::int                         AS orphan,
      count(*) FILTER (WHERE same.id IS NULL AND any_co.id IS NOT NULL)::int AS cross_company,
      count(*) FILTER (WHERE same.id IS NULL AND any_co.id IS NULL)::int     AS dangling
    FROM scm.supplier_material_bindings b
    LEFT JOIN scm.suppliers same
           ON same.id = b.supplier_id AND same.company_id = b.company_id
    LEFT JOIN scm.suppliers any_co
           ON any_co.id = b.supplier_id`;
  notice("── (2) supplier_material_bindings.supplier_id → same-company supplier ──");
  notice(
    `${smb.total} bindings; ${smb.orphan} orphan ` +
      `(${smb.cross_company} cross-company, ${smb.dangling} dangling / no supplier row).`,
  );

  // ── discover every scm BASE TABLE with BOTH supplier_id AND company_id ────
  const discovered = await pg`
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema
     AND t.table_name  = c.table_name
     AND t.table_type  = 'BASE TABLE'
    WHERE c.table_schema = 'scm'
      AND c.column_name  = 'supplier_id'
      AND EXISTS (
        SELECT 1 FROM information_schema.columns cc
        WHERE cc.table_schema = 'scm'
          AND cc.table_name   = c.table_name
          AND cc.column_name  = 'company_id')
    ORDER BY c.table_name`;
  const tables = discovered
    .map((r) => r.table_name)
    .filter((t) => SAFE_IDENT.test(t));

  // ── (3) per-table orphan check across all discovered tables ──────────────
  notice("── (3) per-table supplier_id → same-company supplier ──");
  if (tables.length === 0) {
    notice("No scm base table carries both supplier_id and company_id.");
  } else {
    const perTable = tables
      .map(
        (t) => `
        SELECT '${t}' AS tbl,
          count(*) FILTER (WHERE b.supplier_id IS NOT NULL)::int AS with_supplier,
          count(*) FILTER (WHERE b.supplier_id IS NOT NULL AND same.id IS NULL)::int AS orphan,
          count(*) FILTER (WHERE b.supplier_id IS NOT NULL AND same.id IS NULL AND any_co.id IS NOT NULL)::int AS cross_company,
          count(*) FILTER (WHERE b.supplier_id IS NOT NULL AND same.id IS NULL AND any_co.id IS NULL)::int AS dangling
        FROM scm.${t} b
        LEFT JOIN scm.suppliers same
               ON same.id = b.supplier_id AND same.company_id = b.company_id
        LEFT JOIN scm.suppliers any_co
               ON any_co.id = b.supplier_id`,
      )
      .join("\nUNION ALL\n");
    const rows = await pg.unsafe(
      `${perTable}\nORDER BY orphan DESC, tbl`,
    );
    for (const r of rows) {
      const flag = r.orphan > 0 ? "  <-- ORPHANS" : "";
      notice(
        `${r.tbl}: ${r.with_supplier} with supplier_id, ${r.orphan} orphan ` +
          `(${r.cross_company} cross-company, ${r.dangling} dangling)${flag}`,
      );
    }

    // ── (4) top 20 orphan supplier_ids + the doc types pointing at them ────
    const unionRefs = tables
      .map(
        (t) => `
        SELECT b.supplier_id, '${t}' AS doc_type
        FROM scm.${t} b
        WHERE b.supplier_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM scm.suppliers s
            WHERE s.id = b.supplier_id AND s.company_id = b.company_id)`,
      )
      .join("\nUNION ALL\n");
    const top = await pg.unsafe(`
      WITH orphan_refs AS (
        ${unionRefs}
      )
      SELECT r.supplier_id,
             count(*)::int AS ref_count,
             string_agg(DISTINCT r.doc_type, ', ' ORDER BY r.doc_type) AS doc_types,
             (SELECT s2.company_id FROM scm.suppliers s2 WHERE s2.id = r.supplier_id) AS supplier_exists_in_company
      FROM orphan_refs r
      GROUP BY r.supplier_id
      ORDER BY ref_count DESC, r.supplier_id
      LIMIT 20`);
    notice("── (4) top 20 most-referenced orphan supplier_ids ──");
    if (top.length === 0) {
      notice("No orphan supplier references — every stored supplier_id resolves within its own company.");
    } else {
      for (const r of top) {
        const where =
          r.supplier_exists_in_company == null
            ? "no supplier row anywhere (dangling)"
            : `supplier lives in company_id=${r.supplier_exists_in_company} (cross-company)`;
        notice(
          `${r.supplier_id} — ${r.ref_count} refs [${r.doc_types}]; ${where}`,
        );
      }
    }
  }

  notice("DONE — read-only, no rows changed.");
} finally {
  await pg.end({ timeout: 5 });
}
