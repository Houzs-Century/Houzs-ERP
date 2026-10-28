#!/usr/bin/env node
/* probe-sofa-six-builds — what the ERP holds for the six sales orders whose
 * SALES side and PURCHASE side describe DIFFERENT sofa builds, and for the
 * purchase order raised from each.
 *
 * READ-ONLY. Every statement is a SELECT; there is no APPLY flag and no write
 * path.
 *
 * ── WHY A PROBE AT ALL, WHEN THE OWNER HAS ALREADY ANSWERED ────────────────
 * Because his answer is the TARGET, and a target is not a plan. Each of these
 * twelve documents can refuse the write for its own reason — a piece SKU that
 * was never minted, a surplus row a purchase line is dedicated to, a receipt
 * that moved real stock, two sofas on one document that no needle tells apart.
 * The apply script reports all of those, but only once it is dispatched. This
 * prints the same facts BEFORE anything is planned, so the entries written into
 * the corrections file are addressed at rows that exist.
 *
 * ── THE PAIRING IS THE POINT ───────────────────────────────────────────────
 * These six exist precisely because the sales order and the purchase order
 * disagree, so writing one side alone leaves the other holding the lead piece
 * on its own — the half-write docs/bugs/0719 refuses. The purchase counterpart
 * is resolved the way the book itself states it: PO line `fromSoDtlKey` naming
 * the sales line's DtlKey, or `fromDocNo` naming the sales document. Read out
 * of the committed snapshot, printed, and checked against what the ERP's own
 * `so_item_id` dedication says — two independent answers to "which purchase
 * order is this", so a wrong one is visible instead of assumed.
 *
 * THE BOOK SIDE IS THE COMMITTED SNAPSHOT data/ac-reconcile-truth.json.gz. The
 * live book is reachable only over ZeroTier from the office and a hosted runner
 * has no route to it, so what is printed side by side is "the ERP now" beside
 * "the snapshot the reconcile compared against" — the pair the repair has to
 * settle.
 *
 * WHY LINE KEYS AND NOT POSITIONS: docs/bugs/0690 is the named class — two
 * similar rows paired by POSITION get swapped, and the swap is invisible
 * afterwards because both names look plausible. Every row below is printed with
 * `linked_ac_dtlkey` beside it so identity can be checked rather than order.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { parseSofa } from "./lib/parse-sofa.mjs";
import { loadCorrections } from "./lib/sofa-corrections-source.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const here = path.dirname(fileURLToPath(import.meta.url));
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

/** The owner's answers of 2026-09-08, as the TARGET each document is measured
 *  against. Printed, never written — this file has no write path. */
const TARGETS = [
  { so: "HC-SO-010287", model: "9058", pieces: ["3S"], seat: "30" },
  { so: "HC-SO-012128", model: "9028", pieces: ["1A(LHF)", "1A(RHF)"], seat: "28" },
  { so: "HC-SO-011207", model: "9028", pieces: ["2A(LHF)", "1A(RHF)"], seat: "30" },
  { so: "HC-SO-010955", model: "9058", pieces: ["2A(LHF)", "CNR", "1A(RHF)"], seat: "26" },
  { so: "HC-SO-010209", model: "9058", pieces: ["1A(LHF)", "1NA", "L(RHF)"], seat: "26" },
  { so: "HC-SO-012729", model: "9058", pieces: ["CNR", "2A(RHF)", "1S"], seat: "30" },
];

const p = (m) => console.log(m);
const j = (v) => JSON.stringify(v);
const head = (t) => { p(""); p(`═══════════ ${t} ═══════════`); };
const K = (s) => String(s ?? "").trim().toUpperCase();

const book = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", "ac-reconcile-truth.json.gz"))));
const LF = book.line_fields;
const lineObj = (r) => Object.fromEntries(LF.map((k, i) => [k, r[i]]));
const desc2Of = (type) => new Map(book.types[type].desc2.map(([k, v]) => [String(k), v]));

function bookLines(type, docNo) {
  const d2 = desc2Of(type);
  return book.types[type].lines.filter((r) => r[0] === docNo).map(lineObj)
    .map((l) => ({ ...l, desc2: d2.get(String(l.dtlKey)) ?? null }));
}

/** The purchase document the BOOK says was raised from this sales document.
 *  Two independent statements, both printed: a PO line whose `fromSoDtlKey` is
 *  one of this sales document's line keys, and a PO line whose `fromDocNo`
 *  names the document. */
function bookPoFor(soAc, soDtlKeys) {
  const keys = new Set(soDtlKeys.map(String));
  const hits = [];
  for (const r of book.types.PO.lines) {
    const o = lineObj(r);
    const byKey = keys.has(String(o.fromSoDtlKey ?? "").trim());
    const byDoc = String(o.fromDocNo ?? "").trim() === soAc;
    if (byKey || byDoc) hits.push({ ...o, byKey, byDoc });
  }
  return hits;
}

async function cols(table) {
  const [schema, name] = table.split(".");
  const rs = await sql`SELECT column_name FROM information_schema.columns
                        WHERE table_schema = ${schema} AND table_name = ${name}`;
  return new Set(rs.map((r) => r.column_name));
}

/** The compartment half of `9058-1A(LHF)`; "" for a code with no dash. */
const compartmentOf = (code) => { const c = K(code); const d = c.indexOf("-"); return d < 0 ? "" : c.slice(d + 1); };

async function main() {
  p(`probe-sofa-six-builds — company ${CO}`);
  p(`AutoCount snapshot exported_at=${book.exported_at} (${book.source})`);

  /* ── are the target piece SKUs minted at all? ───────────────────────────── */
  head("ARE THE TARGET PIECE SKUs MINTED? (a build whose SKU is absent is REFUSED)");
  const prods = await sql`SELECT code FROM scm.mfg_products WHERE company_id = ${CO}`;
  const codeSet = new Set(prods.map((x) => K(x.code)));
  for (const t of TARGETS) {
    const want = t.pieces.map((x) => `${t.model}-${K(x)}`);
    const missing = want.filter((w) => !codeSet.has(w));
    p(`  ${t.so}  ${want.join(" + ")}  ->  ${missing.length ? `MISSING ${missing.join(", ")}` : "all minted"}`);
  }

  /* ── which entries already exist for these documents ────────────────────── */
  head("WHAT THE CORRECTIONS FILES ALREADY SAY ABOUT THESE DOCUMENTS");
  const DATA = loadCorrections(path.join(here, "data"));
  for (const f of DATA.files) p(`  source: ${f}`);
  const names = new Set(TARGETS.map((t) => t.so));
  for (const b of DATA.builds) {
    if (!(b.docs || []).some((d) => names.has(d))) continue;
    p(`  ${(b.docs || []).join(", ")}  [${b.source}]  ${b.model ?? "(model from row)"} ${(b.pieces || []).join("+")} seat=${j(b.seat ?? null)}`);
    p(`      desc2Match=${j(b.desc2Match ?? null)} lineKeys=${j(b.lineKeys ?? null)} exclude=${j(b.desc2Exclude ?? null)}`);
  }

  const soiCols = await cols("scm.mfg_sales_order_items");
  p("");
  p(`scm.mfg_sales_order_items columns: ${[...soiCols].sort().join(", ")}`);

  for (const t of TARGETS) {
    head(`${t.so}  — owner's answer: ${t.model} ${t.pieces.join(" + ")} @ ${t.seat}"`);
    const ac = t.so.replace(/^HC-/, "");

    const [h] = await sql`SELECT * FROM scm.mfg_sales_orders WHERE company_id = ${CO} AND doc_no = ${t.so}`;
    if (!h) { p("  NOT IN THE ERP"); continue; }
    p(`  header: status=${j(h.status)} doc_date=${j(h.doc_date)} processing_date=${j(h.processing_date ?? null)}` +
      ` linked_ac_docno=${j(h.linked_ac_docno ?? null)} total_sen=${h.total_sen} migrated_no_stock=${j(h.migrated_no_stock ?? null)}` +
      ` cancelled_at=${j(h.cancelled_at ?? null)}`);

    const rows = await sql`SELECT * FROM scm.mfg_sales_order_items
                            WHERE company_id = ${CO} AND doc_no = ${t.so} ORDER BY line_no`;
    const sofa = rows.filter((r) => r.item_group === "sofa");
    p(`  ${rows.length} ERP line(s), ${sofa.length} of them sofa:`);
    let soMoney = 0;
    for (const r of sofa) {
      soMoney += Number(r.unit_price_sen || 0) * Number(r.qty || 0);
      p(`    line ${r.line_no} id=${r.id} code=${j(r.item_code)} qty=${r.qty} unit=${r.unit_price_sen} total=${r.total_sen}`);
      p(`      dtlkey=${j(r.linked_ac_dtlkey ?? null)} seat=${j(r.variants?.seatHeight ?? r.variants?.depth ?? null)}`);
      p(`      description2=${j(r.description2)}`);
      p(`      variants=${j(r.variants)}`);
      const ps = await sql`SELECT i.id, i.item_code, i.linked_ac_dtlkey, p.po_number, i.received_qty
                             FROM scm.purchase_order_items i
                             JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
                            WHERE i.so_item_id = ${r.id}`;
      const ds = await sql`SELECT d.do_number, di.item_code FROM scm.delivery_order_items di
                             JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
                            WHERE di.so_item_id = ${r.id}`;
      p(`      dedicated PO line(s): ${ps.map((x) => `${x.po_number}#${x.id} ${x.item_code} dtl=${j(x.linked_ac_dtlkey ?? null)} recv=${x.received_qty}`).join(" | ") || "(none)"}`);
      p(`      DO line(s): ${ds.map((x) => `${x.do_number} ${x.item_code}`).join(" | ") || "(none)"}`);
    }
    p(`  ERP sofa pieces held: ${sofa.map((r) => compartmentOf(r.item_code)).join(" + ") || "(none)"}`);
    p(`  ERP sofa money (sum unit*qty, sen): ${soMoney}`);
    p(`  owner's answer as a multiset: ${t.pieces.map((x) => K(x)).sort().join(" + ")}`);

    const bl = bookLines("SO", ac);
    p(`  ${bl.length} BOOK line(s):`);
    for (const l of bl) {
      p(`    dtl ${l.dtlKey} seq ${l.seq} item=${j(l.itemKey)} qty=${l.qty} unit=${l.unitPrice} desc2=${j(l.desc2)}`);
      if (/SOFA/i.test(String(l.itemKey))) {
        const d = parseSofa(String(l.desc2 ?? ""), t.model, false);
        p(`      the book DECODES to: ${(d.pieces || []).join(" + ") || "(unreadable)"} size=${j(d.size ?? null)} why=${j(d.why ?? [])}`);
      }
    }

    /* ── the purchase order the BOOK says came from this document ─────────── */
    const poHits = bookPoFor(ac, bl.map((l) => l.dtlKey));
    p(`  BOOK says the purchase side is: ${[...new Set(poHits.map((x) => x.docNo))].join(", ") || "(none)"}`);
    for (const x of poHits) p(`    PO ${x.docNo} dtl ${x.dtlKey} item=${j(x.itemKey)} fromDocNo=${j(x.fromDocNo)} fromSoDtlKey=${j(x.fromSoDtlKey)} byKey=${x.byKey} byDoc=${x.byDoc}`);

    for (const poAc of [...new Set(poHits.filter((x) => /SOFA/i.test(String(x.itemKey))).map((x) => x.docNo))]) {
      const poDoc = `HC-${poAc}`;
      p("");
      p(`  ── its purchase order ${poDoc} ──`);
      const [ph] = await sql`SELECT * FROM scm.purchase_orders
                              WHERE company_id = ${CO} AND (po_number = ${poDoc} OR linked_ac_docno = ${poAc}) LIMIT 1`;
      if (!ph) { p("    NOT IN THE ERP by number or AutoCount link"); continue; }
      p(`    header: po_number=${j(ph.po_number)} status=${j(ph.status)} linked_ac_docno=${j(ph.linked_ac_docno ?? null)}`);
      const pr = await sql`SELECT * FROM scm.purchase_order_items
                            WHERE purchase_order_id = ${ph.id} AND item_group = 'sofa' ORDER BY id`;
      let poMoney = 0;
      for (const r of pr) {
        poMoney += Number(r.unit_price_sen || 0) * Number(r.qty || 0);
        p(`    id=${r.id} code=${j(r.item_code)} qty=${r.qty} unit=${r.unit_price_sen} line_total=${r.line_total_sen} received=${r.received_qty}`);
        p(`      dtlkey=${j(r.linked_ac_dtlkey ?? null)} so_item_id=${j(r.so_item_id ?? null)} seat=${j(r.variants?.seatHeight ?? r.variants?.depth ?? null)}`);
        p(`      description2=${j(r.description2)}`);
        p(`      variants=${j(r.variants)}`);
        const [{ n }] = await sql`SELECT COUNT(*)::int n FROM scm.grn_items WHERE purchase_order_item_id = ${r.id}`;
        p(`      GRN lines hanging off it: ${n}`);
      }
      p(`    ERP sofa pieces held: ${pr.map((r) => compartmentOf(r.item_code)).join(" + ") || "(none)"}`);
      p(`    ERP sofa money (sum unit*qty, sen): ${poMoney}`);
      const pbl = bookLines("PO", poAc);
      for (const l of pbl.filter((x) => /SOFA/i.test(String(x.itemKey)))) {
        p(`    BOOK dtl ${l.dtlKey} item=${j(l.itemKey)} qty=${l.qty} unit=${l.unitPrice} desc2=${j(l.desc2)}`);
        const d = parseSofa(String(l.desc2 ?? ""), t.model, false);
        p(`      the book DECODES to: ${(d.pieces || []).join(" + ") || "(unreadable)"} size=${j(d.size ?? null)} why=${j(d.why ?? [])}`);
      }
      const mv = await sql`SELECT COUNT(*)::int n FROM scm.inventory_movements WHERE company_id = ${CO} AND source_doc_no = ${poDoc}`;
      p(`    inventory movements naming ${poDoc}: ${mv[0].n}`);
    }

    const mv = await sql`SELECT COUNT(*)::int n FROM scm.inventory_movements WHERE company_id = ${CO} AND source_doc_no = ${t.so}`;
    p(`  inventory movements naming ${t.so}: ${mv[0].n}`);
  }

  await sql.end();
}

main().catch(async (e) => { console.error(e); try { await sql.end(); } catch {} process.exit(1); });
