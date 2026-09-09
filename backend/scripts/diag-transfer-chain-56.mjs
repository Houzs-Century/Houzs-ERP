#!/usr/bin/env node
/* diag-transfer-chain-56 — READ-ONLY. Dump both sides, at LINE grain, for the
 * documents the tally locks on the `transfer from` / `transfer to` axes, plus
 * the CANDIDATE parent lines on each book-named source document.
 *
 * WHY IT EXISTS. The tally names the document and the axis; it does not print
 * the two candidate lines a reader needs to CHECK a pairing claim. The rule
 * this lane must obey — one line of that item code on the source document is
 * that line; two or more are separated by the build text and only when exactly
 * one matches; everything else REFUSES and is named — is not decidable from a
 * document-grain report. So this prints the candidates and lets a human check.
 *
 * NEVER PAIR BY POSITION. PO-009081 ordered two identical bedframes and two
 * receipts each took one; position pairing pairs them backwards
 * (docs/bugs/0690). `line_no` and `seq` are printed as LABELS and are never
 * used to choose.
 *
 * READ-ONLY AND BOUNDED. SELECTs only, one connection, no DDL, no transaction,
 * no APPLY switch. Every read is restricted to the named documents and to the
 * documents the BOOK names as their source; there is no table scan.
 */
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { fromVerdictFor, sourceDocTokens, IS_DIFFERENCE } from "./lib/transfer-chain-verdict.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const MAXAGE = Number(process.env.MAX_SNAPSHOT_AGE_DAYS || 2);
/* READ-ONLY IS PINNED AT THE CONNECTION, not merely intended. A diagnostic that
   only promises to read is one typo away from writing; this makes the server
   refuse. */
const sql = postgres(DST, {
  ssl: "require", prepare: false, max: 1,
  connection: { default_transaction_read_only: "on" },
});
const U = (s) => String(s ?? "").trim().toUpperCase();
const N = (s) => U(s).replace(/\s+/g, " ");

const SNAP = path.join(here, "data", "ac-convert-edges.json.gz");
const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(SNAP)).toString("utf8"));
const ageDays = (Date.now() - new Date(snap.exported_at).getTime()) / 86400000;
if (!(ageDays <= MAXAGE)) {
  console.error(`the chain snapshot is ${ageDays.toFixed(1)} days old (limit ${MAXAGE}); refusing`);
  process.exit(3);
}
const L = Object.fromEntries(snap.line_fields.map((n, i) => [n, i]));
const TYPES = ["SO", "PO", "GR", "DO", "IV", "PI"];
const bookLines = (t) => (snap.types[t]?.lines || []).map((r) => ({
  docNo: r[L.docNo], dtlKey: String(r[L.dtlKey]), seq: r[L.seq], itemKey: r[L.itemKey],
  qty: r[L.qty], transferedQty: r[L.transferedQty], transferedPoQty: r[L.transferedPoQty],
  fromDocType: r[L.fromDocType] || "", fromDocNo: r[L.fromDocNo] || "", fromSoDtlKey: r[L.fromSoDtlKey] || "",
}));
const BOOK_BY_DOC = Object.fromEntries(TYPES.map((t) => {
  const m = new Map();
  for (const l of bookLines(t)) { if (!m.has(l.docNo)) m.set(l.docNo, []); m.get(l.docNo).push(l); }
  return [t, m];
}));

const say = (m) => console.log(m);

/* The ERP side, one bounded query per child type. */
const CHILD = {
  SO: (docs) => sql`
    SELECT h.linked_ac_docno AS ac_no, h.doc_no AS erp_no, i.id::text AS erp_item_id,
           i.linked_ac_dtlkey::text AS child_key, i.line_no, i.item_code, i.description2,
           i.qty::float8 AS qty, i.po_qty_picked::float8 AS counter, i.item_group,
           NULL::text AS parent_a, NULL::text AS parent_b, NULL::text AS parent_line_key,
           FALSE AS has_link
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no AND h.company_id = ${CO}
     WHERE h.company_id = ${CO} AND h.linked_ac_docno = ANY(${docs})
     ORDER BY h.linked_ac_docno, i.line_no`,
  PO: (docs) => sql`
    SELECT h.linked_ac_docno AS ac_no, h.po_number AS erp_no, i.id::text AS erp_item_id,
           i.linked_ac_dtlkey::text AS child_key, NULL::int AS line_no, i.item_code, i.description2,
           i.qty::float8 AS qty, i.received_qty::float8 AS counter, i.item_group,
           sh.linked_ac_docno AS parent_a, NULL::text AS parent_b,
           si.linked_ac_dtlkey::text AS parent_line_key, (i.so_item_id IS NOT NULL) AS has_link
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
      LEFT JOIN scm.mfg_sales_order_items si ON si.id = i.so_item_id
      LEFT JOIN scm.mfg_sales_orders sh ON sh.doc_no = si.doc_no AND sh.company_id = ${CO}
     WHERE h.company_id = ${CO} AND h.linked_ac_docno = ANY(${docs})
     ORDER BY h.linked_ac_docno, i.created_at, i.id`,
  GR: (docs) => sql`
    SELECT g.linked_ac_gr_docno || '|' || p.linked_ac_docno AS ac_no, g.grn_number AS erp_no,
           i.id::text AS erp_item_id, i.linked_ac_dtlkey::text AS child_key, NULL::int AS line_no,
           i.item_code, i.description2, i.qty_accepted::float8 AS qty,
           i.invoiced_qty::float8 AS counter, i.item_group,
           pp.linked_ac_docno AS parent_a, NULL::text AS parent_b,
           pi2.linked_ac_dtlkey::text AS parent_line_key,
           (i.purchase_order_item_id IS NOT NULL) AS has_link
      FROM scm.grn_items i
      JOIN scm.grns g ON g.id = i.grn_id
      JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
      LEFT JOIN scm.purchase_order_items pi2 ON pi2.id = i.purchase_order_item_id
      LEFT JOIN scm.purchase_orders pp ON pp.id = pi2.purchase_order_id
     WHERE g.company_id = ${CO} AND g.status <> 'CANCELLED'
       AND g.linked_ac_gr_docno IS NOT NULL AND p.linked_ac_docno IS NOT NULL
       AND (g.linked_ac_gr_docno || '|' || p.linked_ac_docno) = ANY(${docs})
     ORDER BY 1, i.created_at, i.id`,
  DO: (docs) => sql`
    SELECT h.linked_ac_docno AS ac_no, h.do_number AS erp_no, i.id::text AS erp_item_id,
           i.linked_ac_dtlkey::text AS child_key, i.line_no, i.item_code, i.description2,
           i.qty::float8 AS qty, NULL::float8 AS counter, i.item_group,
           sh.linked_ac_docno AS parent_a, NULL::text AS parent_b,
           si.linked_ac_dtlkey::text AS parent_line_key, (i.so_item_id IS NOT NULL) AS has_link
      FROM scm.delivery_order_items i
      JOIN scm.delivery_orders h ON h.id = i.delivery_order_id
      LEFT JOIN scm.mfg_sales_order_items si ON si.id = i.so_item_id
      LEFT JOIN scm.mfg_sales_orders sh ON sh.doc_no = si.doc_no AND sh.company_id = ${CO}
     WHERE h.company_id = ${CO} AND h.linked_ac_docno = ANY(${docs})
     ORDER BY h.linked_ac_docno, i.line_no`,
  PI: (docs) => sql`
    SELECT h.linked_ac_docno AS ac_no, h.invoice_number AS erp_no, i.id::text AS erp_item_id,
           i.linked_ac_dtlkey::text AS child_key, NULL::int AS line_no, i.item_code, i.description2,
           i.qty::float8 AS qty, NULL::float8 AS counter, NULL::text AS item_group,
           g.linked_ac_gr_docno AS parent_a, p.linked_ac_docno AS parent_b,
           NULL::text AS parent_line_key, (i.grn_item_id IS NOT NULL) AS has_link
      FROM scm.purchase_invoice_items i
      JOIN scm.purchase_invoices h ON h.id = i.purchase_invoice_id
      LEFT JOIN scm.grn_items gi ON gi.id = i.grn_item_id
      LEFT JOIN scm.grns g ON g.id = gi.grn_id AND g.company_id = ${CO}
      LEFT JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
     WHERE h.company_id = ${CO} AND h.linked_ac_docno = ANY(${docs})
     ORDER BY h.linked_ac_docno, i.created_at, i.id`,
};

/* The PARENT candidates, per source type, restricted to the documents the book
   named. Read once per type so the pairing question can be answered without a
   per-line round trip. */
const PARENT = {
  SO: (docs) => sql`
    SELECT h.linked_ac_docno AS ac_no, i.id::text AS erp_item_id, i.line_no,
           i.item_code, i.description2, i.qty::float8 AS qty,
           i.linked_ac_dtlkey::text AS line_key, i.cancelled, i.item_group
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no AND h.company_id = ${CO}
     WHERE h.company_id = ${CO} AND h.linked_ac_docno = ANY(${docs})
     ORDER BY h.linked_ac_docno, i.line_no`,
  PO: (docs) => sql`
    SELECT h.linked_ac_docno AS ac_no, i.id::text AS erp_item_id, NULL::int AS line_no,
           i.item_code, i.description2, i.qty::float8 AS qty,
           i.linked_ac_dtlkey::text AS line_key, FALSE AS cancelled, i.item_group
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
     WHERE h.company_id = ${CO} AND h.linked_ac_docno = ANY(${docs})
     ORDER BY h.linked_ac_docno, i.created_at, i.id`,
  GR: (docs) => sql`
    SELECT g.linked_ac_gr_docno AS ac_no, i.id::text AS erp_item_id, NULL::int AS line_no,
           i.item_code, i.description2, i.qty_accepted::float8 AS qty,
           i.linked_ac_dtlkey::text AS line_key, FALSE AS cancelled, i.item_group
      FROM scm.grn_items i
      JOIN scm.grns g ON g.id = i.grn_id
     WHERE g.company_id = ${CO} AND g.status <> 'CANCELLED' AND g.linked_ac_gr_docno = ANY(${docs})
     ORDER BY g.linked_ac_gr_docno, i.created_at, i.id`,
};

const DEFAULTS = {
  SO: "SO-000870,SO-010209,SO-010955,SO-011207,SO-012128,SO-012729,SO-013389",
  PO: "PO-009467,PO-009554,PO-009587,PO-009679,PO-009830,PO-009828",
  GR: "GR-000232|PO-000290,GR-004478|PO-008506,GR-004940|PO-009024,GR-004982|PO-009024,GR-005278|PO-009920,GR-005334|PO-009887,GR-005360|PO-010024",
  DO: "DO-001604,DO-001800,DO-001953,DO-004903,DO-005583",
  PI: "PI-001531,PI-007405,PI-007407,PI-007502,PI-007551,PI-007671,PI-007702,PI-007703,PI-007817,PI-007822,PI-007824,PI-007853,PI-007854,PI-007893,PI-007894,PI-007895,PI-007910,PI-007916,PI-007917,PI-007919,PI-007920,PI-007923,PI-007927,PI-007928,PI-007929,PI-007931,PI-007941,PI-007942,PI-007943,PI-007945,PI-007947,PI-007955",
};
const listOf = (t) => (process.env[`${t}_DOCS`] || DEFAULTS[t]).split(",").map((s) => s.trim()).filter(Boolean);

async function main() {
  say(`book cut ${snap.exported_at} (${ageDays.toFixed(2)} days old) · source ${JSON.stringify(snap.source)} · company ${CO}`);

  for (const t of ["SO", "PO", "GR", "DO", "PI"]) {
    const acDocs = listOf(t);
    if (!acDocs.length) continue;
    say("");
    say(`══════════════════ ${t} — ${acDocs.length} document(s) ══════════════════`);
    const rows = await CHILD[t](acDocs);
    const bookDocOf = (ac) => (t === "GR" ? ac.split("|")[0] : ac);

    /* the source documents the book names, gathered so the candidates can be
       read in ONE bounded query per source type rather than one per line */
    const wantSrc = { SO: new Set(), PO: new Set(), GR: new Set() };
    const bookRowsFor = new Map();
    for (const ac of acDocs) {
      const bl = BOOK_BY_DOC[t].get(bookDocOf(ac)) || [];
      bookRowsFor.set(ac, bl);
      for (const l of bl) {
        for (const tok of sourceDocTokens(l.fromDocNo)) {
          if (tok.startsWith("SO-")) wantSrc.SO.add(tok);
          else if (tok.startsWith("PO-")) wantSrc.PO.add(tok);
          else if (tok.startsWith("GR-")) wantSrc.GR.add(tok);
        }
      }
    }
    const cand = {};
    for (const [st, set] of Object.entries(wantSrc)) {
      if (!set.size || !PARENT[st]) { cand[st] = new Map(); continue; }
      const got = await PARENT[st]([...set]);
      const m = new Map();
      for (const r of got) { const k = U(r.ac_no); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
      cand[st] = m;
    }

    for (const ac of acDocs) {
      const mine = rows.filter((r) => U(r.ac_no) === U(ac));
      const theirs = bookRowsFor.get(ac) || [];
      say("");
      say(`--- ${ac}  (ERP ${mine[0]?.erp_no ?? "NO ERP ROWS READ"}) — book ${theirs.length} line(s), ERP ${mine.length} row(s) ---`);
      for (const b of theirs) {
        say(`  BOOK dtl=${b.dtlKey} seq=${b.seq} item=${b.itemKey} qty=${b.qty} tQty=${b.transferedQty} tPOQty=${b.transferedPoQty} from=${b.fromDocType || "-"} ${b.fromDocNo || "-"}${b.fromSoDtlKey ? " line " + b.fromSoDtlKey : ""}`);
      }
      for (const r of mine) {
        const b = theirs.find((x) => x.dtlKey === String(r.child_key ?? "").trim());
        const parents = [r.parent_a, r.parent_b].map((p) => (p == null ? "" : String(p).trim())).filter(Boolean);
        let v = "NO-BOOK-LINE-FOR-THIS-KEY";
        if (b) {
          v = fromVerdictFor({
            bookFromDocType: b.fromDocType, bookFromDocNo: b.fromDocNo, bookFromLineKey: b.fromSoDtlKey,
            erpHasLink: r.has_link === true,
            erpParentDocNo: parents.find((p) => U(p) === U(b.fromDocNo)) ?? parents[0] ?? null,
            erpParentLineKey: r.parent_line_key == null ? null : String(r.parent_line_key).trim(),
          });
        }
        const mark = IS_DIFFERENCE.has(v) ? "**" : "  ";
        say(`${mark}ERP  line=${r.line_no} key=${r.child_key ?? "NONE"} item=${r.item_code} qty=${r.qty} counter=${r.counter ?? "-"} grp=${r.item_group ?? "-"} parents=[${parents.join(" / ") || "none"}]${r.parent_line_key ? " pline=" + r.parent_line_key : ""} => ${v}`);
        say(`      d2=${JSON.stringify(String(r.description2 ?? "").slice(0, 200))}  id=${r.erp_item_id}`);
        if (b && IS_DIFFERENCE.has(v)) {
          for (const tok of sourceDocTokens(b.fromDocNo)) {
            const st = tok.startsWith("SO-") ? "SO" : tok.startsWith("PO-") ? "PO" : tok.startsWith("GR-") ? "GR" : null;
            if (!st) continue;
            const list = cand[st]?.get(U(tok)) || [];
            const same = list.filter((c) => N(c.item_code) === N(r.item_code));
            say(`      CANDIDATES on ${tok}: ${list.length} ERP line(s), ${same.length} with the same item code`);
            for (const c of same) {
              say(`        cand line=${c.line_no} item=${c.item_code} qty=${c.qty} key=${c.line_key ?? "-"} cancelled=${c.cancelled} id=${c.erp_item_id} d2=${JSON.stringify(String(c.description2 ?? "").slice(0, 160))}`);
            }
            if (!same.length) {
              for (const c of list) say(`        (no code match; other) line=${c.line_no} item=${c.item_code} qty=${c.qty} key=${c.line_key ?? "-"} id=${c.erp_item_id} d2=${JSON.stringify(String(c.description2 ?? "").slice(0, 120))}`);
            }
          }
        }
      }
    }
  }
  await sql.end({ timeout: 5 });
}
main().catch(async (e) => { console.error(e); try { await sql.end({ timeout: 5 }); } catch { /* closing */ } process.exit(1); });
