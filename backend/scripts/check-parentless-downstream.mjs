#!/usr/bin/env node
// READ-ONLY: how many Delivery Orders, GRNs, Sales Invoices and Purchase
// Invoices in production were raised with NO PARENT — and therefore can never
// exist in AutoCount at all?
//
// ── WHY THIS NUMBER DECIDES SOMETHING ───────────────────────────────────────
// AutoCount's 2.2 SDK has exactly one construction primitive for these four
// document types: AddPartialTransferDetail(fromDocType, fromDocDtlKeys) — you
// build a DO / GRN / Invoice / Purchase Invoice by TRANSFERRING a source
// document's lines. There is no AddNew for them, which is why AcSyncService has
// /create-so and /create-po and no third create, and why inventing a
// /create-do would not help: the SDK has nothing to call.
//
// So a downstream document the ERP raised without a parent is a PERMANENT SHAPE
// MISMATCH, not a bug with a fix. The ERP allows it deliberately — the owner's
// 2026-05-29 decision that a GRN need not have a PO, and the standalone-invoice
// path — and every one of those documents will stay ERP-only forever.
//
// The count is what the owner needs to decide between:
//   • add a "must come from a parent" guard in the ERP (if the number is small
//     and the shape is really an accident), or
//   • accept the gap and rely on the outbox's 'skipped' rows to find them (if
//     the number is large, i.e. it is how the business actually works).
//
// recordParentlessCreate (PR #1979) writes a visible 'skipped' outbox row for
// every one of these going FORWARD. This script measures the documents that
// already exist, which no outbox row describes.
//
// ── WHAT "PARENTLESS" MEANS PER TYPE ────────────────────────────────────────
// Measured on the LINE links, not on a header flag, because the line link is
// what a transfer would need:
//
//   DO  parentless = no line carries so_item_id, and the header names no SO
//   GR  parentless = no line carries purchase_order_item_id
//   SI  parentless = no line carries do_item_id
//   PI  parentless = no line carries grn_item_id
//
// PARTIALLY parented is reported separately and matters just as much: a
// document where SOME lines came from a parent and some were typed in has a
// counterpart AutoCount can build, but that counterpart is missing the ad-hoc
// lines. It is a divergence of a different shape, so it is counted apart rather
// than folded into either bucket.
//
// SELECTs only. No writes, no DDL, no transaction. Exit 0 for every legitimate
// answer; the output IS the answer. Exit non-zero only if the DB is unreachable.
//   DATABASE_URL  required
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

const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 10 });

/* One row per document type. `parentTable` is only used in the prose. */
const TYPES = [
  {
    label: "DO  (Delivery Order)",
    head: "scm.delivery_orders",
    headId: "id",
    docNo: "do_number",
    items: "scm.delivery_order_items",
    itemFk: "delivery_order_id",
    sourceFk: "so_item_id",
    parent: "Sales Order",
    /* The DO is the one type that also carries a HEADER-level parent, and the
       header is what the create route branches on, so both are read. */
    headParent: "so_doc_no",
  },
  {
    label: "GR  (Goods Received Note)",
    head: "scm.grns",
    headId: "id",
    docNo: "grn_number",
    items: "scm.grn_items",
    itemFk: "grn_id",
    sourceFk: "purchase_order_item_id",
    parent: "Purchase Order",
    headParent: null,
  },
  {
    label: "SI  (Sales Invoice)",
    head: "scm.sales_invoices",
    headId: "id",
    docNo: "invoice_number",
    items: "scm.sales_invoice_items",
    itemFk: "sales_invoice_id",
    sourceFk: "do_item_id",
    parent: "Delivery Order",
    headParent: null,
  },
  {
    label: "PI  (Purchase Invoice)",
    head: "scm.purchase_invoices",
    headId: "id",
    docNo: "invoice_number",
    items: "scm.purchase_invoice_items",
    itemFk: "purchase_invoice_id",
    sourceFk: "grn_item_id",
    parent: "Goods Received Note",
    headParent: null,
  },
];

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);

async function census(t) {
  /* One statement per type. Classifies EVERY document by how many of its lines
     name a source line: none / some / all. A document with no lines at all is
     its own answer and is reported rather than silently bucketed. */
  const rows = await sql.unsafe(`
    WITH doc AS (
      SELECT h.${t.headId} AS id,
             h.${t.docNo}  AS doc_no,
             h.company_id,
             /* ::text FIRST — status is a Postgres ENUM per type, and
                COALESCE(status,'') tries to cast '' INTO the enum and errors. */
             h.status::text AS status,
             ${t.headParent ? `h.${t.headParent}` : "NULL::text"} AS head_parent,
             COUNT(i.id)                                        AS lines,
             COUNT(i.${t.sourceFk})                             AS linked
        FROM ${t.head} h
        LEFT JOIN ${t.items} i ON i.${t.itemFk} = h.${t.headId}
       GROUP BY 1,2,3,4,5
    )
    SELECT company_id,
           COUNT(*)                                                       AS total,
           COUNT(*) FILTER (WHERE lines = 0)                              AS no_lines,
           COUNT(*) FILTER (WHERE lines > 0 AND linked = 0)               AS parentless,
           COUNT(*) FILTER (WHERE lines > 0 AND linked > 0 AND linked < lines) AS partial,
           COUNT(*) FILTER (WHERE lines > 0 AND linked = lines)           AS parented,
           COUNT(*) FILTER (WHERE lines > 0 AND linked = 0
                            AND UPPER(COALESCE(status,'')) = 'CANCELLED') AS parentless_cancelled,
           COUNT(*) FILTER (WHERE lines > 0 AND linked = 0
                            AND head_parent IS NOT NULL)                   AS parentless_but_header_names_one
      FROM doc
     GROUP BY company_id
     ORDER BY company_id
  `);
  return rows;
}

async function samples(t) {
  const rows = await sql.unsafe(`
    WITH doc AS (
      SELECT h.${t.headId} AS id, h.${t.docNo} AS doc_no, h.company_id, h.status::text AS status,
             COUNT(i.id) AS lines, COUNT(i.${t.sourceFk}) AS linked
        FROM ${t.head} h
        LEFT JOIN ${t.items} i ON i.${t.itemFk} = h.${t.headId}
       GROUP BY 1,2,3,4
    )
    SELECT doc_no, company_id, status, lines
      FROM doc WHERE lines > 0 AND linked = 0
     ORDER BY doc_no DESC LIMIT 8
  `);
  return rows;
}

(async () => {
  try {
    console.log("PARENTLESS DOWNSTREAM DOCUMENT CENSUS");
    console.log("read-only, " + new Date().toISOString());
    console.log(
      "\nA parentless DO / GR / SI / PI can NEVER be created in AutoCount: the 2.2 SDK\n"
      + "builds these four only by transferring a source document's lines\n"
      + "(AddPartialTransferDetail is its one primitive), so there is no route to invent.\n"
      + "These counts are the size of that permanent gap.\n",
    );

    const grand = {};
    for (const t of TYPES) {
      let rows;
      try {
        rows = await census(t);
      } catch (e) {
        console.log(`\n${t.label} — COULD NOT MEASURE: ${e.message}`);
        continue;
      }
      console.log(`\n${t.label} — parent is a ${t.parent}`);
      console.log(
        "   " + pad("company", 9) + num("total", 8) + num("parentless", 12)
        + num("partial", 9) + num("parented", 10) + num("no lines", 10),
      );
      let tot = 0, pl = 0, pa = 0, pd = 0, nl = 0, plc = 0, plh = 0;
      for (const r of rows) {
        console.log(
          "   " + pad(r.company_id, 9) + num(r.total, 8) + num(r.parentless, 12)
          + num(r.partial, 9) + num(r.parented, 10) + num(r.no_lines, 10),
        );
        tot += Number(r.total); pl += Number(r.parentless); pa += Number(r.partial);
        pd += Number(r.parented); nl += Number(r.no_lines);
        plc += Number(r.parentless_cancelled);
        plh += Number(r.parentless_but_header_names_one);
      }
      console.log(
        "   " + pad("ALL", 9) + num(tot, 8) + num(pl, 12) + num(pa, 9) + num(pd, 10) + num(nl, 10),
      );
      const pct = tot ? ((pl / tot) * 100).toFixed(1) : "0.0";
      console.log(`   parentless share: ${pct}% of all ${t.label.trim().split(" ")[0]} documents`);
      console.log(`   of those parentless, ${plc} are CANCELLED (already dead on both sides)`);
      if (t.headParent) {
        console.log(
          `   ${plh} name a ${t.parent} on the HEADER but link no line to it — `
          + "the transfer has a source document and no source LINES, so it still cannot be built",
        );
      }
      console.log(
        `   PARTIAL (${pa}) is its own divergence: AutoCount can build the document from the `
        + "linked lines,\n     but the ad-hoc lines on it would be missing from the account book.",
      );
      grand[t.label] = { total: tot, parentless: pl, partial: pa, parented: pd, noLines: nl };

      if (pl > 0) {
        const ex = await samples(t);
        console.log("   most recent examples:");
        for (const r of ex) {
          console.log(`     ${r.doc_no}  company ${r.company_id}  ${r.status ?? "-"}  ${r.lines} line(s)`);
        }
      }
    }

    console.log("\n\nVERDICT — documents that can NEVER sync, by type");
    console.log("   " + pad("type", 28) + num("total", 8) + num("can never sync", 16));
    let sumAll = 0, sumBad = 0;
    for (const [label, g] of Object.entries(grand)) {
      console.log("   " + pad(label, 28) + num(g.total, 8) + num(g.parentless, 16));
      sumAll += g.total; sumBad += g.parentless;
    }
    console.log("   " + pad("ALL FOUR", 28) + num(sumAll, 8) + num(sumBad, 16));
    console.log(
      "\nThis is the number the owner's decision turns on: a small count argues for a\n"
      + "\"must come from a parent\" guard in the ERP; a large one says this IS how the\n"
      + "business works and the gap has to be accepted and monitored instead.\n"
      + "Either way every FUTURE one now writes a visible 'skipped' outbox row\n"
      + "(recordParentlessCreate), so the set stops growing in silence.",
    );
  } catch (e) {
    console.error("FAILED to read the database:", e.message);
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
})();
