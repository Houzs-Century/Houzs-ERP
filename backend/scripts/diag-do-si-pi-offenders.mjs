#!/usr/bin/env node
/* diag-do-si-pi-offenders — lay the BOOK and the ERP side by side, line by
 * line, for the delivery orders / sales invoices / purchase invoices that the
 * reconcile has already named as differing.
 *
 * ── IT COMPARES NOTHING, AND MUST NOT LEARN HOW ────────────────────────────
 * check-ac-erp-reconcile.mjs is the ONE instrument that decides "different"
 * (see lib/so-verdict-derive.mjs's header for why a second opinion is the
 * failure this repo has paid for three times — docs/bugs/0689, 0708). This
 * script takes the document numbers that instrument printed and DUMPS both
 * sides so a person can read what the difference actually is. It reaches no
 * verdict, prints no "differs", and its output is evidence rather than an
 * answer.
 *
 * READ-ONLY. One connection, SELECTs only, no DDL, no transaction. Exit 0 for
 * every legitimate answer; non-zero only when the dump itself cannot run.
 *
 * The book side is the committed snapshot data/ac-reconcile-truth.json.gz — the
 * same one the reconcile reads — so the two can never be looking at different
 * books. It REFUSES on a stale snapshot for the same reason the reconcile does.
 *
 * DOCS: a comma-separated list of AutoCount document numbers, or the word ALL
 * to dump every document named in the built-in offender list below.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const here = path.dirname(fileURLToPath(import.meta.url));
const SNAP = path.join(here, "data", "ac-reconcile-truth.json.gz");
const CO = Number(process.env.COMPANY_ID || 1);
const MAX_AGE_DAYS = Number(process.env.MAX_SNAPSHOT_AGE_DAYS || 2);

const url = process.env.DATABASE_URL;
if (!url) { console.error("REFUSED: DATABASE_URL not set."); process.exit(2); }
if (!fs.existsSync(SNAP)) { console.error(`REFUSED: ${SNAP} missing.`); process.exit(2); }

const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(SNAP)).toString("utf8"));
const ageDays = (Date.now() - new Date(snap.exported_at).getTime()) / 86400000;
if (ageDays > MAX_AGE_DAYS) {
  console.error(`REFUSED: snapshot is ${ageDays.toFixed(2)} days old (limit ${MAX_AGE_DAYS}).`);
  process.exit(2);
}
console.log(`book snapshot exported_at=${snap.exported_at} (${ageDays.toFixed(2)} days old)`);

const obj = (row, fields) => Object.fromEntries(fields.map((f, i) => [f, row[i]]));
function bookSide(type) {
  const t = snap.types[type];
  const headers = new Map(t.headers.map((r) => { const o = obj(r, snap.header_fields); return [o.docNo, o]; }));
  const lines = new Map();
  for (const r of t.lines) {
    const o = obj(r, snap.line_fields);
    if (!lines.has(o.docNo)) lines.set(o.docNo, []);
    lines.get(o.docNo).push(o);
  }
  const desc2 = new Map(t.desc2.map((r) => [String(r[0]), r[1]]));
  return { headers, lines, desc2 };
}

/* The offenders, copied from the tally run this lane was handed
   (actions/runs/34298132223). They are INPUT, not a finding. */
const OFFENDERS = {
  DO: [
    "DO-001604", "DO-001800", "DO-001953", "DO-004903", "DO-005583",
    "DO-010104", "DO-010332", "DO-011371", "DO-011465", "DO-011470",
    "DO-011510", "DO-011539",
    "DO-000542", "DO-002158", "DO-009112", "DO-010936", "DO-011518",
  ],
  IV: [
    "I-2506-0056", "I-2605-0294", "I-2606-0047",
    "I-001034", "I-2410-0082", "I-2412-0353", "I-2412-0374", "I-2501-0378",
    "I-2501-0408", "I-2504-0211", "I-2505-0362", "I-2506-0074",
    "I-000745", "I-2412-0065",
    "I-000213", "I-2410-0192", "I-2411-0275", "I-2411-0323",
  ],
  PI: [],
};

const sql = postgres(url, { ssl: "require", max: 1, prepare: false, connect_timeout: 30 });

const ERP = {
  DO: {
    docs: () => sql`SELECT h.do_number AS erp_no, h.linked_ac_docno AS ac_no,
        COALESCE(h.local_total_sen,0) AS total_sen, h.status::text AS status, h.created_at
      FROM scm.delivery_orders h WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`,
    lines: () => sql`SELECT h.linked_ac_docno AS ac_no, i.item_code, i.qty::float8 AS qty,
        i.unit_price_sen, i.linked_ac_dtlkey::text AS ac_dtlkey, i.line_suffix,
        COALESCE(i.line_no,0) AS line_no, i.item_group, i.variants::text AS variants,
        i.custom_specials::text AS custom_specials, i.description2,
        i.so_item_id::text AS so_item_id, so.doc_no AS so_doc_no, soh.linked_ac_docno AS so_ac_no
      FROM scm.delivery_order_items i
      JOIN scm.delivery_orders h ON h.id = i.delivery_order_id
      LEFT JOIN scm.mfg_sales_order_items so ON so.id = i.so_item_id
      LEFT JOIN scm.mfg_sales_orders soh ON soh.doc_no = so.doc_no AND soh.company_id = ${CO}
      WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`,
  },
  IV: {
    docs: () => sql`SELECT h.invoice_number AS erp_no, h.linked_ac_docno AS ac_no,
        COALESCE(h.total_sen, h.local_total_sen) AS total_sen, h.status::text AS status, h.created_at
      FROM scm.sales_invoices h WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`,
    lines: () => sql`SELECT h.linked_ac_docno AS ac_no, i.item_code, i.qty::float8 AS qty,
        i.unit_price_sen, i.linked_ac_dtlkey::text AS ac_dtlkey, i.line_suffix,
        COALESCE(i.line_no,0) AS line_no, i.item_group, i.variants::text AS variants,
        i.custom_specials::text AS custom_specials, i.description2,
        i.do_item_id::text AS do_item_id, i.so_item_id::text AS so_item_id,
        dh.linked_ac_docno AS do_ac_no, soh.linked_ac_docno AS so_ac_no
      FROM scm.sales_invoice_items i
      JOIN scm.sales_invoices h ON h.id = i.sales_invoice_id
      LEFT JOIN scm.delivery_order_items di ON di.id = i.do_item_id
      LEFT JOIN scm.delivery_orders dh ON dh.id = di.delivery_order_id AND dh.company_id = ${CO}
      LEFT JOIN scm.mfg_sales_order_items si ON si.id = i.so_item_id
      LEFT JOIN scm.mfg_sales_orders soh ON soh.doc_no = si.doc_no AND soh.company_id = ${CO}
      WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`,
  },
  PI: {
    docs: () => sql`SELECT h.invoice_number AS erp_no, h.linked_ac_docno AS ac_no,
        h.total_sen, h.status::text AS status, h.currency::text AS currency, h.created_at
      FROM scm.purchase_invoices h WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`,
    lines: () => sql`SELECT h.linked_ac_docno AS ac_no, i.item_code, i.qty::float8 AS qty,
        i.unit_price_sen, i.linked_ac_dtlkey::text AS ac_dtlkey, i.line_suffix,
        i.item_group, i.variants::text AS variants,
        i.custom_specials::text AS custom_specials, i.description2,
        i.grn_item_id::text AS grn_item_id, g.linked_ac_gr_docno AS gr_ac_no,
        p.linked_ac_docno AS po_ac_no
      FROM scm.purchase_invoice_items i
      JOIN scm.purchase_invoices h ON h.id = i.purchase_invoice_id
      LEFT JOIN scm.grn_items gi ON gi.id = i.grn_item_id
      LEFT JOIN scm.grns g ON g.id = gi.grn_id AND g.company_id = ${CO}
      LEFT JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
      WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`,
  },
};

const j = (v) => (v == null ? "-" : String(v));
const money = (sen) => (sen == null ? "-" : (Number(sen) / 100).toFixed(2));

try {
  /* ── the purchase-invoice chain, in aggregate: can the missing link even be
     made? A receipt the ERP does not hold, or holds without an AutoCount
     receipt number, cannot be pointed at — and stamping that number is the
     GOODS-RECEIPT lane's table, not this one. */
  const grnStock = await sql`SELECT count(*)::int AS grns,
      count(*) FILTER (WHERE linked_ac_gr_docno IS NOT NULL)::int AS with_gr_no,
      count(*) FILTER (WHERE linked_ac_gr_docno IS NULL)::int AS without_gr_no
    FROM scm.grns WHERE company_id = ${CO} AND status <> 'CANCELLED'`;
  console.log("\n=== GRN population (the receipts a purchase invoice could point at) ===");
  console.log(JSON.stringify(grnStock[0]));

  const piLink = await sql`SELECT
      count(*)::int AS lines,
      count(*) FILTER (WHERE i.grn_item_id IS NULL)::int AS no_grn_item,
      count(*) FILTER (WHERE i.grn_item_id IS NOT NULL)::int AS has_grn_item,
      count(*) FILTER (WHERE i.grn_item_id IS NOT NULL AND g.linked_ac_gr_docno IS NULL)::int AS grn_unstamped,
      count(*) FILTER (WHERE i.linked_ac_dtlkey IS NULL)::int AS no_line_key
    FROM scm.purchase_invoice_items i
    JOIN scm.purchase_invoices h ON h.id = i.purchase_invoice_id
    LEFT JOIN scm.grn_items gi ON gi.id = i.grn_item_id
    LEFT JOIN scm.grns g ON g.id = gi.grn_id AND g.company_id = ${CO}
    WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`;
  console.log("\n=== purchase-invoice line links ===");
  console.log(JSON.stringify(piLink[0]));

  for (const type of ["DO", "IV", "PI"]) {
    const b = bookSide(type);
    const cfg = ERP[type];
    const docs = await cfg.docs();
    const lines = await cfg.lines();
    const erpDocs = new Map(docs.map((d) => [String(d.ac_no).trim(), d]));
    const erpLines = new Map();
    for (const l of lines) {
      const k = String(l.ac_no).trim();
      if (!erpLines.has(k)) erpLines.set(k, []);
      erpLines.get(k).push(l);
    }

    let want = OFFENDERS[type];
    if (type === "PI") want = [...erpDocs.keys()].sort();
    if (process.env.DOCS && process.env.DOCS !== "ALL") {
      const only = new Set(process.env.DOCS.split(",").map((s) => s.trim()));
      want = want.filter((d) => only.has(d));
    }

    console.log(`\n\n████████ ${type} — ${want.length} document(s) dumped ████████`);
    for (const docNo of want) {
      const bh = b.headers.get(docNo);
      const bl = b.lines.get(docNo) || [];
      const eh = erpDocs.get(docNo);
      const el = erpLines.get(docNo) || [];
      console.log(`\n──── ${type} ${docNo} ────`);
      console.log(`  BOOK header: ${bh ? `total=${bh.docTotal} net=${bh.netTotal} lines=${bh.lineCount} cur=${bh.currency} rate=${bh.rate} cancelled=${bh.cancelled} date=${bh.docDate}` : "NOT IN BOOK"}`);
      console.log(`  ERP  header: ${eh ? `${eh.erp_no} total=${money(eh.total_sen)} status=${eh.status} cur=${j(eh.currency)} created=${eh.created_at}` : "NOT IN ERP"}`);
      console.log(`  BOOK lines (${bl.length}):`);
      for (const l of bl) {
        const d2 = b.desc2.get(String(l.dtlKey));
        console.log(`    seq=${l.seq} dtl=${l.dtlKey} item=${JSON.stringify(l.itemKey)} hasCode=${l.hasCode} qty=${l.qty} up=${l.unitPrice} sub=${l.subTotal} from=${j(l.fromDocType)}/${j(l.fromDocNo)} txQty=${j(l.transferedQty)}${d2 ? `\n        d2: ${d2}` : ""}`);
      }
      console.log(`  ERP lines (${el.length}):`);
      for (const l of el) {
        console.log(`    key=${j(l.ac_dtlkey)} suffix=${j(l.line_suffix)} item=${JSON.stringify(l.item_code)} qty=${l.qty} up=${money(l.unit_price_sen)} group=${j(l.item_group)} parent=${j(l.do_ac_no ?? l.so_ac_no ?? l.gr_ac_no ?? l.po_ac_no)}${l.grn_item_id !== undefined ? ` grnItem=${j(l.grn_item_id)}` : ""}${l.so_item_id !== undefined ? ` soItem=${j(l.so_item_id)}` : ""}
        variants=${j(l.variants)}
        specials=${j(l.custom_specials)}  d2=${j(l.description2)}`);
      }
    }
  }
} catch (e) {
  console.error(`REFUSED: ${e.message}`);
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(2);
}
await sql.end({ timeout: 5 });
