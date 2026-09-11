#!/usr/bin/env node
/* check-so-po-counter-causes — the 35 sales orders on 单据转换链, SPLIT BY CAUSE.
 *
 * 「我要知道是SO 几时可以好」 (the owner, 2026-09-08). The sales-order verdict of
 * run 34254777347 carried 35 documents on the `transfer to` axis — every one of
 * them PROCEEDED — with no cause split at all. A sweep over a cause-mixed set
 * overwrites the rows that were already right, so this answers WHY first.
 *
 * ── WHAT IT COMPARES, AND WHAT IT DELIBERATELY DOES NOT ────────────────────
 * The axis is ONE counter: `SODTL.TransferedPOQty` — how much of a sales-order
 * line the book turned into a purchase order — against
 * `scm.mfg_sales_order_items.po_qty_picked`. WHETHER two numbers disagree is
 * decided by lib/transfer-counter-verdict.mjs, the same function
 * check-ac-transfer-counters.mjs calls; this file must never be a second
 * opinion about that, and it is not. WHY they disagree is decided by
 * lib/so-po-counter-cause.mjs, which is pure and self-tested.
 *
 * It touches no stock. `po_qty_picked` is the ceiling on the From-SO purchase
 * picker and an MRP input; it is not an on-hand figure, and this script writes
 * nothing at all. 「库存先不看」 is respected by construction.
 *
 * ── WHY THE BOOK SIDE IS TWO SNAPSHOTS ─────────────────────────────────────
 * data/ac-reconcile-truth.json.gz carries no `transferedPoQty` and no
 * `fromSoDtlKey` for purchase orders. Both live in data/ac-convert-edges.json.gz,
 * pulled by export-ac-convert-edges.mjs for exactly this question. The age is
 * CHECKED and a stale cut REFUSES rather than answering against an old book.
 *
 * ── READ-ONLY ──────────────────────────────────────────────────────────────
 * SELECTs only. One connection. No DDL, no writes, no transaction, no MODE=apply.
 * Exit 0 for every legitimate answer — the answer IS the output and a red job
 * reads as "the check broke". Non-zero only when it cannot be TRUSTED: an
 * unreachable database, a missing or stale snapshot, a failed self-test, or a
 * column that has moved.
 *
 * Env: DATABASE_URL (required)  COMPANY_ID (default 1)
 *      MAX_SNAPSHOT_AGE_DAYS (default 2)   SHOW (default 60)
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { verdictFor } from "./lib/transfer-counter-verdict.mjs";
import {
  GROUP_CAUSES, IS_BY_DESIGN, IS_LINK_GAP, IS_NOT_OUR_DEFECT,
  causeForGroup, runSelfTest,
} from "./lib/so-po-counter-cause.mjs";
import { soProcessingDateFragment } from "./lib/so-processing-date.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SNAP = path.join(here, "data", "ac-convert-edges.json.gz");
const CO = Number(process.env.COMPANY_ID || 1);
const MAX_AGE_DAYS = Number(process.env.MAX_SNAPSHOT_AGE_DAYS || 2);
const SHOW = Number(process.env.SHOW || 60);

const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const out = (m = "") => console.log(m);
const head = (m) => { out(""); out("=".repeat(78)); out(m); out("=".repeat(78)); };

/* decimal(19,4) on the book side, numeric on ours. Scaled integers, because a
   checker that reports 1e-15 as a disagreement is worse than no checker. */
const Q = (v) => Math.round(Number(v || 0) * 10000);
const fmtQ = (n) => (n / 10000).toString();
/* Compared trimmed and case-folded, because the two systems have disagreed
   about both and neither difference is a different product. */
const itemCode = (v) => String(v ?? "").trim().toUpperCase();

/** How each cause reads to somebody who is not an engineer, and whose it is. */
const CAUSE_LABEL = Object.freeze({
  counter_stale:
    "WORK — the ERP holds the purchase order, holds the line, and the line points at this sales-order " +
    "line. The app's own rule would count it; the stored number simply lags. recompute-so-po-qty-picked.mjs " +
    "is the repair and it writes no stock",
  po_doc_absent:
    "WORK — the book raised a purchase order for this line and the ERP holds no such purchase order at all",
  po_line_absent:
    "WORK — the ERP holds that purchase order and not the line the book raised from this sales-order line",
  link_missing:
    "WORK — the purchase-order line is here and points at NO sales-order line. The LINK is missing, so no " +
    "recompute can help: backfill-po-so-item-links.mjs is the repair",
  link_elsewhere:
    "WORK — the purchase-order line points at a DIFFERENT sales-order line than the book says",
  po_not_committed:
    "DECISION — the purchase order is DRAFT or CANCELLED, and the app's own rule drops both on purpose so " +
    "an uncommitted order does not close the From-SO picker",
  from_mrp:
    "DECISION — the purchase-order line is MRP-origin, reference-only by the 2026-05-31 decision, and the " +
    "app's own counter rule drops it on purpose",
  book_names_no_child:
    "THE BOOK'S OWN GAP — the book's counter says a purchase was made and its own purchase-order table names " +
    "no line that made it",
  decomposed_grain:
    "NOT A DEFECT — one book line is one ERP row PER COMPARTMENT, and we recorded EXACTLY the quantity the book " +
    "moved. The fraction differs only because our denominator is the compartment count. Copying the book's " +
    "number would not make it agree; linking every compartment would, and where the two builds disagree that " +
    "is the owner's drawing, not a script",
  book_source_is_another_product:
    "THE BOOK'S OWN GAP — the book's own transfer edge names a source sales line for a DIFFERENT product, while " +
    "the same order carries a line whose code matches exactly. Copying it would put one product's purchase on " +
    "another product's line, which is what docs/bugs/0671 cost. Only the owner can settle which line it was",
  mixed:
    "WORK, and MIXED — two or more different causes on one sales-order line. Never repaired as one of them",
});

async function main() {
  /* A classifier that cannot classify must not go on reporting confidently. */
  const st = runSelfTest();
  if (st.length) {
    console.error("REFUSED: the cause classifier failed its own self-test:");
    for (const f of st) console.error(`  ${f}`);
    process.exit(2);
  }
  log("self-test: every planted cause landed on its own bucket, the mixed group stayed mixed, and the three " +
    "cause classes partition. Proceeding.");

  if (!fs.existsSync(SNAP)) {
    console.error(`REFUSED: ${SNAP} is not there. Refresh it with export-ac-convert-edges.mjs on a machine ` +
      "that can reach the office network.");
    process.exit(2);
  }
  const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(SNAP)).toString("utf8"));
  const ageDays = (Date.now() - new Date(snap.exported_at).getTime()) / 86400000;
  out(`AutoCount snapshot exported_at=${snap.exported_at} (${ageDays.toFixed(2)} days old)  source=${snap.source}`);
  if (ageDays > MAX_AGE_DAYS) {
    console.error(`REFUSED: the snapshot is ${ageDays.toFixed(1)} days old (limit ${MAX_AGE_DAYS}). Answering ` +
      "this against a stale book is worse than not answering it.");
    process.exit(2);
  }

  const L = Object.fromEntries(snap.line_fields.map((n, i) => [n, i]));
  const H = Object.fromEntries(snap.header_fields.map((n, i) => [n, i]));
  for (const f of ["dtlKey", "docNo", "qty", "transferedPoQty", "fromSoDtlKey"]) {
    if (L[f] === undefined) {
      console.error(`REFUSED: the chain snapshot carries no \`${f}\` column, so this question cannot be asked of it.`);
      process.exit(2);
    }
  }

  /* THE BOOK. Sales-order lines by DtlKey, and the purchase-order lines that
     name each of them — the ONE edge AutoCount records at line grain. */
  const soCancelled = new Set();
  for (const r of snap.types.SO.headers || []) if (r[H.cancelled] === "T") soCancelled.add(r[H.docNo]);
  const soLine = new Map();
  const soCodesByDoc = new Map();
  for (const r of snap.types.SO.lines || []) {
    const code = itemCode(r[L.itemKey]);
    soLine.set(String(r[L.dtlKey]), {
      docNo: r[L.docNo],
      itemCode: code,
      qty: Q(r[L.qty]),
      transferedPoQty: r[L.transferedPoQty] === "" ? null : Q(r[L.transferedPoQty]),
    });
    if (!soCodesByDoc.has(r[L.docNo])) soCodesByDoc.set(r[L.docNo], new Set());
    if (code) soCodesByDoc.get(r[L.docNo]).add(code);
  }
  const poCancelled = new Set();
  for (const r of snap.types.PO.headers || []) if (r[H.cancelled] === "T") poCancelled.add(r[H.docNo]);
  const poChildrenOf = new Map();
  for (const r of snap.types.PO.lines || []) {
    const src = String(r[L.fromSoDtlKey] || "").trim();
    if (!src) continue;
    if (!poChildrenOf.has(src)) poChildrenOf.set(src, []);
    poChildrenOf.get(src).push({
      poDocNo: r[L.docNo], poDtlKey: String(r[L.dtlKey]), qty: Q(r[L.qty]), itemCode: itemCode(r[L.itemKey]),
    });
  }
  out(`book: ${soLine.size} sales-order line(s); ${poChildrenOf.size} of them are named by a purchase-order line`);

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("REFUSED: DATABASE_URL is not set. This reads the ERP; there is no offline mode.");
    process.exit(2);
  }
  const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });
  const PDATE = soProcessingDateFragment(sql);

  try {
    /* The columns, from information_schema and not from hope: a join against a
       column that is not there matches nothing and reads as a clean run. */
    const want = {
      mfg_sales_order_items: ["company_id", "linked_ac_dtlkey", "po_qty_picked", "qty", "doc_no"],
      mfg_sales_orders: ["company_id", "doc_no", "status", "processing_date"],
      purchase_order_items: ["company_id", "linked_ac_dtlkey", "so_item_id", "from_mrp", "purchase_order_id"],
      purchase_orders: ["company_id", "linked_ac_docno", "status"],
    };
    const cols = await sql`
      SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'scm' AND table_name = ANY(${Object.keys(want)})`;
    const have = new Map();
    for (const r of cols) {
      if (!have.has(r.table_name)) have.set(r.table_name, new Set());
      have.get(r.table_name).add(r.column_name);
    }
    const missing = [];
    for (const [t, cs] of Object.entries(want)) for (const c of cs) if (!have.get(t)?.has(c)) missing.push(`scm.${t}.${c}`);
    if (missing.length) {
      console.error(`REFUSED: scm no longer carries ${missing.join(", ")}. The chain this question is defined ` +
        "on has moved; a join against a column that is not there would report a clean run.");
      await sql.end({ timeout: 5 });
      process.exit(2);
    }

    /* ── THE ERP, THREE READS ─────────────────────────────────────────────── */
    const soGroups = await sql`
      SELECT s.linked_ac_dtlkey::text AS k, count(*)::int AS rows,
             sum(s.qty)::numeric AS erp_qty, sum(s.po_qty_picked)::numeric AS erp_counter,
             min(s.doc_no) AS erp_doc, min(s.item_code) AS item_code,
             bool_or(o.${PDATE} IS NOT NULL) AS proceeded
        FROM scm.mfg_sales_order_items s
        JOIN scm.mfg_sales_orders o ON o.doc_no = s.doc_no AND o.company_id = ${CO}
       WHERE s.company_id = ${CO} AND s.linked_ac_dtlkey IS NOT NULL AND o.status <> 'CANCELLED'
       GROUP BY s.linked_ac_dtlkey`;

    const poLines = await sql`
      SELECT i.linked_ac_dtlkey::text AS k, h.linked_ac_docno AS ac_po, h.status AS po_status,
             i.from_mrp AS from_mrp, si.linked_ac_dtlkey::text AS so_line_key
        FROM scm.purchase_order_items i
        JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
        LEFT JOIN scm.mfg_sales_order_items si ON si.id = i.so_item_id
       WHERE h.company_id = ${CO} AND i.linked_ac_dtlkey IS NOT NULL`;

    const poDocs = await sql`
      SELECT DISTINCT linked_ac_docno AS ac_po FROM scm.purchase_orders
       WHERE company_id = ${CO} AND linked_ac_docno IS NOT NULL`;

    const erpPoLine = new Map();
    for (const r of poLines) erpPoLine.set(String(r.k), r);
    const erpPoDoc = new Set(poDocs.map((r) => String(r.ac_po).trim().toUpperCase()));
    out(`ERP: ${soGroups.length} keyed sales-order line group(s); ${erpPoLine.size} keyed purchase-order line(s) ` +
      `across ${erpPoDoc.size} purchase order(s)`);

    /* ── THE DISAGREEING GROUPS, AND ONLY THOSE ───────────────────────────── */
    head("1.  WHICH SALES-ORDER LINES DISAGREE WITH THE BOOK'S PURCHASE COUNTER");
    out("    WHETHER is lib/transfer-counter-verdict.mjs's answer — the same function the counter check calls.");
    out("    One book line can be several ERP rows (a sofa is one DtlKey and six compartments), so the");
    out("    comparison is the FRACTION transferred, cross-multiplied. This file only asks WHY.");

    let keyNotInBook = 0; let counterNull = 0; let cancelled = 0; let agree = 0;
    const offenders = [];
    for (const r of soGroups) {
      const bl = soLine.get(String(r.k));
      if (!bl) { keyNotInBook += 1; continue; }
      if (soCancelled.has(bl.docNo)) { cancelled += 1; continue; }
      if (bl.transferedPoQty == null) { counterNull += 1; continue; }
      const g = {
        bookQty: bl.qty, bookTransfered: bl.transferedPoQty,
        erpQty: Q(r.erp_qty), erpCounter: Q(r.erp_counter), rows: r.rows,
      };
      const v = verdictFor(g);
      if (!["erp_low", "erp_high", "erp_asserts_untransferred"].includes(v)) { agree += 1; continue; }
      offenders.push({ ...r, book: bl, g, verdict: v });
    }
    out("");
    out(`    ${soGroups.length} keyed sales-order line group(s): ${keyNotInBook} name a key the book does not have, ` +
      `${cancelled} sit on a cancelled book document, ${counterNull} the book leaves the counter NULL`);
    out(`    COMPARED ${agree + offenders.length}: ${agree} agree, ${offenders.length} disagree`);

    /* ── THE CAUSE SPLIT ──────────────────────────────────────────────────── */
    head("2.  WHY EACH ONE DISAGREES — the split, and whose each bucket is");
    out("    A cause-mixed sweep overwrites the rows that were already right. Nothing below is repaired here.");

    const byCause = new Map(GROUP_CAUSES.map((c) => [c, []]));
    for (const o of offenders) {
      const kids = (poChildrenOf.get(String(o.k)) || [])
        /* A cancelled purchase order in the BOOK bought nothing, so it owes this
           counter nothing either. Dropped before classifying, never counted as
           a cause of ours. */
        .filter((kid) => !poCancelled.has(kid.poDocNo))
        .map((kid) => {
          const line = erpPoLine.get(kid.poDtlKey);
          /* DOES THE BOOK'S OWN EDGE NAME A LINE FOR ANOTHER PRODUCT? Narrow on
             purpose: only when the named sales line's code differs AND the same
             sales order carries a line whose code matches the purchase line
             EXACTLY. A book purchase code that simply reads differently from the
             sales code is routine and is NOT this. */
          const named = o.book?.itemCode ?? "";
          const onDoc = soCodesByDoc.get(o.book?.docNo) ?? new Set();
          const bookSourceProductDiffers =
            Boolean(kid.itemCode) && Boolean(named) && kid.itemCode !== named && onDoc.has(kid.itemCode);
          return {
            poDocNo: kid.poDocNo,
            poDtlKey: kid.poDtlKey,
            poItemCode: kid.itemCode,
            bookSourceProductDiffers,
            erpHasPoDoc: erpPoDoc.has(String(kid.poDocNo).trim().toUpperCase()),
            erpHasPoLine: Boolean(line),
            erpPoStatus: line?.po_status ?? null,
            erpFromMrp: line?.from_mrp === true,
            erpSoLineKey: line?.so_line_key ?? null,
            bookSoLineKey: String(o.k),
          };
        });
      const c = causeForGroup(kids, o.g);
      byCause.get(c.cause).push({ ...o, kids, childCauses: c.children });
    }

    out("");
    out("    cause                       lines  PROCEEDED  what it is");
    for (const cause of GROUP_CAUSES) {
      const rows = byCause.get(cause);
      if (!rows.length) continue;
      const proc = rows.filter((r) => r.proceeded).length;
      out(`    ${cause.padEnd(24)}${String(rows.length).padStart(7)}${String(proc).padStart(11)}  ${CAUSE_LABEL[cause]}`);
    }

    const sum = (pred) => GROUP_CAUSES.filter(pred).reduce((a, c) => a + byCause.get(c).length, 0);
    const design = sum((c) => IS_BY_DESIGN.has(c));
    const notOurs = sum((c) => IS_NOT_OUR_DEFECT.has(c));
    const work = sum((c) => !IS_BY_DESIGN.has(c) && !IS_NOT_OUR_DEFECT.has(c));
    const links = sum((c) => IS_LINK_GAP.has(c));
    out("");
    out(`    WORK ${work} line(s) — of which ${links} are a LINK to repair and ${work - links} are a stored number to recompute`);
    out(`    DECISION ${design} line(s) — the app's own rule dropping a purchase-order line on purpose. NEVER summed into WORK.`);
    out(`    NOT OUR DEFECT ${notOurs} line(s) — the account book's own gap, or a grain our decomposition cannot express. NEVER summed into WORK.`);

    /* ── NAMED, PER DOCUMENT ──────────────────────────────────────────────── */
    head("3.  EVERY DISAGREEING LINE, NAMED, BY CAUSE");
    out("    A number nobody can act on is not an answer. Documents are the ERP's, keys are AutoCount's.");
    for (const cause of GROUP_CAUSES) {
      const rows = byCause.get(cause);
      if (!rows.length) continue;
      const docs = [...new Set(rows.map((r) => r.erp_doc))];
      out("");
      out(`    --- ${cause}  ${rows.length} line(s) across ${docs.length} document(s)`);
      out(`        ${CAUSE_LABEL[cause]}`);
      for (const r of rows.slice(0, SHOW)) {
        out(`        ${r.erp_doc}  ${String(r.item_code || "").padEnd(24)}` +
          `book ${fmtQ(r.g.bookTransfered)} of ${fmtQ(r.g.bookQty)}  |  ` +
          `ERP ${fmtQ(r.g.erpCounter)} of ${fmtQ(r.g.erpQty)} over ${r.g.rows} row(s)` +
          `  [key ${r.k}]${r.proceeded ? " PROCEEDED" : ""}`);
        for (const [i, kid] of r.kids.entries()) {
          out(`            book child ${kid.poDocNo} line ${kid.poDtlKey} -> ${r.childCauses[i]}` +
            ` (ERP doc ${kid.erpHasPoDoc ? "held" : "ABSENT"}, line ${kid.erpHasPoLine ? "held" : "ABSENT"}` +
            `, status ${kid.erpPoStatus ?? "-"}, from_mrp ${kid.erpFromMrp}, points at ${kid.erpSoLineKey ?? "nothing"})`);
        }
      }
      if (rows.length > SHOW) out(`        ... and ${rows.length - SHOW} more`);
    }

    out("");
    log(offenders.length === 0
      ? "SO -> PO COUNTER — every keyed sales-order line agrees with the account book."
      : `SO -> PO COUNTER — ${offenders.length} line(s) disagree: ${work} are work (${links} a link, ` +
        `${work - links} a stored number), ${design} are the app's own rule working as designed, and ` +
        `${notOurs} are the book's own gap or a grain our decomposition cannot express.`);
    out("NOTHING IS REPAIRED HERE. `po_qty_picked` is a purchasing ceiling and an MRP input, not an on-hand " +
      "figure — but no repair is planned by this file, and 「库存先不看」 is respected by construction.");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
