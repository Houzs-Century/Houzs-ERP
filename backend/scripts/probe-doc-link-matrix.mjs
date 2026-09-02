#!/usr/bin/env node
// ----------------------------------------------------------------------------
// READ-ONLY. THE 36-CELL DOCUMENT-LINK MATRIX, our side.
//
// Owner, 2026-09-01: 「你还得从 PO 查看也是啊 — 6 种相互组合就是 36 个审查方式了」.
// He is right. `check-ac-erp-doc-links` covers SEVEN edges, not thirty-six, and
// "I checked SO->PO" is one direction of one pair.
//
// This prints the whole 6x6 grid for the ERP's OWN data: for every ordered pair
// of SO / DO / GR / PO / SI / PI, is there a link at all, how many rows carry
// it, and how many point at a parent that does not exist.
//
// IT NEEDS NO BOOK SNAPSHOT, and that is the point. The AutoCount comparison is
// a different question, blocked on a fresh export; this half is answerable today
// and was being deferred behind that.
//
// THE COLUMNS ARE DISCOVERED, NOT LISTED. A hand-written list goes stale the
// first time somebody adds a column, and this file would then report a clean
// grid over a link it had never heard of. It reads information_schema for
// columns whose NAME names another document type. Anything it cannot place is
// REPORTED, never dropped.
//
// PRIVACY: this repository and its Actions logs are PUBLIC. Counts and column
// names only — no document numbers, no customer, no amount.
//
// NOTHING IS WRITTEN. SELECTs only, no DDL, no transaction.
//
//   DATABASE_URL   required
//
// RE-RUN: idempotent and side-effect free.
// ----------------------------------------------------------------------------
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL required"); process.exit(2); }
const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

/* The six document types with their header and line tables, and the column a
   child points AT. The TYPES are domain knowledge and are written out; the
   COLUMNS are discovered below. */
const DOC = {
  SO: { head: "mfg_sales_orders",   line: "mfg_sales_order_items",  headKey: "doc_no", lineKey: "id" },
  DO: { head: "delivery_orders",    line: "delivery_order_items",   headKey: "id",     lineKey: "id" },
  GR: { head: "grns",               line: "grn_items",              headKey: "id",     lineKey: "id" },
  PO: { head: "purchase_orders",    line: "purchase_order_items",   headKey: "id",     lineKey: "id" },
  SI: { head: "sales_invoices",     line: "sales_invoice_items",    headKey: "id",     lineKey: "id" },
  PI: { head: "purchase_invoices",  line: "purchase_invoice_items", headKey: "id",     lineKey: "id" },
};
const TYPES = Object.keys(DOC);

/* Which document type does a column NAME point at, and is it a LINE or a HEADER
   it points at? Longest-first so `purchase_order_item_id` is never read as
   `purchase_order_id`. */
const NAME_HINT = [
  ["purchase_invoice_item_id", "PI", "line"], ["purchase_invoice_id", "PI", "head"],
  ["purchase_order_item_id",   "PO", "line"], ["purchase_order_id",   "PO", "head"],
  ["sales_invoice_item_id",    "SI", "line"], ["sales_invoice_id",    "SI", "head"],
  ["delivery_order_item_id",   "DO", "line"], ["delivery_order_id",   "DO", "head"],
  ["do_item_id",               "DO", "line"], ["do_id",               "DO", "head"],
  ["grn_item_id",              "GR", "line"], ["grn_id",              "GR", "head"],
  ["so_item_id",               "SO", "line"], ["so_doc_no",           "SO", "head"],
  ["sales_order_id",           "SO", "head"],
];
function hintOf(col) {
  const c = String(col).toLowerCase();
  for (const [needle, t, side] of NAME_HINT) if (c === needle) return { t, side };
  return null;
}

const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });

async function main() {
  const tables = [];
  for (const [t, d] of Object.entries(DOC)) {
    tables.push({ name: d.head, type: t, side: "head" });
    tables.push({ name: d.line, type: t, side: "line" });
  }
  const tableNames = tables.map((x) => x.name);

  const cols = await sql`
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'scm' AND table_name = ANY(${tableNames})
     ORDER BY table_name, column_name`;

  const edges = new Map();   // "FROM->TO" -> [{table, column, targetTable, targetKey}]
  const unplaced = [];
  for (const r of cols) {
    const hint = hintOf(r.column_name);
    if (!hint) continue;
    const owner = tables.find((x) => x.name === r.table_name);
    if (!owner) { unplaced.push(`${r.table_name}.${r.column_name}`); continue; }
    /* A column on the SO table naming an SO is the row's own key, not an edge. */
    if (owner.type === hint.t) continue;
    const target = DOC[hint.t];
    const key = `${owner.type}->${hint.t}`;
    if (!edges.has(key)) edges.set(key, []);
    edges.get(key).push({
      table: r.table_name,
      column: r.column_name,
      targetTable: hint.side === "line" ? target.line : target.head,
      targetKey: hint.side === "line" ? target.lineKey : target.headKey,
    });
  }

  log("=== THE 6x6 GRID — is there a link FROM (row) TO (column)? ===");
  log(`          ${TYPES.map((t) => t.padStart(4)).join("")}`);
  for (const a of TYPES) {
    const row = TYPES.map((b) => (a === b ? "   ." : (edges.get(`${a}->${b}`)?.length ? "   Y" : "   -"))).join("");
    log(`    ${a.padEnd(4)} ${row}`);
  }
  log("    Y = at least one column links them. - = NO link in our schema at all.");
  log("    . = same type. ORDERED: SO->PO and PO->SO are different cells.");
  const present = [...edges.keys()].length;
  log(`    ${present} of the 30 cross-type cells carry a link; ${30 - present} are blind.`);

  log("");
  log("=== EVERY LINK, FILLED AND DANGLING ===");
  for (const a of TYPES) {
    for (const b of TYPES) {
      for (const e of edges.get(`${a}->${b}`) ?? []) {
        try {
          const rows = await sql.unsafe(
            `SELECT COUNT(*)::int AS total,
                    COUNT(x.${e.column})::int AS filled,
                    COUNT(*) FILTER (WHERE x.${e.column} IS NOT NULL
                      AND NOT EXISTS (SELECT 1 FROM scm.${e.targetTable} p
                                       WHERE p.${e.targetKey} = x.${e.column}))::int AS dangling
               FROM scm.${e.table} x`);
          const n = rows[0];
          log(`   ${a}->${b}  ${e.table}.${e.column}  ->  scm.${e.targetTable}.${e.targetKey}`);
          log(`        ${n.filled} of ${n.total} rows carry it; DANGLING ${n.dangling}`);
        } catch (err) {
          log(`   ${a}->${b}  ${e.table}.${e.column}  — NOT COUNTABLE: ${String(err.message).slice(0, 90)}`);
        }
      }
    }
  }

  if (unplaced.length) {
    log("");
    log(`NAMED LIKE A LINK but the owner table is not one of the six: ${unplaced.length}`);
    for (const u of unplaced.slice(0, 20)) log(`   ${u}`);
  }

  log("");
  log("WHAT THIS DOES NOT ANSWER: whether the BOOK agrees. AutoCount records the");
  log("same relationships GENERICALLY on the detail line — FromDocType / FromDocNo /");
  log("FromDocDtlKey on SODTL, DODTL, IVDTL, PODTL and PIDTL, plus PODTL.FromSODtlKey,");
  log("PODTL.FromSODocList and IVDTL.ValueXferSODocKey (read live off the host with");
  log("Windows auth, 2026-09-02). GRNDTL carries NONE of them, and that is not a");
  log("gap: AutoCount names the source at TRANSFER time (FullTransfer /");
  log("PartialTransfer, its own wiki) and keeps only PODTL.TransferedQty, so a");
  log("GRN->PO comparison must compare QUANTITY, never a parent key — as a join it");
  log("would report every row missing. See docs/modules/autocount-writeback.md.");
  log("Comparing the rest of the two sides still needs a fresh export.");
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
