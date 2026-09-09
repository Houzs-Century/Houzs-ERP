#!/usr/bin/env node
/* probe-cutover-so-do-lines — READ-ONLY.  Two questions, one run.
 *
 * WHY.  The go-live reconcile prints a COUNT per axis: "line-count differs: 19",
 * "quantity: 1", "document total: 6".  A count cannot be repaired; a named
 * document with a named cause can.  This probe puts the book's lines and the
 * ERP's lines of one document side by side, keyed by AutoCount's own DtlKey, so
 * the cause of each offender is READ rather than inferred.
 *
 * AND IT MEASURES THE BLIND SPOT `docs/bugs/0691` NAMED BUT DID NOT SIZE.  An
 * AutoCount sofa line becomes one ERP row PER COMPARTMENT, so a document whose
 * book side has 2 lines and whose ERP side has 2 rows can still be missing a
 * line — the sofa contributed two rows and the line beside it contributed none.
 * `HC-SO-012128` is exactly that: the four compensation pillows are absent and
 * the line-count column is silent, because 2 = 2.  The right grain is the
 * number of DISTINCT AutoCount line keys the ERP CLAIMS, which counts a
 * decomposition once.  Section B computes that for every paired document of
 * every type and lists the documents the line-count column cannot see.
 *
 * Section B classifies each unclaimed book line, because the classes are not
 * the same kind of thing at all:
 *
 *   EMPTY BOOK ROW   no ItemCode, quantity 0, price 0, no build text.  A blank
 *                    row a salesperson left in AutoCount.  There is no product,
 *                    no goods and no money in it; the ERP holding no row for it
 *                    is the two sides agreeing, not a gap.
 *   TEXT-ONLY LINE   no ItemCode but carrying text and/or money — an annotation
 *                    ("COLOUR : 885-4") or a charge typed as free text
 *                    ("DELIVERY FEE").  Money in it is REAL money.
 *   CODED LINE       a real product line.  Absent = goods missing from our copy.
 *
 * READ-ONLY BY CONSTRUCTION: every statement here is a SELECT.  It takes no
 * APPLY flag, so there is no path through this file that writes.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { decodeSnapshot } from "./lib/ac-scope.mjs";

const url = process.env.DATABASE_URL;
if (!url) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY_ID ?? 1);
const TOP = Number(process.env.TOP ?? 200);
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

/* The offenders the 2026-09-08 11:55 (Malaysia, UTC+8) reconcile printed on the
   SO / PO / DO line, quantity and money axes.  Overridable with DOCS="SO-1,DO-2"
   so the next round does not need a code change to look at its own list. */
const DEFAULT_DOCS = [
  /* SO — line count differs (19) */
  "SO-002294", "SO-002354", "SO-007144", "SO-000249", "SO-000282", "SO-000430",
  "SO-011752", "SO-010602", "SO-000102", "SO-007362", "SO-010789", "SO-012842",
  "SO-013181", "SO-003945", "SO-001932", "SO-001473", "SO-011384", "SO-008319",
  "SO-013160",
  /* SO — quantity (1) and document total (6) */
  "SO-012128", "SO-000021", "SO-012571",
  /* SO — carries an unpaired book line while the counts agree (the 0691 shape) */
  "SO-000814",
  /* PO — document total (1) */
  "PO-009770",
  /* DO — line count (4), quantity (2), document total (1) */
  "DO-001953", "DO-004903", "DO-000097", "DO-002544", "DO-011465", "DO-001604",
];
const DOCS = new Set(
  (process.env.DOCS ? process.env.DOCS.split(",") : DEFAULT_DOCS)
    .map((s) => s.trim()).filter(Boolean),
);

const snapPath = path.join(here, "data", "ac-reconcile-truth.json.gz");
const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(snapPath)).toString("utf8"));
const book = decodeSnapshot(snap);
log(`AutoCount snapshot exported_at=${snap.exported_at}; source=${snap.source}`);

const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 30 });

/* Compare AutoCount's DtlKey as a canonical decimal string: the export hands it
   back through ODBC + JSON + gzip and the ERP column is a bigint the pg driver
   may return either way. Byte-identical to topup-ac-so-lines.mjs:keyOf. */
const keyOf = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).trim().replace(/\.0+$/, "");
  return /^-?\d+$/.test(s) ? s : null;
};
const rm = (sen) => (sen == null ? "—" : `RM ${(Number(sen) / 100).toFixed(2)}`);

const TYPES = {
  SO: {
    label: "Sales Order",
    docs: () => sql`SELECT doc_no AS erp_no, linked_ac_docno AS ac_no,
        COALESCE(local_total_sen, subtotal_sen) AS total_sen, line_count
      FROM scm.mfg_sales_orders WHERE company_id = ${CO} AND linked_ac_docno IS NOT NULL`,
    lines: () => sql`SELECT h.linked_ac_docno AS ac_no, i.item_code, i.qty::float8 AS qty,
        i.unit_price_sen, i.total_sen, i.linked_ac_dtlkey AS ac_dtlkey, i.line_suffix,
        COALESCE(i.line_no, 0) AS line_no, i.item_group, i.description2, i.remark
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
      WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`,
  },
  PO: {
    label: "Purchase Order",
    docs: () => sql`SELECT po_number AS erp_no, linked_ac_docno AS ac_no, total_sen,
        NULL::int AS line_count
      FROM scm.purchase_orders WHERE company_id = ${CO} AND linked_ac_docno IS NOT NULL`,
    lines: () => sql`SELECT h.linked_ac_docno AS ac_no, i.item_code, i.qty::float8 AS qty,
        i.unit_price_sen, i.line_total_sen AS total_sen, i.linked_ac_dtlkey AS ac_dtlkey, i.line_suffix,
        0 AS line_no, i.item_group, i.description2, NULL::text AS remark
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
      WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`,
  },
  DO: {
    label: "Delivery Order",
    docs: () => sql`SELECT do_number AS erp_no, linked_ac_docno AS ac_no,
        COALESCE(local_total_sen, 0) AS total_sen, NULL::int AS line_count
      FROM scm.delivery_orders WHERE company_id = ${CO} AND linked_ac_docno IS NOT NULL`,
    lines: () => sql`SELECT h.linked_ac_docno AS ac_no, i.item_code, i.qty::float8 AS qty,
        i.unit_price_sen, i.line_total_sen AS total_sen, i.linked_ac_dtlkey AS ac_dtlkey, i.line_suffix,
        COALESCE(i.line_no, 0) AS line_no, i.item_group, i.description2, NULL::text AS remark
      FROM scm.delivery_order_items i
      JOIN scm.delivery_orders h ON h.id = i.delivery_order_id
      WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`,
  },
};

/* An unclaimed book line, classified.  See the header for why the three classes
   are kept apart rather than summed. */
function classify(l, desc2) {
  const coded = l.hasCode && String(l.itemKey ?? "").trim() !== "";
  const money = Number(l.subTotalSen ?? 0) !== 0 || Number(l.unitPriceSen ?? 0) !== 0;
  const text = String(l.itemKey ?? "").trim() !== "" || String(desc2 ?? "").trim() !== "";
  if (coded) return "CODED LINE";
  if (!text && !money && Number(l.qty ?? 0) === 0) return "EMPTY BOOK ROW";
  return "TEXT-ONLY LINE";
}

async function main() {
  const erp = {};
  for (const [t, cfg] of Object.entries(TYPES)) {
    const [docs, lines] = await Promise.all([cfg.docs(), cfg.lines()]);
    const byAc = new Map();
    for (const d of docs) byAc.set(String(d.ac_no), { ...d, lines: [] });
    for (const l of lines) byAc.get(String(l.ac_no))?.lines.push(l);
    erp[t] = byAc;
    log(`ERP ${t}: ${docs.length} migrated document(s), ${lines.length} line(s)`);
  }

  /* ── A.  The named offenders, side by side ─────────────────────────────── */
  log("");
  log("═══════════ A — THE OFFENDERS, BOOK LINE AGAINST ERP LINE ═══════════");
  for (const acNo of DOCS) {
    const t = acNo.slice(0, 2);
    const B = book[t];
    if (!B) { log(`\n### ${acNo}: no book side for type ${t}`); continue; }
    const h = B.headers.get(acNo);
    const bLines = (B.lines.get(acNo) ?? []).slice().sort((a, b) => a.seq - b.seq);
    const e = erp[t]?.get(acNo);
    const eLines = (e?.lines ?? []).slice().sort((a, b) => Number(a.line_no) - Number(b.line_no));
    const eSum = eLines.reduce((s, l) => s + Number(l.total_sen ?? 0), 0);
    log("");
    log(`### ${acNo} -> ${e?.erp_no ?? "(NOT IN THE ERP)"}  book ${bLines.length} line(s) / ${rm(h?.totalSen)}` +
        `   ERP ${eLines.length} row(s) / header ${rm(e?.total_sen)} / lines sum ${rm(eSum)}` +
        (Number(e?.total_sen ?? 0) !== eSum ? "  <- HEADER DOES NOT EQUAL ITS OWN LINES" : ""));
    const claimed = new Map();
    for (const l of eLines) {
      const k = keyOf(l.ac_dtlkey);
      if (k === null) continue;
      if (!claimed.has(k)) claimed.set(k, []);
      claimed.get(k).push(l);
    }
    for (const l of bLines) {
      const k = keyOf(l.dtlKey);
      const d2 = B.desc2?.get(String(l.dtlKey)) ?? "";
      const rows = (k !== null && claimed.get(k)) || [];
      const head = `  BOOK seq=${l.seq} key=${l.dtlKey} "${l.itemKey}" code=${l.hasCode ? "Y" : "N"} ` +
        `qty=${l.qty} unit=${rm(l.unitPriceSen)} sub=${rm(l.subTotalSen)}` +
        (d2 ? ` d2="${String(d2).replace(/\s+/g, " ").slice(0, 70)}"` : "");
      if (!rows.length) log(`${head}\n      -> NO ERP ROW CLAIMS THIS KEY  [${classify(l, d2)}]`);
      else for (const r of rows) {
        log(`${head}\n      -> ERP line_no=${r.line_no} "${r.item_code}"${r.line_suffix ? `/${r.line_suffix}` : ""} ` +
            `qty=${r.qty} unit=${rm(r.unit_price_sen)} total=${rm(r.total_sen)} grp=${r.item_group}` +
            (rows.length > 1 ? "  [one of several rows for this one book line — a decomposition]" : ""));
      }
    }
    const bookKeys = new Set(bLines.map((l) => keyOf(l.dtlKey)).filter((k) => k !== null));
    for (const r of eLines) {
      const k = keyOf(r.ac_dtlkey);
      if (k === null) log(`  ERP line_no=${r.line_no} "${r.item_code}" qty=${r.qty} total=${rm(r.total_sen)}` +
        `  -> CARRIES NO AUTOCOUNT KEY (this document cannot be judged line by line)`);
      else if (!bookKeys.has(k)) log(`  ERP line_no=${r.line_no} "${r.item_code}" qty=${r.qty} total=${rm(r.total_sen)}` +
        `  -> CLAIMS KEY ${k}, WHICH IS NOT A LINE OF THIS BOOK DOCUMENT`);
    }
  }

  /* ── B.  The blind spot: unclaimed book lines on documents whose COUNTS agree */
  log("");
  log("═══════════ B — THE 0691 BLIND SPOT, MEASURED ═══════════");
  log("A book line is UNCLAIMED when no ERP row of that document carries its DtlKey. Counting ERP");
  log("ROWS hides it whenever a sofa on the same document decomposed into extra rows; counting the");
  log("DISTINCT KEYS THE ERP CLAIMS does not. Documents holding a keyless ERP row are UNJUDGEABLE and");
  log("are reported separately, never as clean.");
  for (const [t, cfg] of Object.entries(TYPES)) {
    const B = book[t];
    const tally = { paired: 0, unjudgeable: 0, clean: 0 };
    const offenders = [];
    for (const [acNo, e] of erp[t]) {
      const bLines = B.lines.get(acNo);
      if (!bLines) continue;
      tally.paired += 1;
      const keyless = e.lines.filter((l) => keyOf(l.ac_dtlkey) === null).length;
      if (keyless > 0) { tally.unjudgeable += 1; continue; }
      const claimed = new Set(e.lines.map((l) => keyOf(l.ac_dtlkey)).filter((k) => k !== null));
      const unclaimed = bLines.filter((l) => {
        const k = keyOf(l.dtlKey);
        return k === null || !claimed.has(k);
      });
      if (!unclaimed.length) { tally.clean += 1; continue; }
      offenders.push({
        acNo, erpNo: e.erp_no, bookLines: bLines.length, erpRows: e.lines.length,
        claimed: claimed.size,
        /* The line-count column of the reconcile compares these two. When they
           are equal it says nothing — that is the blind spot, exactly. */
        countColumnSilent: bLines.length === e.lines.length,
        unclaimed: unclaimed.map((l) => {
          const d2 = B.desc2?.get(String(l.dtlKey)) ?? "";
          return {
            key: l.dtlKey, item: l.itemKey, qty: l.qty,
            sub: Number(l.subTotalSen ?? 0), cls: classify(l, d2),
            d2: String(d2).replace(/\s+/g, " ").slice(0, 60),
          };
        }),
      });
    }
    const hidden = offenders.filter((o) => o.countColumnSilent);
    const cls = (list) => {
      const m = new Map();
      for (const o of list) for (const u of o.unclaimed) m.set(u.cls, (m.get(u.cls) ?? 0) + 1);
      return [...m].map(([k, n]) => `${k} ${n}`).join(", ") || "(none)";
    };
    log("");
    log(`${t} — ${cfg.label}: ${tally.paired} paired document(s); ${tally.unjudgeable} UNJUDGEABLE (an ERP row carries no AutoCount key); ` +
        `${tally.clean} claim every book line; ${offenders.length} do NOT`);
    log(`   of those ${offenders.length}, ${hidden.length} are INVISIBLE to the line-count column (book lines = ERP rows), ` +
        `${offenders.length - hidden.length} the column already reports`);
    log(`   unclaimed book lines, all offenders: ${cls(offenders)}`);
    log(`   unclaimed book lines, the INVISIBLE ones only: ${cls(hidden)}`);
    for (const o of offenders.slice(0, TOP)) {
      log(`   ${o.countColumnSilent ? "HIDDEN " : "REPORTED"} ${o.acNo} -> ${o.erpNo}: book ${o.bookLines} line(s), ` +
          `ERP ${o.erpRows} row(s) claiming ${o.claimed} key(s)`);
      for (const u of o.unclaimed) {
        log(`      unclaimed key=${u.key} "${u.item}" qty=${u.qty} sub=${rm(u.sub)} [${u.cls}]${u.d2 ? ` d2="${u.d2}"` : ""}`);
      }
    }
    if (offenders.length > TOP) log(`   ... and ${offenders.length - TOP} more — raise TOP`);
  }

  await sql.end();
}
main().catch(async (e) => { console.error(e); try { await sql.end(); } catch {} process.exit(1); });
