#!/usr/bin/env node
/* diag-pi-line-provenance — READ-ONLY. For named purchase invoices, print our
 * own line, the RECEIPT LINE it was built from, and the book's own source line,
 * so the cause of a difference can be checked by a person instead of inferred.
 *
 * ── WHY IT EXISTS ──────────────────────────────────────────────────────────
 * The purchase-invoice tally locks 20 documents on `transfer from` and 8 more
 * on the specification axes (colour / divan / gap / leg / T.Heights). Both
 * findings name a value and stop there, and both have the SAME candidate
 * explanation that nobody had measured: a migrated invoice line is a COPY of a
 * goods-receipt line (create-migrated-invoices.mjs writes `l._row.variants`,
 * `l._row.description2` and `l._row.item_code` straight off the receipt), so a
 * blank on the invoice is a blank on the receipt, and a link the book cannot
 * confirm is a receipt LINE the cutover never carried.
 *
 * Nobody had printed the receipt side beside the invoice side, so every
 * proposal on these documents was going to be a guess about which of the two
 * was wrong. This prints all three sides and DECIDES NOTHING.
 *
 * ── IT MEASURES NOTHING AND MUST NEVER LEARN HOW ───────────────────────────
 * check-ac-erp-reconcile.mjs is the only thing in this repo that says whether a
 * book value and an ERP value differ. A second opinion about "different" is the
 * failure of docs/bugs/0689 and docs/bugs/0708. This dumps rows. There is no
 * comparison here, no verdict, and no MODE=apply.
 *
 * ── READ-ONLY IS PINNED AT THE CONNECTION ──────────────────────────────────
 * `default_transaction_read_only` is set on the session, so the SERVER refuses
 * a write rather than this file merely promising not to make one. Every read is
 * bounded by the named documents and by the documents the BOOK names as their
 * source; there is no table scan.
 *
 * RE-RUN: identical output for the same snapshots and the same ERP state. It
 * writes nothing, so a second run changes nothing.
 *
 * Env: DATABASE_URL (required)   COMPANY_ID (default 1)
 *      PI_DOCS  comma-separated AutoCount purchase-invoice numbers. Required:
 *               there is no default population, because a diagnostic that
 *               invents its own scope answers a question nobody asked.
 *      MAX_SNAPSHOT_AGE_DAYS (default 2)
 */
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const here = path.dirname(fileURLToPath(import.meta.url));
const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const MAXAGE = Number(process.env.MAX_SNAPSHOT_AGE_DAYS || 2);
const DOCS = String(process.env.PI_DOCS || "").split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
if (!DOCS.length) { console.error("REFUSED: PI_DOCS is empty. Name the invoices to explain."); process.exit(2); }

const say = (m) => console.log(m);

function loadSnap(file, label) {
  const p = path.join(here, "data", file);
  if (!fs.existsSync(p)) { console.error(`REFUSED: ${file} is not in the tree`); process.exit(3); }
  const s = JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString("utf8"));
  const age = (Date.now() - new Date(s.exported_at).getTime()) / 86400000;
  if (!(age <= MAXAGE)) {
    console.error(`REFUSED: ${label} is ${age.toFixed(1)} days old (limit ${MAXAGE})`);
    process.exit(3);
  }
  say(`${label}: cut ${s.exported_at} (${age.toFixed(2)} days old)`);
  return s;
}
const edges = loadSnap("ac-convert-edges.json.gz", "the chain snapshot");
const xfer = loadSnap("ac-doc-transfer.json.gz", "the line-graph snapshot");
const truth = loadSnap("ac-reconcile-truth.json.gz", "the book snapshot");

/* child line key -> the source line key the book itself names */
const SOURCE_OF = new Map();
for (const e of xfer.edges) SOURCE_OF.set(String(e[3]), String(e[1]));

const L = Object.fromEntries(edges.line_fields.map((n, i) => [n, i]));
/* the book's PI lines for the named documents, and its GR lines by key */
const bookPi = new Map();
for (const r of edges.types.PI?.lines || []) {
  const doc = String(r[L.docNo]).toUpperCase();
  if (!DOCS.includes(doc)) continue;
  if (!bookPi.has(doc)) bookPi.set(doc, []);
  bookPi.get(doc).push({
    dtlKey: String(r[L.dtlKey]), seq: r[L.seq], itemKey: r[L.itemKey], qty: r[L.qty],
    fromDocType: r[L.fromDocType] || "", fromDocNo: r[L.fromDocNo] || "",
    srcLineKey: SOURCE_OF.get(String(r[L.dtlKey])) || "",
  });
}
const bookGrByKey = new Map();
const bookGrDocLines = new Map();
for (const r of edges.types.GR?.lines || []) {
  const rec = { docNo: String(r[L.docNo]), dtlKey: String(r[L.dtlKey]), itemKey: r[L.itemKey], qty: r[L.qty] };
  bookGrByKey.set(rec.dtlKey, rec);
  if (!bookGrDocLines.has(rec.docNo)) bookGrDocLines.set(rec.docNo, []);
  bookGrDocLines.get(rec.docNo).push(rec);
}
const desc2 = {};
for (const t of ["PI", "GR"]) {
  const idx = Object.fromEntries(truth.desc2_fields.map((n, i) => [n, i]));
  const m = new Map();
  for (const r of truth.types[t]?.desc2 || []) m.set(String(r[idx.dtlKey]), r[idx.desc2]);
  desc2[t] = m;
}

const sql = postgres(DST, {
  ssl: "require", prepare: false, max: 1,
  connection: { default_transaction_read_only: "on" },
});

const srcGrDocs = [...new Set([...bookPi.values()].flat()
  .map((l) => (l.srcLineKey ? bookGrByKey.get(l.srcLineKey)?.docNo : null))
  .filter(Boolean))];
const srcGrKeys = [...new Set([...bookPi.values()].flat().map((l) => l.srcLineKey).filter(Boolean))];

async function main() {
  say(`company ${CO} · ${DOCS.length} invoice(s) named · book source receipts: ${srcGrDocs.length}`);

  /* OUR invoice lines, and the RECEIPT LINE each one was built from. */
  const mine = await sql`
    SELECT h.linked_ac_docno AS ac_no, h.invoice_number AS erp_no,
           i.id::text AS id, i.item_code, i.qty::float8 AS qty,
           i.linked_ac_dtlkey::text AS line_key, i.item_group,
           i.description2, i.variants, i.custom_specials,
           i.grn_item_id::text AS grn_item_id,
           gi.item_code AS gr_item_code, gi.description2 AS gr_description2,
           gi.variants AS gr_variants, gi.linked_ac_dtlkey::text AS gr_line_key,
           g.grn_number AS gr_erp_no, g.status AS gr_status,
           g.linked_ac_gr_docno AS gr_ac_no, p.linked_ac_docno AS po_ac_no
      FROM scm.purchase_invoice_items i
      JOIN scm.purchase_invoices h ON h.id = i.purchase_invoice_id
      LEFT JOIN scm.grn_items gi ON gi.id = i.grn_item_id
      LEFT JOIN scm.grns g ON g.id = gi.grn_id
      LEFT JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
     WHERE h.company_id = ${CO} AND h.linked_ac_docno = ANY(${DOCS})
     ORDER BY h.linked_ac_docno, i.created_at, i.id`;

  /* Do we hold the receipts the BOOK names as the source — in ANY status? */
  const heldGr = srcGrDocs.length ? await sql`
    SELECT g.linked_ac_gr_docno AS ac_no, g.grn_number AS erp_no, g.status,
           COUNT(i.id)::int AS lines,
           COUNT(i.linked_ac_dtlkey)::int AS keyed
      FROM scm.grns g LEFT JOIN scm.grn_items i ON i.grn_id = g.id
     WHERE g.company_id = ${CO} AND g.linked_ac_gr_docno = ANY(${srcGrDocs})
     GROUP BY 1, 2, 3 ORDER BY 1` : [];

  /* Does ANY receipt line carry the source line key the book names? */
  const heldKeys = srcGrKeys.length ? await sql`
    SELECT i.linked_ac_dtlkey::text AS line_key, i.item_code,
           g.grn_number AS erp_no, g.status, g.linked_ac_gr_docno AS ac_no
      FROM scm.grn_items i JOIN scm.grns g ON g.id = i.grn_id
     WHERE g.company_id = ${CO} AND i.linked_ac_dtlkey::text = ANY(${srcGrKeys})` : [];
  const keyHeld = new Map(heldKeys.map((r) => [r.line_key, r]));
  const grHeld = new Map(heldGr.map((r) => [String(r.ac_no).toUpperCase(), r]));

  say("");
  say("═════════ DO WE HOLD THE RECEIPT THE BOOK RAISED THE INVOICE FROM? ═════════");
  let noDoc = 0, noLine = 0, held = 0;
  for (const d of srcGrDocs.slice().sort()) {
    const h = grHeld.get(d.toUpperCase());
    const bookLines = (bookGrDocLines.get(d) || []).length;
    if (!h) { noDoc++; say(`   ${d}: NO ERP receipt carries this AutoCount receipt number (book has ${bookLines} line(s))`); continue; }
    held++;
    say(`   ${d}: ERP ${h.erp_no} [${h.status}] ${h.lines} line(s), ${h.keyed} keyed (book has ${bookLines} line(s))`);
  }
  say("");
  say("═════════ AND THE SOURCE LINE ITSELF? ═════════");
  for (const k of srcGrKeys.slice().sort()) {
    const r = keyHeld.get(k);
    const b = bookGrByKey.get(k);
    if (!r) { noLine++; say(`   line ${k} (book ${b?.docNo ?? "?"} ${b?.itemKey ?? "?"}): NO ERP receipt line carries it`); continue; }
    say(`   line ${k} (book ${b?.docNo ?? "?"} ${b?.itemKey ?? "?"}): ERP ${r.erp_no} [${r.status}] ${r.item_code}`);
  }
  say("");
  say(`SOURCE RECEIPTS: ${held} held, ${noDoc} not held, of ${srcGrDocs.length}`);
  say(`SOURCE LINES: ${srcGrKeys.length - noLine} held, ${noLine} not held, of ${srcGrKeys.length}`);

  say("");
  say("═════════ OUR LINE, ITS RECEIPT LINE, AND THE BOOK'S ═════════");
  for (const d of DOCS) {
    const rows = mine.filter((r) => String(r.ac_no).toUpperCase() === d);
    const bl = bookPi.get(d) || [];
    say("");
    say(`--- ${d} (ERP ${rows[0]?.erp_no ?? "NO ERP ROWS"}) — book ${bl.length} line(s), ERP ${rows.length} row(s) ---`);
    for (const b of bl) {
      const src = b.srcLineKey ? bookGrByKey.get(b.srcLineKey) : null;
      say(`  BOOK dtl=${b.dtlKey} item=${b.itemKey} qty=${b.qty} from=${b.fromDocType} ${b.fromDocNo}`
        + ` srcline=${b.srcLineKey || "-"}${src ? ` (${src.docNo} ${src.itemKey})` : ""}`);
      say(`       d2=${JSON.stringify(String(desc2.PI.get(b.dtlKey) ?? ""))}`);
      if (src) say(`       src d2=${JSON.stringify(String(desc2.GR.get(src.dtlKey) ?? ""))}`);
    }
    for (const r of rows) {
      say(`  ERP  key=${r.line_key ?? "NONE"} item=${r.item_code} qty=${r.qty} grp=${r.item_group ?? "-"}`);
      say(`       variants=${JSON.stringify(r.variants)} custom_specials=${JSON.stringify(r.custom_specials)}`);
      say(`       d2=${JSON.stringify(String(r.description2 ?? ""))}  id=${r.id}`);
      if (!r.grn_item_id) { say(`       receipt line: NONE (grn_item_id is null)`); continue; }
      say(`       receipt line: ${r.gr_erp_no} [${r.gr_status}] ac=${r.gr_ac_no ?? "(unlinked)"} po=${r.po_ac_no ?? "-"}`
        + ` key=${r.gr_line_key ?? "NONE"} item=${r.gr_item_code}`);
      say(`         gr variants=${JSON.stringify(r.gr_variants)}`);
      say(`         gr d2=${JSON.stringify(String(r.gr_description2 ?? ""))}`);
    }
  }
  await sql.end({ timeout: 5 });
}
main().catch(async (e) => { console.error(e); try { await sql.end({ timeout: 5 }); } catch { /* closing */ } process.exit(1); });
