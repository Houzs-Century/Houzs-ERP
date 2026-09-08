#!/usr/bin/env node
/* check-ac-transfer-counters — the ERP's stored TRANSFER TO counters, against
 * AutoCount's own, line by line.
 *
 * The owner, 2026-09-08:  「还有 transfer from and out」
 * and earlier:  「Transfer From 跟 Transfer To 全部都 check 完了」
 *
 * WHY THIS EXISTS BESIDE check-ac-convert-symmetry, WHICH ALREADY COVERS A LOT.
 * That checker asks the transfer-TO question twice and never once ACROSS the
 * two systems:
 *
 *   section 3   the book's counter vs the book's OWN children
 *   section 4b  the ERP's counter vs the ERP's OWN children
 *
 * Both can read clean while the ERP's counter says a different thing from the
 * book's counter for the same line — which is the question the owner asked. Its
 * own run 34198847720 shows that is not hypothetical: 140 of 1344 ERP
 * purchase-order lines disagree with their own goods receipts and 80 of 792
 * goods-receipt lines disagree with their own purchase invoices, and section 4b
 * cannot say whether either is a defect, because the receipt that moved the
 * counter happened in AutoCount and the ERP deliberately holds no document for
 * it. Only the BOOK can decide that, and nothing was asking it.
 *
 * THE THREE COUNTERS. The ERP stores exactly three, and they gate the three
 * converts that have a ceiling:
 *
 *   mfg_sales_order_items.po_qty_picked  vs  SODTL.TransferedPOQty   (SO -> PO)
 *   purchase_order_items.received_qty    vs  PODTL.TransferedQty     (PO -> GR)
 *   grn_items.invoiced_qty               vs  GRDTL.TransferedQty     (GR -> PI)
 *
 * SO -> DO and DO -> IV have NO stored ERP counter: delivery is computed live
 * off delivery_order_items. Section 4 says so out loud rather than leaving a
 * silence a reader would take for a clean measurement.
 *
 * DECOMPOSITION. One book line can be several ERP rows — a sofa is one DtlKey
 * and six compartments (mig 0273/0280). Comparing a summed counter to the
 * book's single number reports that decomposition as a defect, so the
 * comparison is the FRACTION transferred, cross-multiplied so it cannot round.
 * lib/transfer-counter-verdict.mjs holds it and the self-test drives that same
 * function, never a copy of it.
 *
 * THE TRAP THIS FILE REFUSES TO REPEAT. A goods-receipt query in the reconcile
 * once selected `NULL::bigint AS ac_dtlkey` — a CONSTANT, not the column — and
 * went on pairing by position while reporting confidently. Section 1 PROVES
 * every column it is about to read is present AND carries varied data, and
 * REFUSES on a key column that turns out to be single-valued.
 *
 * Read-only. SELECTs only, no writes, no DDL, no transaction. Exit 0 for every
 * legitimate answer — the answer is the output; non-zero only when the check
 * cannot be TRUSTED (unreachable DB, missing or stale snapshot, failed
 * self-test, a column that has moved).
 *
 * Env: DATABASE_URL (required)  COMPANY_ID (default 1)
 *      MAX_SNAPSHOT_AGE_DAYS (default 2)   SHOW (default 20)
 *      DOCS  comma-separated AutoCount document numbers to print in full
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { verdictFor, isOneToOne, VERDICTS, runSelfTest } from "./lib/transfer-counter-verdict.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SNAP = path.join(here, "data", "ac-convert-edges.json.gz");
const CO = Number(process.env.COMPANY_ID || 1);
const MAX_AGE_DAYS = Number(process.env.MAX_SNAPSHOT_AGE_DAYS || 2);
const SHOW = Number(process.env.SHOW || 20);
const DOCS = (process.env.DOCS || "").split(",").map((s) => s.trim()).filter(Boolean);

const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const out = (m = "") => console.log(m);
const head = (m) => {
  out("");
  out("=".repeat(78));
  out(m);
  out("=".repeat(78));
};

/* decimal(19,4) on the book side, numeric on ours. Compare as scaled integers:
   a checker that reports 1e-15 as a disagreement is worse than no checker. */
const Q = (v) => Math.round(Number(v || 0) * 10000);
const fmtQ = (n) => (n / 10000).toString();

/* ══ self-test first: a checker that cannot classify must REFUSE ══════════ */
const stFail = runSelfTest();
if (stFail.length) {
  console.error("REFUSED: the verdict classifier failed its own self-test:");
  for (const f of stFail) console.error(`  ${f}`);
  process.exit(2);
}
log("self-test: every planted transfer-counter case landed on its own verdict, and the decomposed "
  + "partial that agrees exactly stayed silent. Proceeding.");

/* ══ the book ═════════════════════════════════════════════════════════════ */
if (!fs.existsSync(SNAP)) {
  console.error(`REFUSED: ${SNAP} is not there. Refresh it with export-ac-convert-edges.mjs on a `
    + "machine that can reach the office network.");
  process.exit(2);
}
const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(SNAP)).toString("utf8"));
const ageDays = (Date.now() - new Date(snap.exported_at).getTime()) / 86400000;
out(`AutoCount snapshot exported_at=${snap.exported_at} (${ageDays.toFixed(2)} days old)`);
out(`source=${snap.source}`);
if (ageDays > MAX_AGE_DAYS) {
  console.error(`REFUSED: the snapshot is ${ageDays.toFixed(1)} days old (limit ${MAX_AGE_DAYS}). `
    + "Answering the counter question against a stale book is worse than not answering it.");
  process.exit(2);
}

const L = Object.fromEntries(snap.line_fields.map((n, i) => [n, i]));
const H = Object.fromEntries(snap.header_fields.map((n, i) => [n, i]));
const bookLine = {};
const bookHdr = {};
for (const [t, payload] of Object.entries(snap.types)) {
  const hdr = new Map();
  for (const r of payload.headers) {
    hdr.set(r[H.docNo], { docNo: r[H.docNo], docDate: r[H.docDate], cancelled: r[H.cancelled] === "T" });
  }
  const byKey = new Map();
  for (const r of payload.lines) {
    byKey.set(String(r[L.dtlKey]), {
      docNo: r[L.docNo], dtlKey: String(r[L.dtlKey]), itemKey: r[L.itemKey],
      qty: Q(r[L.qty]),
      transferedQty: r[L.transferedQty] === "" ? null : Q(r[L.transferedQty]),
      transferedPoQty: r[L.transferedPoQty] === "" ? null : Q(r[L.transferedPoQty]),
      fromDocType: r[L.fromDocType], fromDocNo: r[L.fromDocNo], fromSoDtlKey: r[L.fromSoDtlKey],
    });
  }
  bookLine[t] = byKey;
  bookHdr[t] = hdr;
}
out(`book lines by DtlKey: ${Object.entries(bookLine).map(([t, m]) => `${t} ${m.size}`).join(" | ")}`);

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("REFUSED: DATABASE_URL is not set. This check reads the ERP; there is no offline mode.");
  process.exit(2);
}
const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

/* Written out per axis rather than composed from an identifier the driver would
   have to quote. A dynamic table name is one typo away from a query that
   matches nothing and reads as a clean run, which is the failure this whole
   file exists to avoid. */
const AXES = [
  {
    id: "SO -> PO",
    label: "sales-order line, how much of it was purchased",
    erp: "scm.mfg_sales_order_items.po_qty_picked",
    bookField: "SODTL.TransferedPOQty",
    bookType: "SO",
    bookCounter: "transferedPoQty",
    consequence: "the ceiling on the From-SO purchase picker. Reading LOW lets a SECOND purchase order "
      + "be raised for goods already on the way.",
    groups: () => pg`
      SELECT linked_ac_dtlkey::text AS k, count(*)::int AS rows,
             sum(qty)::numeric AS erp_qty, sum(po_qty_picked)::numeric AS erp_counter,
             min(item_code) AS item_code, min(doc_no) AS erp_doc
        FROM scm.mfg_sales_order_items
       WHERE company_id = ${CO} AND linked_ac_dtlkey IS NOT NULL
       GROUP BY linked_ac_dtlkey`,
    unkeyed: () => pg`
      SELECT count(*)::int AS n FROM scm.mfg_sales_order_items
       WHERE company_id = ${CO} AND linked_ac_dtlkey IS NULL`,
    shape: () => pg`
      SELECT count(*)::int AS rows, count(linked_ac_dtlkey)::int AS keyed,
             count(DISTINCT linked_ac_dtlkey)::int AS distinct_keys,
             count(DISTINCT po_qty_picked)::int AS distinct_counter,
             min(po_qty_picked)::numeric AS min_counter, max(po_qty_picked)::numeric AS max_counter
        FROM scm.mfg_sales_order_items WHERE company_id = ${CO}`,
  },
  {
    id: "PO -> GR",
    label: "purchase-order line, how much of it was received",
    erp: "scm.purchase_order_items.received_qty",
    bookField: "PODTL.TransferedQty",
    bookType: "PO",
    bookCounter: "transferedQty",
    consequence: "the ceiling on the goods-receipt convert, AND the only thing a hard-bound sales line "
      + "reads to go READY (isHardBoundLine, src/scm/lib/so-stock-allocation.ts).",
    groups: () => pg`
      SELECT linked_ac_dtlkey::text AS k, count(*)::int AS rows,
             sum(qty)::numeric AS erp_qty, sum(received_qty)::numeric AS erp_counter,
             min(item_code) AS item_code, min(purchase_order_id)::text AS erp_doc
        FROM scm.purchase_order_items
       WHERE company_id = ${CO} AND linked_ac_dtlkey IS NOT NULL
       GROUP BY linked_ac_dtlkey`,
    unkeyed: () => pg`
      SELECT count(*)::int AS n FROM scm.purchase_order_items
       WHERE company_id = ${CO} AND linked_ac_dtlkey IS NULL`,
    shape: () => pg`
      SELECT count(*)::int AS rows, count(linked_ac_dtlkey)::int AS keyed,
             count(DISTINCT linked_ac_dtlkey)::int AS distinct_keys,
             count(DISTINCT received_qty)::int AS distinct_counter,
             min(received_qty)::numeric AS min_counter, max(received_qty)::numeric AS max_counter
        FROM scm.purchase_order_items WHERE company_id = ${CO}`,
  },
  {
    /* qty_accepted, not qty: invoiced_qty is clamped into [0, qty_accepted] by
       recomputeGrnInvoiced, so qty_accepted is the denominator the ERP itself
       measures this counter against. */
    id: "GR -> PI",
    label: "goods-receipt line, how much of it was invoiced",
    erp: "scm.grn_items.invoiced_qty",
    bookField: "GRDTL.TransferedQty",
    bookType: "GR",
    bookCounter: "transferedQty",
    consequence: "the ceiling on the purchase-invoice convert. Reading HIGH blocks a legitimate invoice.",
    groups: () => pg`
      SELECT linked_ac_dtlkey::text AS k, count(*)::int AS rows,
             sum(qty_accepted)::numeric AS erp_qty, sum(invoiced_qty)::numeric AS erp_counter,
             min(item_code) AS item_code, min(grn_id)::text AS erp_doc
        FROM scm.grn_items
       WHERE company_id = ${CO} AND linked_ac_dtlkey IS NOT NULL
       GROUP BY linked_ac_dtlkey`,
    unkeyed: () => pg`
      SELECT count(*)::int AS n FROM scm.grn_items
       WHERE company_id = ${CO} AND linked_ac_dtlkey IS NULL`,
    shape: () => pg`
      SELECT count(*)::int AS rows, count(linked_ac_dtlkey)::int AS keyed,
             count(DISTINCT linked_ac_dtlkey)::int AS distinct_keys,
             count(DISTINCT invoiced_qty)::int AS distinct_counter,
             min(invoiced_qty)::numeric AS min_counter, max(invoiced_qty)::numeric AS max_counter
        FROM scm.grn_items WHERE company_id = ${CO}`,
  },
];

try {
  /* ══ 1. PROVE THE COLUMNS ARE THERE, AND CARRY REAL DATA ════════════════ */
  head("1.  THE COLUMNS THIS CHECK READS - present, and carrying real data");
  out("    A column that was renamed makes every join match nothing and the check reports a clean run.");
  out("    A column that is a CONSTANT lets it go on comparing forever while reporting confidently - a");
  out("    goods-receipt query in the reconcile once selected NULL::bigint AS ac_dtlkey, a constant");
  out("    rather than the column, and did exactly that. Both are refused here.");
  out("");

  const wantCols = {
    mfg_sales_order_items: ["company_id", "qty", "po_qty_picked", "linked_ac_dtlkey", "item_code", "doc_no"],
    purchase_order_items: ["company_id", "qty", "received_qty", "linked_ac_dtlkey", "item_code", "purchase_order_id"],
    grn_items: ["company_id", "qty_accepted", "invoiced_qty", "linked_ac_dtlkey", "item_code", "grn_id"],
    delivery_order_items: ["company_id", "so_item_id", "linked_ac_dtlkey"],
    sales_invoice_items: ["company_id", "do_item_id", "linked_ac_dtlkey"],
  };
  const cols = await pg`
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'scm' AND table_name = ANY(${Object.keys(wantCols)})`;
  const idx = new Map();
  for (const r of cols) {
    if (!idx.has(r.table_name)) idx.set(r.table_name, new Set());
    idx.get(r.table_name).add(r.column_name);
  }
  const missing = [];
  for (const [t, cs] of Object.entries(wantCols)) for (const c of cs) if (!idx.get(t)?.has(c)) missing.push(`scm.${t}.${c}`);
  if (missing.length) {
    console.error(`REFUSED: scm no longer carries ${missing.join(", ")}. The counters this check is defined `
      + "on have moved; a join against a column that is not there matches nothing and would report a clean run.");
    await pg.end({ timeout: 5 });
    process.exit(2);
  }
  out(`    columns present: ${Object.values(wantCols).flat().length}/${Object.values(wantCols).flat().length} across ${Object.keys(wantCols).length} tables`);

  let constantFailure = null;
  for (const a of AXES) {
    const s = (await a.shape())[0];
    out(`    ${a.erp}`.padEnd(48)
      + ` ${String(s.rows).padStart(6)} rows | ${String(s.keyed).padStart(6)} keyed`
      + ` (${s.distinct_keys} distinct keys) | counter takes ${s.distinct_counter} distinct value(s),`
      + ` ${s.min_counter}..${s.max_counter}`);
    /* 100 is the smallest population where "every row happens to carry the same
       key" stops being a plausible accident and becomes a constant. */
    if (s.keyed > 100 && s.distinct_keys <= 1) {
      constantFailure = `scm.${a.erp.split(".")[1]}.linked_ac_dtlkey takes ${s.distinct_keys} distinct value(s) `
        + `over ${s.keyed} non-null rows - that is a constant, not a key column.`;
    }
    if (s.rows > 100 && s.distinct_counter <= 1) {
      out(`      NOTE: ${a.erp.split(".").pop()} takes ONE value (${s.min_counter}) on all ${s.rows} rows. That can be a `
        + "legitimate answer - nothing converted - so it is reported, not refused. Read the axis knowing it.");
    }
  }
  if (constantFailure) {
    console.error(`REFUSED: ${constantFailure}`);
    await pg.end({ timeout: 5 });
    process.exit(2);
  }

  /* ══ 2. THE COMPARISON, PER AXIS ═══════════════════════════════════════ */
  head("2.  EVERY STORED CEILING IN THE ERP, AGAINST AUTOCOUNT'S OWN COUNTER");
  out("    Matched by linked_ac_dtlkey. One book line can be several ERP rows (a sofa is one DtlKey and");
  out("    six compartments), so the comparison is the FRACTION transferred, cross-multiplied: the book");
  out("    moved t of q, we moved T of Q, and t*Q = T*q is the same fact in both systems whatever Q is.");

  const axisRows = [];
  const findings = { erp_low: [], erp_high: [], erp_asserts_untransferred: [] };

  for (const a of AXES) {
    const erpGroups = await a.groups();
    const unkeyed = (await a.unkeyed())[0].n;

    const groups = [];
    let keyNotInBook = 0; let cancelledSkipped = 0; let counterNull = 0;
    const notInBookEx = [];
    for (const r of erpGroups) {
      const bl = bookLine[a.bookType].get(String(r.k));
      if (!bl) {
        keyNotInBook++;
        if (notInBookEx.length < 5) notInBookEx.push(`${r.item_code} key ${r.k}`);
        continue;
      }
      if (bookHdr[a.bookType].get(bl.docNo)?.cancelled) { cancelledSkipped++; continue; }
      const bt = bl[a.bookCounter];
      if (bt == null) { counterNull++; continue; }
      groups.push({
        key: String(r.k), docNo: bl.docNo, itemKey: bl.itemKey, erpItem: r.item_code,
        rows: r.rows,
        bookQty: bl.qty, bookTransfered: bt,
        erpQty: Q(r.erp_qty), erpCounter: Q(r.erp_counter),
      });
    }

    const t = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
    const oneToOne = { total: 0, agree: 0 };
    for (const g of groups) {
      const v = verdictFor(g);
      g.verdict = v;
      t[v]++;
      if (isOneToOne(g)) { oneToOne.total++; if (v === "agree") oneToOne.agree++; }
      if (findings[v]) findings[v].push({ axis: a.id, ...g });
    }

    out("");
    out(`    --- ${a.id}   ${a.label}`);
    out(`        ${a.erp}  vs  ${a.bookField}`);
    out(`        ${a.consequence}`);
    out(`        ERP rows: ${erpGroups.reduce((n, r) => n + r.rows, 0)} keyed in ${erpGroups.length} group(s); `
      + `${unkeyed} carry NO AutoCount key and cannot be asked`);
    out(`        of the keyed groups: ${keyNotInBook} name a key the book does not have, ${cancelledSkipped} sit `
      + `on a cancelled book document, ${counterNull} the book leaves the counter NULL`);
    out(`        COMPARED: ${groups.length} group(s)`);
    out(`          agree                      ${String(t.agree).padStart(6)}`);
    out(`          ERP reads LOW              ${String(t.erp_low).padStart(6)}  the book transferred MORE than we record`);
    out(`          ERP reads HIGH             ${String(t.erp_high).padStart(6)}  we record more transferred than the book`);
    out(`          ERP asserts a transfer     ${String(t.erp_asserts_untransferred).padStart(6)}  the book moved NOTHING on this line`);
    out(`          book quantity is zero      ${String(t.book_qty_zero).padStart(6)}  no fraction to compare`);
    out(`          ERP quantity is zero       ${String(t.erp_qty_zero).padStart(6)}  no fraction to compare`);
    out(`        of the compared groups ${oneToOne.total} are 1:1 (no decomposition); ${oneToOne.agree} of those agree exactly`);
    for (const m of notInBookEx) out(`          key not in the book: ${m}`);

    axisRows.push({ id: a.id, compared: groups.length, ...t, unkeyed, keyNotInBook });
  }

  /* ══ 3. THE OFFENDERS, NAMED ═══════════════════════════════════════════ */
  head("3.  THE LINES THAT DISAGREE, NAMED");
  for (const cls of ["erp_low", "erp_high", "erp_asserts_untransferred"]) {
    const rows = findings[cls];
    /* Grouped by document: a repair and a conversation both happen per
       document, never per line. */
    const byDoc = new Map();
    for (const r of rows) {
      const k = `${r.axis}|${r.docNo}`;
      if (!byDoc.has(k)) byDoc.set(k, []);
      byDoc.get(k).push(r);
    }
    out("");
    out(`    --- ${cls}   ${rows.length} line group(s) across ${byDoc.size} document(s)`);
    let shown = 0;
    for (const [k, rs] of byDoc) {
      if (shown++ >= SHOW) break;
      const [axis, docNo] = k.split("|");
      out(`        ${axis}  ${docNo}  (${rs.length} line group(s))`);
      for (const r of rs.slice(0, 4)) {
        out(`            ${String(r.erpItem || r.itemKey).padEnd(24)} book ${fmtQ(r.bookTransfered)} of ${fmtQ(r.bookQty)}`
          + `  |  ERP ${fmtQ(r.erpCounter)} of ${fmtQ(r.erpQty)} over ${r.rows} row(s)  [key ${r.key}]`);
      }
    }
    if (byDoc.size > SHOW) out(`        ... ${byDoc.size - SHOW} more document(s) not printed`);
  }

  /* ══ 4. THE TWO EDGES WITH NO STORED COUNTER AT ALL ════════════════════ */
  head("4.  THE TWO EDGES THE ERP DOES NOT STORE A COUNTER FOR");
  out("    SO -> DO and DO -> IV have no denormalised ceiling in the ERP: how much of a sales order has");
  out("    been delivered is computed off delivery_order_items every time it is asked, and how much of a");
  out("    delivery order has been invoiced off sales_invoice_items. There is therefore NOTHING that can");
  out("    drift out of step on those two edges and no counter to repair - the only failure available to");
  out("    them is a missing LINK, which section 5 of check-ac-convert-symmetry measures. Stated rather");
  out("    than left out, so a reader cannot mistake the silence for a clean measurement.");
  const noCounter = await pg`
    SELECT 'delivery_order_items' AS t, count(*)::int AS rows,
           count(so_item_id)::int AS linked, count(linked_ac_dtlkey)::int AS keyed
      FROM scm.delivery_order_items WHERE company_id = ${CO}
    UNION ALL
    SELECT 'sales_invoice_items', count(*)::int, count(do_item_id)::int, count(linked_ac_dtlkey)::int
      FROM scm.sales_invoice_items WHERE company_id = ${CO}`;
  for (const r of noCounter) {
    out(`    ${String(r.t).padEnd(22)} ${String(r.rows).padStart(6)} rows | ${String(r.linked).padStart(6)} `
      + `carry a parent link | ${String(r.keyed).padStart(6)} carry an AutoCount key`);
  }

  /* ══ 5. NAMED DOCUMENTS, IN FULL ═══════════════════════════════════════ */
  if (DOCS.length) {
    head(`5.  THE DOCUMENTS ASKED FOR: ${DOCS.join(", ")}`);
    for (const d of DOCS) {
      out("");
      out(`    --- ${d}`);
      let found = false;
      for (const [t, m] of Object.entries(bookLine)) {
        const lines = [...m.values()].filter((l) => l.docNo === d);
        if (!lines.length) continue;
        found = true;
        const h = bookHdr[t].get(d);
        out(`        BOOK ${t} ${d} ${h?.docDate ?? ""}${h?.cancelled ? " CANCELLED" : ""} - ${lines.length} line(s)`);
        for (const l of lines) {
          out(`          key ${String(l.dtlKey).padEnd(9)} ${String(l.itemKey).padEnd(26)} qty ${fmtQ(l.qty).padStart(6)}`
            + ` | transfered ${l.transferedQty == null ? "-" : fmtQ(l.transferedQty)}`
            + ` | poTransfered ${l.transferedPoQty == null ? "-" : fmtQ(l.transferedPoQty)}`
            + ` | from ${l.fromDocType || "-"} ${l.fromDocNo || "-"} ${l.fromSoDtlKey || ""}`);
        }
      }
      if (!found) out("        not in the snapshot under any document type");

      const erpDo = await pg`
        SELECT h.do_number AS doc, i.id::text AS id, i.item_code, i.qty::text AS qty,
               i.so_item_id::text AS so_item_id, i.linked_ac_dtlkey::text AS k
          FROM scm.delivery_order_items i
          JOIN scm.delivery_orders h ON h.id = i.delivery_order_id
         WHERE h.company_id = ${CO} AND h.linked_ac_docno = ${d}
         ORDER BY i.id`;
      if (erpDo.length) {
        out(`        ERP delivery order ${erpDo[0].doc} (linked_ac_docno = ${d}) - ${erpDo.length} row(s)`);
        for (const r of erpDo) {
          out(`          row ${String(r.id).padEnd(9)} ${String(r.item_code).padEnd(26)} qty ${String(r.qty).padStart(6)}`
            + ` | so_item_id ${r.so_item_id ?? "NULL"} | key ${r.k ?? "NULL"}`);
        }
        const parents = await pg`
          SELECT DISTINCT s.doc_no, o.linked_ac_docno
            FROM scm.delivery_order_items i
            JOIN scm.delivery_orders h ON h.id = i.delivery_order_id
            JOIN scm.mfg_sales_order_items s ON s.id = i.so_item_id
            JOIN scm.mfg_sales_orders o ON o.doc_no = s.doc_no AND o.company_id = ${CO}
           WHERE h.company_id = ${CO} AND h.linked_ac_docno = ${d}`;
        out(`          its lines resolve to sales order(s): `
          + (parents.length ? parents.map((p) => `${p.doc_no} (book ${p.linked_ac_docno ?? "-"})`).join(", ") : "NONE"));
      }
      const erpSo = await pg`
        SELECT o.doc_no, o.status, count(i.id)::int AS lines, count(i.linked_ac_dtlkey)::int AS keyed
          FROM scm.mfg_sales_orders o
          LEFT JOIN scm.mfg_sales_order_items i ON i.doc_no = o.doc_no AND i.company_id = ${CO}
         WHERE o.company_id = ${CO} AND o.linked_ac_docno = ${d}
         GROUP BY o.doc_no, o.status`;
      for (const r of erpSo) {
        out(`        ERP sales order ${r.doc_no} (${r.status}): ${r.lines} line(s), ${r.keyed} carrying an AutoCount key`);
      }
      if (!erpDo.length && !erpSo.length) out("        the ERP carries no document stamped with this AutoCount number");
    }
  }

  /* ══ VERDICT ═══════════════════════════════════════════════════════════ */
  head("VERDICT");
  out("    axis      | compared | agree | ERP LOW | ERP HIGH | ERP asserts | unkeyed rows");
  out("    " + "-".repeat(84));
  for (const r of axisRows) {
    out(`    ${r.id.padEnd(9)} | ${String(r.compared).padStart(8)} | ${String(r.agree).padStart(5)} | `
      + `${String(r.erp_low).padStart(7)} | ${String(r.erp_high).padStart(8)} | `
      + `${String(r.erp_asserts_untransferred).padStart(11)} | ${String(r.unkeyed).padStart(12)}`);
  }
  const totLow = axisRows.reduce((n, r) => n + r.erp_low, 0);
  const totHigh = axisRows.reduce((n, r) => n + r.erp_high, 0);
  const totAssert = axisRows.reduce((n, r) => n + r.erp_asserts_untransferred, 0);
  const totCmp = axisRows.reduce((n, r) => n + r.compared, 0);
  out("");
  log(`TRANSFER COUNTERS: ${totLow + totHigh + totAssert} of ${totCmp} compared line groups disagree with the book `
    + `(${totLow} ERP reads LOW, ${totHigh} ERP reads HIGH, ${totAssert} the ERP asserts a transfer the book does not have).`);
  out("Every number above is an ANSWER, not a failure. This check exits 0 unless it could not be trusted.");
} finally {
  await pg.end({ timeout: 5 });
}
