#!/usr/bin/env node
// Read-only sweep of the REMAINING backfillable data gaps (ledger-perfection
// W6, owner ask 2026-08-01: "看一下还有什么数据可以去补的" — what else can be
// filled). Seven sections, each ending in a JUDGEMENT the owner can act on:
//
//   fillable-provable    the correct value already exists somewhere in the
//                        database and the section prints the exact evidence a
//                        gated backfill would copy
//   fillable-needs-owner a value is missing and only a human knows it (a
//                        delivery promise, a warehouse choice, a category)
//   leave-alone          not a defect (read-time resolution covers it, or the
//                        emptiness is the honest state)
//
// STRICTLY READ-ONLY. SELECT only — no DDL, no writes, no transaction, no
// marker rows. Identifiers are discovered from information_schema and
// re-validated against ^[a-z_][a-z0-9_]*$ (the check-inventory-integrity.mjs
// shape). Exit 0 for every legitimate answer; non-zero only when the DB is
// unreachable. The schema dump (2990s-full-schema.sql) is stale, so every
// section degrades to an explicit SKIP when a column is absent — never a crash.
//
// This script REPORTS; it repairs nothing. Each finding names the gated tool
// (existing or to-be-built) that would write it.
import { readFileSync } from "node:fs";
import postgres from "postgres";

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

const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const SAFE = /^[a-z_][a-z0-9_]*$/;
const ident = (s) => {
  if (!SAFE.test(s)) throw new Error(`unsafe identifier: ${s}`);
  return s;
};
const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });
const SAMPLE = 30;
const pad = (s, n) => String(s).padEnd(n);
const short = (s, n) => {
  const v = s == null ? "-" : String(s);
  return v.length > n ? v.slice(0, n - 1) + "…" : v;
};
const hdr = (t) => { notice(""); notice(`================ ${t} ================`); };
const sectionFailed = (label, e) => notice(`  !! SECTION FAILED — "${label}": ${e?.message ?? e}`);

async function schemaOf(table) {
  ident(table);
  const r = await pg`
    SELECT table_schema FROM information_schema.tables
     WHERE table_name = ${table} AND table_schema IN ('scm','public')
       AND table_type = 'BASE TABLE'
     ORDER BY CASE table_schema WHEN 'scm' THEN 0 ELSE 1 END`;
  return r[0]?.table_schema ?? null;
}
async function colsOf(schema, table) {
  const r = await pg`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = ${schema} AND table_name = ${table}`;
  return new Set(r.map((x) => x.column_name));
}
const q = (sch, tbl) => `"${ident(sch)}"."${ident(tbl)}"`;

async function main() {
  notice("=== BACKFILLABLE-GAP SWEEP — READ-ONLY (no rows changed; each section ends in a judgement) ===");

  const S = {};
  const C = {};
  for (const t of [
    "mfg_sales_orders", "mfg_sales_order_items", "delivery_orders", "delivery_order_items",
    "warehouses", "state_warehouse_mappings", "mfg_products", "grns", "grn_items",
    "purchase_invoices", "purchase_invoice_items", "purchase_orders", "purchase_order_items",
    "sales_invoices", "sales_invoice_items", "inventory_lots",
    "journal_entries", "warehouse_rack_items", "warehouse_rack_movements",
    "mfg_so_audit_log", "mfg_so_price_overrides", "mfg_so_status_changes",
    "pending_slip_uploads", "so_revisions", "delivery_returns", "purchase_returns",
  ]) {
    S[t] = await schemaOf(t);
    C[t] = S[t] ? await colsOf(S[t], t) : new Set();
  }
  const has = (t, ...cols) => S[t] && cols.every((c) => C[t].has(c));
  const T = (t) => q(S[t], t);

  // ==========================================================================
  // 1. NULL-warehouse SO lines (the audited "7 sofa lines" class)
  // ==========================================================================
  try {
    hdr("1. SO lines with NULL warehouse — does the header still resolve one?");
    notice("  Read-time resolution (so-warehouse.ts resolveLineWarehouseId): line warehouse_id ->");
    notice("  header sales_location matching a warehouse code/name -> customer_state via");
    notice("  state_warehouse_mappings. A line all three miss can NEVER see stock (MRP 'NOWH').");
    if (!has("mfg_sales_order_items", "warehouse_id", "doc_no")
      || !has("mfg_sales_orders", "doc_no", "status", "sales_location", "customer_state")
      || !has("warehouses", "code", "name")) {
      notice("  SKIPPED — columns absent.");
    } else {
      const stateJoin = has("state_warehouse_mappings", "state", "warehouse_id")
        ? `EXISTS (SELECT 1 FROM ${T("state_warehouse_mappings")} sw
                    WHERE UPPER(TRIM(sw.state)) = UPPER(TRIM(COALESCE(so.customer_state, ''))))`
        : "FALSE";
      const rows = await pg.unsafe(`
        SELECT so.doc_no, so.company_id, so.status::text AS status,
               i.item_code, COALESCE(i.item_group,'') AS item_group,
               so.sales_location, so.customer_state,
               EXISTS (SELECT 1 FROM ${T("warehouses")} w
                        WHERE UPPER(TRIM(w.code)) = UPPER(TRIM(COALESCE(so.sales_location,'')))
                           OR UPPER(TRIM(w.name)) = UPPER(TRIM(COALESCE(so.sales_location,'')))) AS loc_resolves,
               ${stateJoin} AS state_resolves
          FROM ${T("mfg_sales_order_items")} i
          JOIN ${T("mfg_sales_orders")} so ON so.doc_no = i.doc_no
         WHERE i.warehouse_id IS NULL
           AND ${C.mfg_sales_order_items.has("cancelled") ? "COALESCE(i.cancelled, FALSE) = FALSE" : "TRUE"}
           AND UPPER(so.status::text) NOT IN ('CANCELLED','CLOSED')
         ORDER BY so.doc_no, i.item_code`);
      const sofa = rows.filter((r) => r.item_group === "SOFA");
      const unresolved = rows.filter((r) => !r.loc_resolves && !r.state_resolves);
      notice(`  NULL-warehouse lines on live SOs : ${rows.length} (of which SOFA: ${sofa.length})`);
      notice(`  ... whose header ALSO resolves NOTHING (no sales_location match, no state mapping): ${unresolved.length}`);
      for (const r of rows.slice(0, SAMPLE)) {
        notice(`    ${pad(r.doc_no, 20)} co=${r.company_id} ${pad(r.status, 14)} ${pad(short(r.item_code, 20), 20)} ${pad(r.item_group, 9)} loc="${r.sales_location ?? ""}"(${r.loc_resolves ? "resolves" : "no"}) state="${r.customer_state ?? ""}"(${r.state_resolves ? "maps" : "no"})`);
      }
      if (rows.length > SAMPLE) notice(`    ... and ${rows.length - SAMPLE} more.`);
      notice("  (state matching here is exact-trimmed; the app also canonicalises aliases, so a 'no' on state");
      notice("   may still resolve in the app — treat 'resolves NOTHING' rows as the hard core.)");
      notice(`  JUDGEMENT: header-resolvable lines = leave-alone (read paths already resolve them; stamping the`);
      notice(`  resolved id onto the line would be fillable-provable polish). Resolves-nothing lines = `);
      notice(`  fillable-needs-owner: only a human can pick the warehouse; until then MRP shows them as NOWH.`);
    }
  } catch (e) { sectionFailed("1. NULL-warehouse lines", e); }

  // ==========================================================================
  // 2. DO headers missing so_doc_no
  // ==========================================================================
  try {
    hdr("2. delivery_orders.so_doc_no NULL — provable from the lines' own so_item_id?");
    if (!has("delivery_orders", "so_doc_no", "do_number") || !has("delivery_order_items", "so_item_id")) {
      notice("  SKIPPED — columns absent.");
    } else {
      const rows = await pg.unsafe(`
        SELECT d.do_number, d.company_id, d.status::text AS status,
               count(DISTINCT si.doc_no) AS distinct_sos,
               MIN(si.doc_no) AS the_so,
               count(di.id) AS lines,
               count(di.so_item_id) AS linked_lines
          FROM ${T("delivery_orders")} d
          LEFT JOIN ${T("delivery_order_items")} di ON di.delivery_order_id = d.id
          LEFT JOIN ${T("mfg_sales_order_items")} si ON si.id = di.so_item_id
         WHERE d.so_doc_no IS NULL AND UPPER(d.status::text) <> 'CANCELLED'
         GROUP BY d.do_number, d.company_id, d.status
         ORDER BY d.do_number`);
      const provable = rows.filter((r) => Number(r.distinct_sos) === 1);
      const multi = rows.filter((r) => Number(r.distinct_sos) > 1);
      const unlinked = rows.filter((r) => Number(r.distinct_sos) === 0);
      notice(`  non-cancelled DOs with NULL so_doc_no : ${rows.length}`);
      notice(`    lines resolve EXACTLY ONE SO (fillable-provable)   : ${provable.length}`);
      notice(`    lines span >1 SO (consolidated; ref carries the set): ${multi.length}`);
      notice(`    no line carries so_item_id (nothing to prove)      : ${unlinked.length}`);
      for (const r of provable.slice(0, SAMPLE)) notice(`    PROVABLE ${pad(r.do_number, 20)} co=${r.company_id} ${pad(r.status, 12)} -> so_doc_no = ${r.the_so}  (${r.linked_lines}/${r.lines} lines linked)`);
      for (const r of multi.slice(0, 10)) notice(`    MULTI-SO ${pad(r.do_number, 20)} co=${r.company_id} spans ${r.distinct_sos} SOs — leave-alone (convert path records the set in ref)`);
      for (const r of unlinked.slice(0, 10)) notice(`    UNLINKED ${pad(r.do_number, 20)} co=${r.company_id} ${r.lines} line(s), none linked — fillable-needs-owner`);
      notice("  JUDGEMENT: the PROVABLE rows can be backfilled by a gated UPDATE copying the single distinct");
      notice("  mfg_sales_order_items.doc_no (the same value the detail page already derives at read time, ");
      notice("  delivery-orders-mfg.ts:2929; FK-safe by construction).");
    }
  } catch (e) { sectionFailed("2. so_doc_no", e); }

  // ==========================================================================
  // 3. Missing delivery dates that hide demand from the MRP page
  // ==========================================================================
  try {
    hdr("3. Delivery dates — lines the MRP page drops as UNDATED");
    if (!has("mfg_sales_order_items", "line_delivery_date") || !has("mfg_sales_orders", "customer_delivery_date")) {
      notice("  SKIPPED — date columns absent.");
    } else {
      const soRows = await pg.unsafe(`
        SELECT so.doc_no, so.company_id, so.status::text AS status, count(*) AS undated_lines
          FROM ${T("mfg_sales_order_items")} i
          JOIN ${T("mfg_sales_orders")} so ON so.doc_no = i.doc_no
         WHERE i.line_delivery_date IS NULL AND so.customer_delivery_date IS NULL
           AND ${C.mfg_sales_order_items.has("cancelled") ? "COALESCE(i.cancelled, FALSE) = FALSE" : "TRUE"}
           AND COALESCE(i.qty, 0) > 0
           AND UPPER(so.status::text) NOT IN ('CANCELLED','CLOSED','DELIVERED','INVOICED')
         GROUP BY so.doc_no, so.company_id, so.status ORDER BY so.doc_no`);
      const totalLines = soRows.reduce((a, r) => a + Number(r.undated_lines), 0);
      notice(`  live SO lines with NO line date AND NO header date : ${totalLines} across ${soRows.length} SO(s)`);
      notice("  (mrp.ts:555-560 — these are DROPPED from the MRP page by default (includeUndated=false),");
      notice("   while every other caller passes true, so the screens disagree about demand.)");
      for (const r of soRows.slice(0, SAMPLE)) notice(`    ${pad(r.doc_no, 20)} co=${r.company_id} ${pad(r.status, 14)} ${r.undated_lines} undated line(s)`);
      if (soRows.length > SAMPLE) notice(`    ... and ${soRows.length - SAMPLE} more SOs.`);
      if (has("purchase_order_items", "delivery_date") && has("purchase_orders", "po_number", "expected_at")) {
        const poRows = await pg.unsafe(`
          SELECT count(*)::int AS n FROM ${T("purchase_order_items")} poi
            JOIN ${T("purchase_orders")} po ON po.id = poi.purchase_order_id
           WHERE poi.delivery_date IS NULL AND po.expected_at IS NULL
             AND UPPER(po.status::text) NOT IN ('CANCELLED','CLOSED','COMPLETED','RECEIVED')`);
        notice(`  (informational) live PO lines with no line ETA and no header expected_at: ${poRows[0].n} — these sort LAST in MRP supply, they are not dropped.`);
      }
      notice("  JUDGEMENT: fillable-needs-owner. A delivery date is a promise to a customer; no other row in");
      notice("  the database can prove it. The list above is the owner's worklist (or the call to accept the");
      notice("  MRP-page default and leave them).");
    }
  } catch (e) { sectionFailed("3. delivery dates", e); }

  // ==========================================================================
  // 4. mfg_products.category NULL (the enum-cast trap class)
  // ==========================================================================
  try {
    hdr("4. mfg_products.category NULL — and the enum-cast trap that hid it");
    if (!has("mfg_products", "code", "category")) {
      notice("  SKIPPED — columns absent.");
    } else {
      const coCol = C.mfg_products.has("company_id") ? "company_id" : "NULL::int AS company_id";
      // category::text BEFORE any string default — COALESCE(category, '(null)')
      // coerces the literal INTO the enum and dies with 22P02 at plan time
      // (this exact bug killed check-2990-completeness.mjs; fixed in this PR).
      const rows = await pg.unsafe(`
        SELECT ${coCol}, code, name FROM ${T("mfg_products")}
         WHERE category IS NULL ORDER BY code LIMIT 500`);
      const count = await pg.unsafe(`SELECT count(*)::int AS n FROM ${T("mfg_products")} WHERE category IS NULL`);
      notice(`  products with NULL category : ${count[0].n}`);
      let provable = 0;
      for (const r of rows.slice(0, SAMPLE)) {
        let sibling = [];
        if (C.mfg_products.has("company_id")) {
          sibling = await pg.unsafe(`
            SELECT company_id, category::text AS category FROM ${T("mfg_products")}
             WHERE code = $1 AND category IS NOT NULL LIMIT 3`, [r.code]);
        }
        if (sibling.length > 0) provable += 1;
        notice(`    co=${r.company_id ?? "-"} ${pad(short(r.code, 24), 24)} ${short(r.name, 30)}${sibling.length ? `  -> sibling company ${sibling[0].company_id} says ${sibling[0].category} (fillable-provable)` : "  (no cross-company sibling — fillable-needs-owner)"}`);
      }
      if (count[0].n > SAMPLE) notice(`    ... and ${count[0].n - SAMPLE} more.`);
      notice(`  JUDGEMENT: rows with a categorised same-code sibling in the other company are fillable-provable`);
      notice(`  (copy the sibling's category); the rest are fillable-needs-owner. Until filled these rows crash`);
      notice("  any query that COALESCEs the enum with a bare string — check-2990-completeness.mjs did exactly");
      notice("  that ('(null)' into mfg_product_category, error 22P02) and is fixed alongside this sweep.");
    }
  } catch (e) { sectionFailed("4. mfg_products.category", e); }

  // ==========================================================================
  // 5. Posted GRNs with unbilled lines (audit section 7's lens)
  // ==========================================================================
  try {
    hdr("5. Posted GRNs not yet billed by a purchase invoice");
    if (!has("grn_items", "grn_id") || !has("purchase_invoice_items", "grn_item_id")) {
      notice("  SKIPPED — purchase_invoice_items.grn_item_id absent (pre-PI-linkage schema).");
    } else {
      const rows = await pg.unsafe(`
        WITH pi AS (
          SELECT pii.grn_item_id FROM ${T("purchase_invoice_items")} pii
            JOIN ${T("purchase_invoices")} p ON p.id = pii.purchase_invoice_id
           WHERE pii.grn_item_id IS NOT NULL AND UPPER(p.status::text) NOT IN ('DRAFT','CANCELLED')
           GROUP BY pii.grn_item_id
        )
        SELECT g.grn_number, g.company_id, g.status::text AS status,
               (now()::date - g.created_at::date)::int AS age_days,
               count(gi.id) AS lines,
               count(gi.id) FILTER (WHERE pi.grn_item_id IS NULL) AS unbilled_lines
          FROM ${T("grns")} g
          JOIN ${T("grn_items")} gi ON gi.grn_id = g.id
          LEFT JOIN pi ON pi.grn_item_id = gi.id
         WHERE UPPER(g.status::text) NOT IN ('DRAFT','CANCELLED')
         GROUP BY g.grn_number, g.company_id, g.status, g.created_at
        HAVING count(gi.id) FILTER (WHERE pi.grn_item_id IS NULL) > 0
         ORDER BY g.created_at`);
      notice(`  posted GRNs with at least one unbilled line : ${rows.length}`);
      for (const r of rows) notice(`    ${pad(r.grn_number, 22)} co=${r.company_id} ${pad(r.status, 10)} age=${pad(r.age_days + "d", 6)} unbilled ${r.unbilled_lines}/${r.lines} line(s)`);
      notice("  JUDGEMENT: leave-alone as data — a purchase invoice is a business event from the supplier and");
      notice("  cannot be backfilled; this list exists to reconcile against the set the owner already accepts");
      notice("  as legitimately awaiting invoices. Anything here the owner does NOT recognise is a chase-up.");
    }
  } catch (e) { sectionFailed("5. unbilled GRNs", e); }

  // ==========================================================================
  // 6. SO lines missing line_no / variants where a sibling proves them
  // ==========================================================================
  try {
    hdr("6. SO lines: NULL line_no in MIXED docs; NULL variants a DO line disproves");
    if (!has("mfg_sales_order_items", "doc_no", "line_no")) {
      notice("  SKIPPED — line_no absent.");
    } else {
      const cancelledFilter = C.mfg_sales_order_items.has("cancelled") ? "COALESCE(cancelled, FALSE) = FALSE" : "TRUE";
      const mixed = await pg.unsafe(`
        SELECT doc_no, count(*)::int AS total, count(*) FILTER (WHERE line_no IS NULL)::int AS nulls
          FROM ${T("mfg_sales_order_items")}
         WHERE ${cancelledFilter}
         GROUP BY doc_no
        HAVING count(*) FILTER (WHERE line_no IS NULL) > 0
           AND count(*) FILTER (WHERE line_no IS NULL) < count(*)
         ORDER BY doc_no`);
      const oneNull = mixed.filter((r) => Number(r.nulls) === 1);
      notice(`  SOs with a MIXED line_no regime (some numbered, some NULL): ${mixed.length}`);
      notice(`    ... exactly ONE un-numbered line (fillable-provable: it takes MAX(line_no)+1, the add-path rule): ${oneNull.length}`);
      for (const r of mixed.slice(0, SAMPLE)) notice(`    ${pad(r.doc_no, 22)} ${r.nulls} of ${r.total} line(s) un-numbered${Number(r.nulls) === 1 ? "  (provable)" : "  (order among the NULLs is unknowable — needs-owner)"}`);
      notice("  (docs where EVERY line is un-numbered are a consistent pre-line_no regime and are left alone");
      notice("   by design — mfg-sales-orders.ts:7413. Only the mixed docs break ordinal pairing.)");

      if (has("mfg_sales_order_items", "variants") && has("delivery_order_items", "so_item_id", "variants")) {
        const varRows = await pg.unsafe(`
          SELECT i.doc_no, i.item_code, i.id,
                 (SELECT di.variants::text FROM ${T("delivery_order_items")} di
                   WHERE di.so_item_id = i.id AND di.variants IS NOT NULL
                     AND di.variants::text NOT IN ('null','{}') LIMIT 1) AS do_variants
            FROM ${T("mfg_sales_order_items")} i
           WHERE (i.variants IS NULL OR i.variants::text IN ('null','{}'))
             AND ${cancelledFilter.replaceAll("cancelled", "i.cancelled")}
             AND EXISTS (SELECT 1 FROM ${T("delivery_order_items")} di
                          WHERE di.so_item_id = i.id AND di.variants IS NOT NULL
                            AND di.variants::text NOT IN ('null','{}'))
           ORDER BY i.doc_no LIMIT 200`);
        notice("");
        notice(`  SO lines with EMPTY variants whose OWN DO line carries variants (fillable-provable copy-back): ${varRows.length}`);
        for (const r of varRows.slice(0, SAMPLE)) notice(`    ${pad(r.doc_no, 22)} ${pad(short(r.item_code, 22), 22)} <- DO line says ${short(r.do_variants, 60)}`);
      }
      notice("  JUDGEMENT: the two provable sets above can be backfilled by a gated script copying the evidence");
      notice("  shown; everything else is fillable-needs-owner. NULL variants with no DO evidence pool into the");
      notice("  '' variant bucket (audit-mrp-pairing legacyShared) — a known, accepted ambiguity.");
    }
  } catch (e) { sectionFailed("6. line_no / variants", e); }

  // ==========================================================================
  // 7. Remaining bare-number doc references (columns the importer never prefixed)
  // ==========================================================================
  try {
    hdr("7. Bare-number sweep — reference columns outside the repaired set");
    notice("  The importer prefixed DOCNO_COL + PREFIX_REF_COLS; parts notes/batches/consumptions/ids repaired");
    notice("  purchase_orders.notes + batch_no + ledger source refs. These columns were in NEITHER list.");
    // One in-memory index of every real doc number (all 8 doc families).
    const docTables = [
      ["mfg_sales_orders", "doc_no"], ["delivery_orders", "do_number"], ["grns", "grn_number"],
      ["purchase_orders", "po_number"], ["sales_invoices", "invoice_number"], ["purchase_invoices", "invoice_number"],
      ["delivery_returns", C.delivery_returns.has("dr_number") ? "dr_number" : "return_number"],
      ["purchase_returns", C.purchase_returns.has("pr_number") ? "pr_number" : "return_number"],
    ];
    const docIndex = new Map(); // number -> count across all doc tables
    for (const [t, col] of docTables) {
      if (!has(t, col)) continue;
      const rows = await pg.unsafe(`SELECT "${ident(col)}" AS n FROM ${T(t)} WHERE "${ident(col)}" IS NOT NULL`);
      for (const r of rows) docIndex.set(String(r.n), (docIndex.get(String(r.n)) ?? 0) + 1);
    }
    notice(`  doc-number index built: ${docIndex.size} distinct real document numbers across ${docTables.length} families`);

    const sweep = [
      ["journal_entries", "source_doc_no"],
      ["mfg_products", "source_doc_no"],
      ["warehouse_rack_items", "source_doc_no"],
      ["warehouse_rack_movements", "source_doc_no"],
      ["inventory_lots", "source_doc_no"],
      ["mfg_sales_orders", "po_doc_no"],
      ["mfg_sales_orders", "linked_do_doc_no"],
      ["sales_invoices", "so_doc_no"],
      ["mfg_so_audit_log", "so_doc_no"],
      ["mfg_so_price_overrides", "doc_no"],
      ["mfg_so_status_changes", "doc_no"],
      ["pending_slip_uploads", "doc_no"],
      ["so_revisions", "doc_no"],
      ["delivery_order_items", "committed_po_batch_no"],
    ];
    notice(`  ${pad("table.column", 46)} ${pad("values", 8)} ${pad("resolve", 8)} ${pad("heal->2990-", 11)} ${pad("dangling", 8)}`);
    for (const [t, col] of sweep) {
      if (!has(t, col)) { notice(`  ${pad(`${t}.${col}`, 46)} SKIPPED (absent)`); continue; }
      const hasCo = C[t].has("company_id");
      const rows = await pg.unsafe(`
        SELECT "${ident(col)}" AS v, ${hasCo ? "company_id" : "NULL::int AS company_id"}, count(*)::int AS n
          FROM ${T(t)} WHERE "${ident(col)}" IS NOT NULL AND btrim("${ident(col)}"::text) <> ''
         GROUP BY "${ident(col)}"${hasCo ? ", company_id" : ""}`);
      let total = 0, resolves = 0, healable = 0, dangling = 0;
      const healSamples = [];
      const danglingSamples = [];
      for (const r of rows) {
        total += Number(r.n);
        const v = String(r.v);
        if (docIndex.has(v)) { resolves += Number(r.n); continue; }
        const prefixed = `2990-${v}`;
        if (Number(r.company_id) === 2 && docIndex.get(prefixed) === 1 && !v.startsWith("2990-")) {
          healable += Number(r.n);
          if (healSamples.length < 12) healSamples.push(`${v} -> ${prefixed} (${r.n} row(s))`);
        } else {
          dangling += Number(r.n);
          if (danglingSamples.length < 8) danglingSamples.push(`${v} (co=${r.company_id ?? "-"}, ${r.n} row(s))`);
        }
      }
      notice(`  ${pad(`${t}.${col}`, 46)} ${pad(total, 8)} ${pad(resolves, 8)} ${pad(healable, 11)} ${pad(dangling, 8)}`);
      for (const s of healSamples) notice(`      HEALABLE  ${s}`);
      for (const s of danglingSamples) notice(`      DANGLING  ${s}`);
    }
    notice("  columns: values = non-empty rows; resolve = the stored string IS a real doc number; heal->2990- =");
    notice("  company-2 rows whose 2990-prefixed form matches EXACTLY ONE real document (the classifyToken rule");
    notice("  — fillable-provable via a new part of repair-2990-doc-refs); dangling = matches nothing either way");
    notice("  (fillable-needs-owner, or an external/customer reference that is legitimately not an internal doc).");
    notice("  NOTE: resolution here is by GLOBAL string match; the gated repair itself must re-prove per-company");
    notice("  (colliding tails are why — see doc-ref-repair-core.mjs). This sweep sizes the work, nothing more.");
  } catch (e) { sectionFailed("7. bare-number sweep", e); }

  notice("");
  notice("=== END — read-only, no rows changed. ===");
}

main()
  .then(() => pg.end({ timeout: 5 }))
  .catch(async (e) => {
    console.error("BACKFILLABLE_GAPS_CHECK_FAIL", e.message);
    try { await pg.end({ timeout: 5 }); } catch { /* closing */ }
    process.exit(1);
  });
