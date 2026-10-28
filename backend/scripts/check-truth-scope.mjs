#!/usr/bin/env node
// LANE C — SIZE THE "convert our migrated paperwork into invoices" JOB, read-only.
//
// The owner asked for our GRNs to become purchase invoices and our DOs to become
// sales invoices, so our relationship map matches AutoCount's. Before writing a
// single document we have to know how big that job actually is, and — the part
// that decides whether it can be done at all — how many of our lines would get a
// REAL cost out of it and how many would not.
//
// This script emits the ERP HALF of that answer. It cannot answer the whole
// question alone: the prices live in AutoCount, a different database on a
// different host that no GitHub runner can reach. So it dumps the ERP-side facts
// as machine-readable TSV, and a companion local script
// (scratchpad ac-truth-scope.py) joins them to live AutoCount over read-only ODBC.
//
// THE JOIN PATH — and the thing this check DISPROVED on its first run.
//
// The design assumed an exact line-to-line key existed:
//   scm.grn_items.purchase_order_item_id
//     -> scm.purchase_order_items.linked_ac_dtlkey   (migration 0273)
//     == AutoCount PODTL.DtlKey
// Migration 0273 does add that column. IT WAS NEVER BACKFILLED: on production,
// 2026-08-11, it is populated on 0 of 496 migrated GRN lines, 0 of 59 migrated
// DO lines and 0 of 864 cutover PO lines. So the exact key does not exist in
// data, and this script REPORTS that count rather than quietly falling back —
// a join path that silently degrades is how a wrong cost gets written.
//
// What is left is document-level, and it is what the conversion must actually
// use: grns.linked_ac_docno gives the AutoCount PO number, and
// purchase_orders.linked_ac_grn_docnos gives the AutoCount GR number(s). From
// there AutoCount itself has no line keys either (PIDTL.FromDocDtlKey populated
// on 0 of 20,777 rows; IVDTL.FromDocDtlKey on 0 of 43,522), so the last hop
// uses the three-part (document, ItemCode, Desc2) key. All of that lives on the
// AutoCount side and is measured there, not here.
//
// This script therefore emits the DOCUMENT numbers and the line facts, and
// leaves every price decision to the AutoCount half.
//
// STRICTLY READ-ONLY. SELECT only — no DDL, no writes, no transaction, no marker
// rows. Every interpolated identifier is a schema/column name DISCOVERED from
// information_schema and re-validated against ^[a-z_][a-z0-9_]*$; no user input
// reaches any statement. Exits 0 for every legitimate answer (the ANSWER is the
// output, not the exit code); non-zero only when the database is unreachable, a
// query errors, or a table this check depends on is missing — a missing table is
// a "cannot answer", never a quiet zero.
//
// Mirrors backend/scripts/check-costless-stock.mjs (the repo's read-only
// diagnostic shape) and its workflow .github/workflows/truth-scope-check.yml.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const CO = 1; // Houzs. The cutover, the bound-allocation rule and the owner's
// diagnostic principle are all company 1; widening the scope here would mix
// 2990's documents into a count that is supposed to describe Houzs.

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}
const DSN = resolveUrl();
if (!DSN) {
  console.error("FATAL — no DATABASE_URL (env or backend/.dev.vars).");
  process.exit(2);
}

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
const inCI = !!process.env.GITHUB_ACTIONS;
// ::notice:: renders in the Actions summary; the TSV rows must stay plain so the
// companion script can parse the raw log without stripping annotations.
const notice = (m) => console.log(inCI ? `::notice::${m}` : m);
const row = (m) => console.log(m);

const IDENT = /^[a-z_][a-z0-9_]*$/;
function ident(s) {
  if (!IDENT.test(s)) throw new Error(`refusing unsafe identifier: ${s}`);
  return s;
}

async function schemaOf(table) {
  const r = await sql`SELECT table_schema FROM information_schema.tables
    WHERE table_name = ${table} AND table_schema IN ('scm','public')
    ORDER BY CASE table_schema WHEN 'scm' THEN 0 ELSE 1 END LIMIT 1`;
  return r[0]?.table_schema;
}
async function colsOf(schema, table) {
  const r = await sql`SELECT column_name FROM information_schema.columns
    WHERE table_schema = ${schema} AND table_name = ${table}`;
  return new Set(r.map((x) => x.column_name));
}

// A number that is silently absent is worse than a loud failure: every count in
// this report is quoted to the owner, so a missing table must stop the section
// rather than report 0.
async function need(table) {
  const s = await schemaOf(table);
  if (!s) {
    notice(`FATAL — table ${table} not found in scm or public. Cannot answer. (Missing-table condition, not a data answer.)`);
    await sql.end();
    process.exit(3);
  }
  return s;
}

async function main() {
  notice(`LANE C truth-scope — company_id=${CO} — READ-ONLY`);

  const sGrn = await need("grns");
  const sGrnI = await need("grn_items");
  const sPo = await need("purchase_orders");
  const sPoI = await need("purchase_order_items");
  const sDo = await need("delivery_orders");
  const sDoI = await need("delivery_order_items");
  const sSo = await need("mfg_sales_orders");
  const sSoI = await need("mfg_sales_order_items");
  const sLot = await need("inventory_lots");

  const G = `"${ident(sGrn)}"."grns"`;
  const GI = `"${ident(sGrnI)}"."grn_items"`;
  const P = `"${ident(sPo)}"."purchase_orders"`;
  const PI_ = `"${ident(sPoI)}"."purchase_order_items"`;
  const D = `"${ident(sDo)}"."delivery_orders"`;
  const DI = `"${ident(sDoI)}"."delivery_order_items"`;
  const S = `"${ident(sSo)}"."mfg_sales_orders"`;
  const SI = `"${ident(sSoI)}"."mfg_sales_order_items"`;
  const L = `"${ident(sLot)}"."inventory_lots"`;

  const grnCols = await colsOf(sGrn, "grns");
  const poCols = await colsOf(sPo, "purchase_orders");
  const poiCols = await colsOf(sPoI, "purchase_order_items");
  const doCols = await colsOf(sDo, "delivery_orders");
  const lotCols = await colsOf(sLot, "inventory_lots");

  // The whole lane rests on these three columns existing. Say so explicitly
  // instead of letting a missing column read as "nothing to convert".
  for (const [t, cols, c] of [
    ["grns", grnCols, "migrated_no_stock"],
    ["delivery_orders", doCols, "migrated_no_stock"],
    ["purchase_order_items", poiCols, "linked_ac_dtlkey"],
    ["purchase_orders", poCols, "linked_ac_grn_docnos"],
  ]) {
    if (!cols.has(c)) {
      notice(`FATAL — ${t}.${c} is missing. The migration that adds it has not reached this database. Cannot answer.`);
      await sql.end();
      process.exit(3);
    }
  }
  notice(`schema OK — grns=${sGrn} grn_items=${sGrnI} purchase_orders=${sPo} delivery_orders=${sDo} inventory_lots=${sLot}`);

  // ── Q1. Our migrated GRNs, and the AutoCount receipts/invoices behind them ──
  notice("═══ Q1 — migrated GRNs ═══");
  const [gCount] = await sql.unsafe(`
    SELECT COUNT(*)::int AS n,
           COUNT(*) FILTER (WHERE linked_ac_docno IS NOT NULL)::int AS with_ac
    FROM ${G} WHERE company_id = ${CO} AND migrated_no_stock = true`);
  notice(`migrated GRNs: ${gCount.n} (with linked_ac_docno ${gCount.with_ac})`);

  // grns.linked_ac_docno holds the PO's AutoCount number, NOT the GR's — the
  // creating script wrote po.linked_ac_docno into it, contradicting migration
  // 0276's own COMMENT. The real AutoCount GR numbers are on the PO. Emitting
  // both, named for what they ACTUALLY are, so nothing downstream re-inherits
  // that mislabel.
  const grns = await sql.unsafe(`
    SELECT g.grn_number, g.linked_ac_docno AS ac_po_no, p.po_number,
           COALESCE(p.linked_ac_grn_docnos, '{}') AS ac_grns,
           COALESCE(p.linked_ac_pinv_docnos, '{}') AS ac_pinvs
    FROM ${G} g LEFT JOIN ${P} p ON p.id = g.purchase_order_id
    WHERE g.company_id = ${CO} AND g.migrated_no_stock = true
    ORDER BY g.grn_number`);
  let withGr = 0, withPinv = 0;
  for (const r of grns) {
    const grs = r.ac_grns ?? [], pis = r.ac_pinvs ?? [];
    if (grs.length) withGr++;
    if (pis.length) withPinv++;
    row(`GRN\t${r.grn_number}\t${r.ac_po_no ?? ""}\t${r.po_number ?? ""}\t${grs.join(",")}\t${pis.join(",")}`);
  }
  notice(`of those: ${withGr} carry AutoCount GR number(s) on their PO; ${withPinv} already carry AutoCount PI number(s)`);

  // Lines, with the exact AutoCount PO line key. unit_price_sen is what the
  // GRN line costs TODAY — 0 means the cost is missing, which is the thing the
  // conversion is meant to fix.
  const gLines = await sql.unsafe(`
    SELECT g.grn_number, gi.item_code, gi.qty_received,
           COALESCE(gi.unit_price_sen, 0) AS unit_price_sen,
           pi2.linked_ac_dtlkey
    FROM ${G} g
    JOIN ${GI} gi ON gi.grn_id = g.id
    LEFT JOIN ${PI_} pi2 ON pi2.id = gi.purchase_order_item_id
    WHERE g.company_id = ${CO} AND g.migrated_no_stock = true
    ORDER BY g.grn_number, gi.item_code`);
  let gl = 0, glKeyed = 0, glZero = 0;
  for (const r of gLines) {
    gl++;
    if (r.linked_ac_dtlkey != null) glKeyed++;
    if (Number(r.unit_price_sen) === 0) glZero++;
    row(`GRNLINE\t${r.grn_number}\t${r.item_code}\t${r.qty_received}\t${r.unit_price_sen}\t${r.linked_ac_dtlkey ?? ""}`);
  }
  notice(`migrated GRN lines: ${gl}; with an exact AutoCount PO line key: ${glKeyed}; currently ZERO cost: ${glZero}`);

  // ── Q2. Our migrated DOs ───────────────────────────────────────────────────
  notice("═══ Q2 — migrated DOs ═══");
  const [dCount] = await sql.unsafe(`
    SELECT COUNT(*)::int AS n,
           COUNT(*) FILTER (WHERE linked_ac_docno IS NOT NULL)::int AS with_ac
    FROM ${D} WHERE company_id = ${CO} AND migrated_no_stock = true`);
  notice(`migrated DOs: ${dCount.n} (with linked_ac_docno ${dCount.with_ac})`);

  // Here linked_ac_docno IS the AutoCount DO number (the creating script wrote
  // d.doNo), unlike the GRN case above.
  const dos = await sql.unsafe(`
    SELECT d.do_number, d.linked_ac_docno AS ac_do_no, d.so_doc_no,
           s.linked_ac_docno AS ac_so_no
    FROM ${D} d LEFT JOIN ${S} s ON s.doc_no = d.so_doc_no AND s.company_id = d.company_id
    WHERE d.company_id = ${CO} AND d.migrated_no_stock = true
    ORDER BY d.do_number`);
  for (const r of dos) row(`DO\t${r.do_number}\t${r.ac_do_no ?? ""}\t${r.so_doc_no ?? ""}\t${r.ac_so_no ?? ""}`);

  const dLines = await sql.unsafe(`
    SELECT d.do_number, di.item_code, di.qty, si.linked_ac_dtlkey
    FROM ${D} d
    JOIN ${DI} di ON di.delivery_order_id = d.id
    LEFT JOIN ${SI} si ON si.id = di.so_item_id
    WHERE d.company_id = ${CO} AND d.migrated_no_stock = true
    ORDER BY d.do_number, di.item_code`);
  let dl = 0, dlKeyed = 0;
  for (const r of dLines) {
    dl++;
    if (r.linked_ac_dtlkey != null) dlKeyed++;
    row(`DOLINE\t${r.do_number}\t${r.item_code}\t${r.qty}\t${r.linked_ac_dtlkey ?? ""}`);
  }
  notice(`migrated DO lines: ${dl}; with an exact AutoCount SO line key: ${dlKeyed}`);

  // ── Q4. Zero-cost exposure on our side ─────────────────────────────────────
  notice("═══ Q4 — zero-cost lines and zero-cost stock on hand ═══");
  const [poZero] = await sql.unsafe(`
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE COALESCE(i.unit_price_sen,0) = 0)::int AS zero_cost,
           COUNT(*) FILTER (WHERE COALESCE(i.unit_price_sen,0) = 0 AND i.linked_ac_dtlkey IS NOT NULL)::int AS zero_cost_keyed
    FROM ${PI_} i JOIN ${P} p ON p.id = i.purchase_order_id
    WHERE p.company_id = ${CO}`);
  notice(`PO lines (company ${CO}): ${poZero.total}; ZERO cost: ${poZero.zero_cost}; of those with an AutoCount line key: ${poZero.zero_cost_keyed}`);

  const [grnZero] = await sql.unsafe(`
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE COALESCE(gi.unit_price_sen,0) = 0)::int AS zero_cost
    FROM ${GI} gi JOIN ${G} g ON g.id = gi.grn_id
    WHERE g.company_id = ${CO}`);
  notice(`GRN lines (company ${CO}, all GRNs): ${grnZero.total}; ZERO cost: ${grnZero.zero_cost}`);

  // Stock actually on hand with no cost basis. This is the number that decides
  // how much money is at stake, so it is split by lot source: a GRN lot heals
  // when a Purchase Invoice lands, an ADJUSTMENT lot never does.
  const hasCompany = lotCols.has("company_id");
  const lotWhere = hasCompany ? `AND company_id = ${CO}` : "";
  const [lots] = await sql.unsafe(`
    SELECT COUNT(*)::int AS lots, COALESCE(SUM(qty_remaining),0)::numeric AS units
    FROM ${L} WHERE qty_remaining > 0 AND COALESCE(unit_cost_sen,0) <= 0 ${lotWhere}`);
  notice(`zero-cost OPEN lots holding stock: ${lots.lots} lot(s), ${lots.units} unit(s)`);

  const bySrc = await sql.unsafe(`
    SELECT COALESCE(source_doc_type,'(null)') AS src, COUNT(*)::int AS lots,
           COALESCE(SUM(qty_remaining),0)::numeric AS units
    FROM ${L} WHERE qty_remaining > 0 AND COALESCE(unit_cost_sen,0) <= 0 ${lotWhere}
    GROUP BY 1 ORDER BY 3 DESC`);
  for (const r of bySrc) notice(`   source ${r.src}: ${r.lots} lot(s), ${r.units} unit(s)`);

  // Per-lot detail, so the RM value can be computed against real AutoCount
  // prices rather than guessed in aggregate. The product's NAME and group come
  // along because the "deliberately free" bucket (GWP / demo / display) is only
  // identifiable from them — a free unit must never be counted as a costing gap.
  const sProd = await schemaOf("products");
  const prodCols = sProd ? await colsOf(sProd, "products") : new Set();
  const joinProd = sProd && prodCols.has("code");
  const lotRows = await sql.unsafe(`
    SELECT l.item_code, COALESCE(l.source_doc_type,'') AS src,
           COALESCE(l.source_doc_no,'') AS docno, l.qty_remaining,
           ${lotCols.has("variant_key") ? "COALESCE(l.variant_key,'')" : "''"} AS variant_key,
           ${lotCols.has("warehouse_id") ? "COALESCE(l.warehouse_id::text,'')" : "''"} AS wh,
           ${joinProd && prodCols.has("name") ? "COALESCE(p.name,'')" : "''"} AS pname,
           ${joinProd && prodCols.has("item_group") ? "COALESCE(p.item_group,'')" : "''"} AS pgroup
    FROM ${L} l
    ${joinProd ? `LEFT JOIN "${ident(sProd)}"."products" p ON p.code = l.item_code` : ""}
    WHERE l.qty_remaining > 0 AND COALESCE(l.unit_cost_sen,0) <= 0 ${lotWhere.replace(/company_id/g, "l.company_id")}
    ORDER BY l.item_code`);
  for (const r of lotRows) {
    row(`ZEROLOT\t${r.item_code}\t${r.variant_key}\t${r.src}\t${r.docno}\t${r.qty_remaining}\t${r.wh}\t${String(r.pname).replace(/\s+/g, " ")}\t${r.pgroup}`);
  }

  // ── Q5. Our already-priced lines, for the cross-check against AutoCount ────
  // If AutoCount's invoice disagrees with the cost we ALREADY hold on lines we
  // got right, then reading the invoice is not a safe source and the plan dies.
  notice("═══ Q5 — our already-priced PO lines, for the AutoCount cross-check ═══");
  // linked_ac_dtlkey would have been the exact handle, but migration 0273's
  // column was never backfilled (0 rows populated), so the cross-check has to
  // key on the PO's AutoCount document number plus the item code — the same
  // handle the conversion itself would use. That is the honest test: it
  // exercises exactly the matching the plan depends on.
  const poLines = await sql.unsafe(`
    SELECT p.linked_ac_docno AS ac_po_no, i.item_code,
           COALESCE(i.unit_price_sen,0) AS unit_price_sen,
           COALESCE(i.qty,0) AS qty, COALESCE(i.received_qty,0) AS received_qty,
           COALESCE(i.linked_ac_dtlkey::text,'') AS dtlkey
    FROM ${PI_} i JOIN ${P} p ON p.id = i.purchase_order_id
    WHERE p.company_id = ${CO} AND p.linked_ac_docno IS NOT NULL
    ORDER BY p.linked_ac_docno, i.item_code`);
  for (const r of poLines) {
    row(`POLINE\t${r.ac_po_no}\t${r.item_code}\t${r.unit_price_sen}\t${r.qty}\t${r.received_qty}\t${r.dtlkey}`);
  }
  const pricedN = poLines.filter((r) => Number(r.unit_price_sen) > 0).length;
  notice(`our PO lines on cutover POs: ${poLines.length}; of those with a non-zero cost: ${pricedN}`);

  notice("END — read-only, nothing was written.");
  await sql.end();
}

main().catch(async (e) => {
  console.error("FATAL", e?.message || e);
  try { await sql.end(); } catch {}
  process.exit(1);
});
