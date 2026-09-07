#!/usr/bin/env node
// LINE-LEVEL top-up for the migrated AutoCount SALES orders — the SO twin of
// topup-ac-po-lines.mjs, and it exists for the same structural reason.
//
// WHY THIS EXISTS. import-ac-outstanding-so.mjs is idempotent at DOCUMENT
// level: it collects the doc_nos already in the ERP and filters them out whole
// (`const todo = built.filter((o) => !existing.has(o.docNo))`, :421), and its
// own header says "items and payments are written only for a NEWLY inserted
// header". So a line that a run did not carry can NEVER arrive later — the next
// run reports the document as already imported and writes nothing.
//
// It bites hardest on GIVE-AWAY lines. The owner's rule is that the book's
// entitlement appears on our document even when no money moves:
// HC-SO-012128 carries 4 x HOK-SQUARE PILLOW at RM 0.00 marked
// "FOR CONPESSANTION WRONG ITEM DELIVERY" — the customer is owed four pillows
// for a wrong delivery — and the ERP had no pillow line at all.
//
// THE MATCH IS EXACT, NEVER FUZZY. Both sides carry AutoCount's own DtlKey:
// the export has `DtlKey` per line and the importer writes it to
// `linked_ac_dtlkey` (its ICOLS list, :430). A book line whose DtlKey appears
// on NO row of that ERP document is missing; anything else is not this
// script's business. Where a decomposed sofa line became several ERP rows they
// all carry the SAME DtlKey, so the test still answers correctly.
//
// AND IT IS ALL-OR-NOTHING PER DOCUMENT. A document holding ANY line with a
// NULL linked_ac_dtlkey cannot be judged — the key is nullable (migration 0273)
// and backfill-ac-line-keys.mjs cannot always reach one — so such a document is
// REPORTED and left alone. Under-repair, never duplicate: that is the same rule
// topup-ac-po-lines.mjs bought with 183 near-duplicates.
//
// ── WHAT IT WRITES, AND WHY THE LINE IT REFUSES IS REFUSED ──────────────────
//
// ONLY a missing line at UNIT PRICE 0, and only in a non-variant group.
//
//   PRICE. The header carries `local_total_sen`, `balance_sen`, `paid_sen` and
//   the five category buckets, all computed by the importer as Sum(qty x
//   unitprice) over the lines it wrote. Inserting a PRICED line makes the
//   header disagree with its own lines and breaks the payment reconcile, so a
//   priced missing line is REPORTED for an owner decision, never written. A
//   zero-priced line is money-neutral by construction: every one of those sums
//   moves by exactly 0. `line_count` is the one header column that does move,
//   and it is bumped in the same transaction.
//
//   GROUP. A sofa line must be decomposed into compartments and a bedframe line
//   parsed into gap / divan / leg / colour. Those decoders live in
//   import-ac-outstanding-so.mjs and lib/parse-sofa.mjs, and a second copy of an
//   import rule is this repo's most expensive recurring bug. A missing sofa or
//   bedframe line is REPORTED with the tool that owns it, never re-decoded here.
//
// Every value written is the book's own: item code from the binding CSV, qty
// and price from the export, description from the ERP product master (what a
// picker-selected line stores), location and warehouse from the line's own
// Location through the same table backfill-so-line-warehouse.mjs uses.
//
// DRY-RUN by default — and the dry run IS the census the pattern question
// needs. APPLY=1 plus CONFIRM="I HAVE REVIEWED THE DRY-RUN" writes.
//
// RE-RUN: a second run finds every line it wrote already carrying its
// AutoCount DtlKey, so it matches nothing and writes nothing. The apply path
// re-reads the document's live keys INSIDE the transaction as well, so even two
// runs racing each other cannot double a line.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const CONFIRM_PHRASE = "I HAVE REVIEWED THE DRY-RUN";
const CO = Number(process.env.COMPANY_ID ?? 1);
const TOP = Number(process.env.TOP ?? 60);
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`APPLY=1 requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}
const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");
const num = (v) => { const n = parseFloat(String(v ?? "").replace(/[^0-9.\-]/g, "")); return isFinite(n) ? n : 0; };
const centi = (v) => Math.round(num(v) * 100);

/* Byte-identical to import-ac-outstanding-so.mjs:68/71/78. Copied deliberately
   and named as copies: they are three small literals, and importing them would
   mean exporting three constants out of a 480-line one-shot importer. If that
   file's tables ever change, this comment is the pointer back. */
const CATG = { MATTRESS: "mattress", BEDFRAME: "bedframe", ACC: "accessory", ACCESSORY: "accessory", BEDLINES: "accessory", DIFFUSER: "others", CARPET: "others", DINING: "others", OTHER: "others", SERVICE: "service", TRANS: "service", SOFA: "sofa" };
const C1_ALIAS = { "SVC-DELIVERY": "TRANSPORTATION CHARGES", "SVC-DELIVERY-ADD": "TRANSPORTATION CHARGES", "SVC-DELIVERY-CROSS": "TRANSPORTATION CHARGES" };
const uomOf = (g) => (g === "bedframe" ? "SET" : "UNIT");
/* The SO-LINE location table, identical to backfill-so-line-warehouse.mjs:65 —
   which is the tool that owns a migrated SO line's warehouse, so this must be
   its table and not one of the other three. It carries the four selling
   branches and NOT the display / service locations, and that is measured, not
   assumed: 0 of the 14,041 lines in ac-outstanding-so.json.gz sit at a DISP
   location (2026-09-08). A showroom has never been a sales location. */
const SO_LINE_LOC = { KL: "KL WAREHOUSE", PG: "PG WAREHOUSE", SRW: "SRW WAREHOUSE", SBH: "SBH WAREHOUSE" };
/* AutoCount hands DtlKey back through an ODBC driver, a JSON dump and a gzip;
   the ERP column is a bigint the pg driver may return as a string. Compare them
   as canonical decimal strings so "4711", 4711 and "4711.0" are one key. */
const keyOf = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).trim().replace(/\.0+$/, "");
  return /^-?\d+$/.test(s) ? s : null;
};
/* The two groups whose lines carry a decoded variant. Named here so the refusal
   below reads as a rule and not as a pair of magic strings. */
const VARIANT_GROUPS = new Set(["sofa", "bedframe"]);

function parseCsvLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; }
  }
  out.push(cur); return out;
}

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}; company=${CO}`);

  const rows = JSON.parse(zlib.gunzipSync(
    fs.readFileSync(path.join(here, "data", "ac-outstanding-so.json.gz"))).toString("utf8").replace(/^﻿/, ""));
  log(`AutoCount outstanding lines in the export: ${rows.length} across ${new Set(rows.map((r) => r.DocNo)).size} documents`);

  const csv = fs.readFileSync(path.join(here, "data", "autocount-erp-mapping-1561.csv"), "utf8")
    .replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  csv.shift();
  const byAc = new Map();
  for (const f of csv.map(parseCsvLine)) if (f[0]) byAc.set(norm(f[0]), { erp: (f[1] || "").trim(), cat: (f[3] || "").trim().toUpperCase() });

  const products = await sql`SELECT code, name FROM scm.mfg_products WHERE company_id = ${CO}`;
  const prodByCode = new Map(products.map((p) => [norm(p.code), p]));
  const whRows = await sql`SELECT id, code, name FROM scm.warehouses WHERE company_id = ${CO}`;
  const whByKey = new Map();
  for (const w of whRows) { whByKey.set(norm(w.code), w.id); whByKey.set(norm(w.name), w.id); }
  const whId = (loc) => whByKey.get(norm(SO_LINE_LOC[norm(loc)] ?? loc)) ?? whByKey.get(norm(loc)) ?? null;

  /* ── The ERP side: every migrated document and every key it holds ───────── */
  const erpDocs = await sql`SELECT doc_no, linked_ac_docno, line_count
      FROM scm.mfg_sales_orders
     WHERE company_id = ${CO} AND linked_ac_docno IS NOT NULL`;
  const erpItems = await sql`SELECT i.doc_no, i.linked_ac_dtlkey, i.item_code, i.line_no
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`;
  log(`ERP migrated sales orders: ${erpDocs.length}; their lines: ${erpItems.length}`);

  const keysByDoc = new Map();     // ERP doc_no -> Set of linked_ac_dtlkey (as string)
  const nullKeyByDoc = new Map();  // ERP doc_no -> how many lines carry NO key
  const maxLineNo = new Map();
  for (const r of erpItems) {
    if (!keysByDoc.has(r.doc_no)) { keysByDoc.set(r.doc_no, new Set()); nullKeyByDoc.set(r.doc_no, 0); maxLineNo.set(r.doc_no, 0); }
    const k = keyOf(r.linked_ac_dtlkey);
    if (k === null) nullKeyByDoc.set(r.doc_no, nullKeyByDoc.get(r.doc_no) + 1);
    else keysByDoc.get(r.doc_no).add(k);
    maxLineNo.set(r.doc_no, Math.max(maxLineNo.get(r.doc_no), Number(r.line_no ?? 0)));
  }
  const erpByAcDoc = new Map(erpDocs.map((d) => [String(d.linked_ac_docno), d]));

  /* ── The book side, grouped by document ─────────────────────────────────── */
  const bookByDoc = new Map();
  for (const r of rows) {
    if (!bookByDoc.has(r.DocNo)) bookByDoc.set(r.DocNo, []);
    bookByDoc.get(r.DocNo).push(r);
  }

  const missing = [];          // book lines with no ERP row
  const unjudgeable = [];      // documents holding a keyless ERP line
  let docsCompared = 0, docsNotInErp = 0;
  for (const [acDoc, ls] of bookByDoc) {
    const erp = erpByAcDoc.get(acDoc);
    if (!erp) { docsNotInErp++; continue; }
    if ((nullKeyByDoc.get(erp.doc_no) ?? 0) > 0) {
      unjudgeable.push({ doc: erp.doc_no, acDoc, keyless: nullKeyByDoc.get(erp.doc_no), lines: ls.length });
      continue;
    }
    docsCompared++;
    const have = keysByDoc.get(erp.doc_no) ?? new Set();
    for (const l of ls) {
      const k = keyOf(l.DtlKey);
      if (k === null) continue;
      if (have.has(k)) continue;
      const hit = byAc.get(norm(l.ItemCode));
      let erpCode = hit ? hit.erp : null;
      if (erpCode && !prodByCode.has(norm(erpCode)) && C1_ALIAS[norm(erpCode)]) erpCode = C1_ALIAS[norm(erpCode)];
      const grp = (hit && CATG[hit.cat]) || "others";
      missing.push({
        doc: erp.doc_no, acDoc, dtlkey: k, ac: norm(l.ItemCode) || "(blank)",
        erpCode, grp, qty: Math.round(num(l.Qty)), upSen: centi(l.UnitPrice),
        desc: String(l.Description ?? ""), d2: String(l.Desc2 ?? ""),
        loc: l.Location ?? null, deliv: l.DeliveryDate ?? null,
        hasProduct: !!(erpCode && prodByCode.has(norm(erpCode))),
      });
    }
  }

  log("");
  log(`documents compared line by line: ${docsCompared}; in the book but not in the ERP (a different lane — import-ac-outstanding-so.mjs owns it): ${docsNotInErp}; UNJUDGEABLE because an ERP line carries no linked_ac_dtlkey: ${unjudgeable.length}`);
  for (const u of unjudgeable.slice(0, 15)) log(`   UNJUDGEABLE ${u.doc} (AC ${u.acDoc}) — ${u.keyless} ERP line(s) with no AutoCount key; run backfill-ac-line-keys.mjs first`);
  if (unjudgeable.length > 15) log(`   ... and ${unjudgeable.length - 15} more`);

  /* ── The census. This is the answer to "is it a PATTERN". ───────────────── */
  const free = missing.filter((m) => m.upSen === 0);
  const priced = missing.filter((m) => m.upSen > 0);
  const freeUnits = free.reduce((s, m) => s + m.qty, 0);
  log("");
  log(`BOOK LINES WITH NO ERP ROW: ${missing.length} across ${new Set(missing.map((m) => m.doc)).size} documents`);
  log(`  at RM 0.00 (GIVE-AWAY / entitlement — money-neutral to add): ${free.length} lines / ${freeUnits} units of goods`);
  log(`  priced above RM 0.00: ${priced.length} lines, RM ${(priced.reduce((s, m) => s + m.upSen * m.qty, 0) / 100).toFixed(2)} — REPORTED, never written: adding one moves the header total and breaks the payment reconcile`);
  const byGroup = new Map();
  for (const m of free) byGroup.set(m.grp, (byGroup.get(m.grp) ?? 0) + 1);
  log(`  the zero-priced ones by item group: ${[...byGroup].map(([g, n]) => `${g} ${n}`).join(", ") || "(none)"}`);

  const writable = free.filter((m) => !VARIANT_GROUPS.has(m.grp) && m.hasProduct && m.qty > 0);
  const refusedVariant = free.filter((m) => VARIANT_GROUPS.has(m.grp));
  const refusedNoProduct = free.filter((m) => !VARIANT_GROUPS.has(m.grp) && !m.hasProduct);
  const refusedZeroQty = free.filter((m) => !VARIANT_GROUPS.has(m.grp) && m.hasProduct && m.qty <= 0);

  log("");
  log(`TO WRITE: ${writable.length} line(s) / ${writable.reduce((s, m) => s + m.qty, 0)} units, all at RM 0.00`);
  for (const m of writable.slice(0, TOP)) log(`   + ${m.doc} (AC ${m.acDoc}) ${m.erpCode} x${m.qty} [${m.grp}] @ ${m.loc ?? "no location"} — "${m.d2.replace(/\s+/g, " ").slice(0, 60)}"`);
  if (writable.length > TOP) log(`   ... and ${writable.length - TOP} more`);
  log(`REFUSED — sofa / bedframe (their variant decoding is owned by import-ac-outstanding-so.mjs + lib/parse-sofa.mjs; re-decoding here would be a second copy of an import rule): ${refusedVariant.length}`);
  for (const m of refusedVariant.slice(0, 20)) log(`   REFUSED ${m.doc} ${m.ac} x${m.qty} [${m.grp}] — "${m.d2.replace(/\s+/g, " ").slice(0, 60)}"`);
  log(`REFUSED — no ERP product for the binding target: ${refusedNoProduct.length}`);
  for (const m of refusedNoProduct.slice(0, 20)) log(`   REFUSED ${m.doc} ${m.ac} -> ${m.erpCode ?? "(unmapped)"} — the code is not in mfg_products; bind it first, never invent a product`);
  log(`REFUSED — the book records quantity 0 (a zero-quantity zero-priced row is an annotation, and `+
      `"Math.round(num(l.Qty)) || 1" is exactly the bug that once made seven of them ONE unit of goods): ${refusedZeroQty.length}`);
  log("");
  log(`PRICED misses, for the owner (max ${TOP}):`);
  for (const m of priced.slice(0, TOP)) log(`   PRICED ${m.doc} (AC ${m.acDoc}) ${m.ac} x${m.qty} @ RM ${(m.upSen / 100).toFixed(2)} = RM ${(m.upSen * m.qty / 100).toFixed(2)} [${m.grp}]`);
  if (priced.length > TOP) log(`   ... and ${priced.length - TOP} more`);

  if (!APPLY) { log(""); log(`DRY-RUN — re-run with APPLY=1 CONFIRM="${CONFIRM_PHRASE}" to write.`); await sql.end(); return; }
  if (writable.length === 0) { log("nothing to write."); await sql.end(); return; }

  /* ── Write ───────────────────────────────────────────────────────────────
     One transaction per document, so a document is either wholly topped up or
     untouched. `line_count` is bumped by the number of rows actually inserted;
     no money column is touched, because every line written is RM 0.00 and every
     one of them moves the header's sums by exactly zero. */
  const byDoc = new Map();
  for (const m of writable) {
    if (!byDoc.has(m.doc)) byDoc.set(m.doc, []);
    byDoc.get(m.doc).push(m);
  }
  let wrote = 0, docs = 0;
  for (const [doc, ms] of byDoc) {
    await sql.begin(async (tx) => {
      /* Re-read INSIDE the transaction. The census above was taken before the
         first insert of this run; a document topped up by a concurrent run
         would otherwise be doubled. */
      const live = await tx`SELECT linked_ac_dtlkey, line_no
          FROM scm.mfg_sales_order_items WHERE doc_no = ${doc}`;
      const held = new Set(live.map((r) => keyOf(r.linked_ac_dtlkey)).filter((x) => x !== null));
      let lineNo = live.reduce((a, r) => Math.max(a, Number(r.line_no ?? 0)), 0);
      let n = 0;
      for (const m of ms) {
        if (held.has(m.dtlkey)) continue;
        lineNo += 1;
        const prod = prodByCode.get(norm(m.erpCode));
        await tx`INSERT INTO scm.mfg_sales_order_items
            (doc_no, line_no, item_group, item_code, description, description2, uom,
             location, warehouse_id, qty, unit_price_sen, total_sen, balance_sen,
             company_id, remark, line_delivery_date, linked_ac_dtlkey)
          VALUES (${doc}, ${lineNo}, ${m.grp}, ${prod.code}, ${(prod.name ?? m.desc) || prod.code},
             ${m.d2 || null}, ${uomOf(m.grp)}, ${m.loc}, ${whId(m.loc)}, ${m.qty}, 0, 0, 0,
             ${CO}, ${"topped up from AutoCount: the book carries this line at RM 0.00 and the migrated document did not"},
             ${m.deliv ? String(m.deliv).slice(0, 10) : null}, ${m.dtlkey})`;
        n += 1;
      }
      if (n > 0) await tx`UPDATE scm.mfg_sales_orders SET line_count = COALESCE(line_count,0) + ${n} WHERE doc_no = ${doc}`;
      wrote += n;
      if (n > 0) docs += 1;
    });
  }
  log(`DONE. lines written: ${wrote} across ${docs} document(s). No money column moved — every line is RM 0.00.`);

  /* ── VERIFY ON A FRESH CONNECTION ────────────────────────────────────────
     The session that wrote is the worst witness that the write landed. A row
     COUNT is not a shape either: what has to be true is that each written line
     now sits on its document at qty and price the BOOK's, with the AutoCount
     key on it, and that the document's money did NOT move. Both are asserted. */
  await sql.end();
  const check = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  let good = 0; const wrong = [];
  for (const m of writable) {
    const [row] = await check`SELECT i.item_code, i.qty, i.unit_price_sen, i.total_sen, i.item_group,
        i.warehouse_id, h.local_total_sen, h.line_count,
        (SELECT COALESCE(SUM(x.total_sen),0) FROM scm.mfg_sales_order_items x WHERE x.doc_no = h.doc_no) lines_sen
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
       WHERE i.doc_no = ${m.doc} AND i.linked_ac_dtlkey = ${m.dtlkey}`;
    if (!row) { wrong.push(`${m.doc} ${m.erpCode}: the line is NOT there`); continue; }
    const faults = [];
    if (norm(row.item_code) !== norm(m.erpCode)) faults.push(`item_code ${row.item_code} != ${m.erpCode}`);
    if (Number(row.qty) !== m.qty) faults.push(`qty ${row.qty} != ${m.qty}`);
    if (Number(row.unit_price_sen) !== 0 || Number(row.total_sen) !== 0) faults.push(`money moved: unit ${row.unit_price_sen}, total ${row.total_sen}`);
    if (Number(row.lines_sen) !== Number(row.local_total_sen)) faults.push(`header total ${row.local_total_sen} no longer equals the sum of its lines ${row.lines_sen}`);
    if (faults.length) wrong.push(`${m.doc} ${m.erpCode}: ${faults.join("; ")}`); else good += 1;
  }
  log(`VERIFIED ON A FRESH CONNECTION: ${good} line(s) read back with the book's item, quantity and RM 0.00, and their document's total still equals the sum of its lines.`);
  for (const w of wrong) log(`   WRONG SHAPE ${w}`);
  await check.end();
  if (wrong.length) { log("Some rows did not read back as written — do NOT run this again until that is understood."); process.exitCode = 1; }
  log("A sales-order line is demand: run the allocation recompute so the new lines get a stock verdict.");
}
main().catch((e) => { console.error(e); process.exit(1); });
