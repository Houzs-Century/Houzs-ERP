#!/usr/bin/env node
// AutoCount -> ERP DELTA SYNC: the documents that MOVED since the last import cut.
//
// WHY THIS EXISTS. Every AutoCount importer in this directory is INSERT-ONLY —
// `import-ac-outstanding-so.mjs:459` writes `ON CONFLICT (doc_no) DO NOTHING`
// and its own header says "items and payments are written only for a NEWLY
// inserted header". So a re-run brings in NEW documents and SILENTLY IGNORES
// every already-migrated document that CHANGED in AutoCount since the cut.
// Measured against the live book on 2026-09-07 with 2026-08-29 as the boundary:
// 117 SO created and 437 SO EDITED, 91/10 PO, 107/2 DO, 62/1 IV, 50/0 GR, 59/0 PI.
// The 437 are invisible to every tool the repo had.
//
// WHAT IT DOES, AND WHAT IT DELIBERATELY DELEGATES. This is a PLANNER first.
// A second copy of an import rule is this repo's most expensive recurring bug,
// so where a proven tool already owns a lane, this script COUNTS the lane and
// NAMES the tool rather than re-implementing it:
//
//   lane                                    owner
//   INSERT a new SO / PO                    import-ac-outstanding-so.mjs,
//                                           import-ac-outstanding-po.mjs,
//                                           import-ac-so-linked-pos.mjs
//   header remark2/3/4, note, dates         refresh-so-tail-from-book.mjs
//   bedframe variants (colour, geometry)    refresh-so-variants.mjs
//   sofa variants (colour, seat size)       backfill-sofa-variants-from-desc2.mjs
//   line photos                             import-so-line-photos.mjs
//   sofa COMPARTMENT changes                redecode-collapsed-sofa-lines.mjs /
//                                           apply-sofa-compartment-corrections.mjs
//
// It WRITES only the two lanes nothing owns — line `description2`, and the
// migrated payment/balance row — and it rebuilds the conversion links.
//
// COPY, NEVER COMPUTE. A migration reads AutoCount's own value; a value the
// book left blank stays blank in the ERP. Nothing here derives a figure: the
// money lane re-reads Sum(qty*unitprice) and UDF_BALANCE exactly as
// import-ac-outstanding-so.mjs read them at insert time.
//
// NEVER OVERWRITE A HUMAN. A document is REFUSED and listed, not written, when
// scm.mfg_so_audit_log shows a person changed a field in scope, or the header
// `version` has moved off 1, or a person owns its payment rows. "These N
// documents disagree and I did not touch them" is the intended outcome; a
// silent overwrite of the owner's own data is not.
//
// SOFA is decomposed only by the shared decoder lib/parse-sofa.mjs — never
// hand-parsed here — and compartment CHANGES are reported, never applied,
// because a changed compartment set changes the NUMBER of ERP lines.
//
// MODE=plan (default) | MODE=apply, and apply also needs
//   CONFIRM="SYNC AC DELTA"
// RE-RUN: convergent. A second run against the same snapshot re-reads the live
// rows, finds every difference already applied and writes nothing; the refusal
// list is recomputed from scratch each run and is never persisted.
//
//   node scripts/sync-ac-delta.mjs
//   MODE=apply CONFIRM="SYNC AC DELTA" node scripts/sync-ac-delta.mjs
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { parsePayment } from "./lib/ac-payment-udf.mjs";
import { SOFA_MODEL_ALIAS, parseSofa } from "./lib/parse-sofa.mjs";
import { buildFabricColourIndex } from "./lib/fabric-colour-match.mjs";
import { acFromSoDtlKey } from "./lib/ac-po-line.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const MODE = (process.env.MODE || "plan").toLowerCase();
if (!["plan", "apply"].includes(MODE)) { console.error(`MODE must be plan or apply, got ${MODE}`); process.exit(2); }
const APPLY = MODE === "apply";
if (APPLY && process.env.CONFIRM !== "SYNC AC DELTA") {
  console.error('MODE=apply needs CONFIRM="SYNC AC DELTA" — refusing.');
  process.exit(2);
}
const LANES = new Set((process.env.LANES || "desc,pay,links").split(",").map((s) => s.trim()).filter(Boolean));

const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8").replace(/^﻿/, ""));
const has = (f) => fs.existsSync(path.join(here, "data", f));
const txt = (v) => { const s = (v == null ? "" : String(v)).trim(); return s === "" ? null : s; };
const num = (v) => { const n = parseFloat(String(v ?? "").replace(/[^0-9.\-]/g, "")); return isFinite(n) ? n : 0; };
const centi = (v) => Math.round(num(v) * 100);
const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);

/* The needles refresh-so-tail-from-book.mjs uses, widened by the fields THIS
   script writes. One list, because a field this script may write is a field a
   human touching it must veto. */
const TOUCHED_NEEDLES = [
  "proceeded_at", "proceededAt", "processing_date", "processingDate", "internal_expected_dd",
  "Processing Date", "customer_delivery_date", "customerDeliveryDate",
  "remark2", "remark3", "remark4", "Remark 2", "Remark 3", "Remark 4",
  "sales_exemption_expiry", "salesExemptionExpiry", '"note"', "'note'",
  "description", "description2", "Description", "Desc2",
  "unit_price_sen", "total_sen", "balance_sen", "paid_sen", "deposit_sen",
  "payment", "payments", "item_code", "qty", "variants", "custom_specials",
].map((n) => `%${n}%`);

const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

async function main() {
  log(`mode=${MODE} lanes=${[...LANES].join(",") || "(none)"}`);

  // ─────────── snapshots ───────────
  if (!has("ac-doc-stamps.json.gz")) {
    console.error("data/ac-doc-stamps.json.gz missing — run: ONLY=stamps python scripts/export-ac-reimport.py");
    process.exit(2);
  }
  const S = gz("ac-doc-stamps.json.gz").rows;
  const soRows = gz("ac-outstanding-so.json.gz");
  const poRows = has("ac-outstanding-po.json.gz") ? gz("ac-outstanding-po.json.gz") : [];
  const poLinked = has("ac-so-linked-pos.json.gz") ? gz("ac-so-linked-pos.json.gz") : [];
  const photos = has("ac-photo-manifest.json.gz") ? gz("ac-photo-manifest.json.gz") : [];
  const ageDays = (Date.now() - Date.parse(String(S.exportedAt).replace(" ", "T"))) / 86400000;
  log(`stamps snapshot: since=${S.since} exported=${S.exportedAt} (${ageDays.toFixed(2)} days old)`);
  const MAX_AGE = Number(process.env.MAX_SNAPSHOT_AGE_DAYS || 2);
  if (!(ageDays >= 0) || ageDays > MAX_AGE) {
    console.error(`REFUSED: the AutoCount stamps snapshot is ${ageDays.toFixed(2)} days old (limit ${MAX_AGE}). Re-cut it before syncing a delta.`);
    process.exit(2);
  }

  // AutoCount line text, keyed by DtlKey — the only key that survives a
  // re-ordered document (line_no is not stable, DtlKey is).
  const acLineByDtl = new Map();
  for (const r of soRows) acLineByDtl.set(String(r.DtlKey), r);
  const acSoHeader = new Map();
  for (const r of soRows) if (!acSoHeader.has(r.DocNo)) acSoHeader.set(r.DocNo, r);
  const acSoLines = new Map();
  for (const r of soRows) { if (!acSoLines.has(r.DocNo)) acSoLines.set(r.DocNo, []); acSoLines.get(r.DocNo).push(r); }
  const photoByDtl = new Set(photos.map((p) => String(p.DtlKey)));

  // ─────────── production ───────────
  const soHeaders = await sql`
    SELECT doc_no, linked_ac_docno, version, status, local_total_sen, balance_sen, paid_sen
      FROM scm.mfg_sales_orders
     WHERE company_id = 1 AND linked_ac_docno IS NOT NULL`;
  const erpSoByAc = new Map(soHeaders.map((h) => [h.linked_ac_docno, h]));
  const soItems = await sql`
    SELECT i.id, i.doc_no, i.linked_ac_dtlkey, i.item_code, i.item_group,
           i.description, i.description2, i.variants, i.photo_urls, h.linked_ac_docno
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = 1 AND h.linked_ac_docno IS NOT NULL
       AND COALESCE(i.cancelled, false) = false`;
  const poHeaders = await sql`
    SELECT po_number, linked_ac_docno FROM scm.purchase_orders
     WHERE company_id = 1 AND linked_ac_docno IS NOT NULL`;
  const erpPoByAc = new Map(poHeaders.map((h) => [h.linked_ac_docno, h]));
  const poItems = await sql`
    SELECT i.id, i.linked_ac_dtlkey, i.item_code, i.description, i.description2, i.so_item_id,
           p.po_number, p.linked_ac_docno
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE p.company_id = 1 AND p.linked_ac_docno IS NOT NULL`;
  log(`ERP: SO ${soHeaders.length} headers / ${soItems.length} lines; PO ${poHeaders.length} headers / ${poItems.length} lines`);

  // who did a human touch?
  const allSoDocs = soHeaders.map((h) => h.doc_no);
  const touched = new Set();
  for (let i = 0; i < allSoDocs.length; i += 2000) {
    const rows = await sql`SELECT DISTINCT so_doc_no FROM scm.mfg_so_audit_log
       WHERE so_doc_no = ANY(${allSoDocs.slice(i, i + 2000)}) AND field_changes::text ILIKE ANY(${TOUCHED_NEEDLES})`;
    for (const r of rows) touched.add(r.so_doc_no);
  }
  const byAudit = touched.size;
  for (const h of soHeaders) if (Number(h.version) > 1) touched.add(h.doc_no);
  log(`ERP sales orders a person has edited: ${touched.size} (${byAudit} by audit trail, the rest by version > 1)`);

  const fcRows = await sql`SELECT fabric_id, colour_id, label FROM scm.fabric_colours WHERE company_id = 1`;
  const { findColour } = buildFabricColourIndex(fcRows);
  const knownColour = (c) => { const h = findColour(c); return h ? h.colour_id : null; };
  const codeSet = new Set((await sql`SELECT code FROM scm.mfg_products WHERE company_id = 1`).map((p) => p.code.toUpperCase()));

  // ─────────── 1. the census, per document type ───────────
  const census = [];
  const SCOPE = {
    SO: { erp: erpSoByAc, pop: new Set(soRows.map((r) => r.DocNo)), tool: "import-ac-outstanding-so.mjs (SOFA=1)" },
    PO: { erp: erpPoByAc, pop: new Set([...poRows, ...poLinked].map((r) => r.DocNo)), tool: "import-ac-outstanding-po.mjs + import-ac-so-linked-pos.mjs" },
  };
  const insertable = { SO: [], PO: [] };
  const outOfScope = { SO: [], PO: [] };
  for (const kind of ["SO", "PO", "DO", "IV", "GR", "PI"]) {
    const rows = S.stamps[kind] || [];
    const created = rows.filter((r) => r.Created && String(r.Created) >= S.since);
    const sc = SCOPE[kind];
    let inErp = 0, absent = 0, absentInPop = 0;
    for (const r of rows) {
      if (!sc) continue;
      if (sc.erp.has(r.DocNo)) inErp++;
      else { absent++; if (sc.pop.has(r.DocNo)) { absentInPop++; insertable[kind].push(r.DocNo); } else outOfScope[kind].push(r.DocNo); }
    }
    census.push({ kind, moved: rows.length, created: created.length, edited: rows.length - created.length, inErp: sc ? inErp : null, absent: sc ? absent : null, insertable: sc ? absentInPop : null });
  }
  log("");
  log(`DOCUMENTS THAT MOVED IN AUTOCOUNT SINCE ${S.since}`);
  log("type   moved  created  edited   in ERP   absent   importable");
  for (const c of census) {
    log(`${pad(c.kind, 5)}${rpad(c.moved, 7)}${rpad(c.created, 9)}${rpad(c.edited, 8)}${rpad(c.inErp ?? "-", 9)}${rpad(c.absent ?? "-", 9)}${rpad(c.insertable ?? "-", 13)}`);
  }
  log("");
  for (const k of ["SO", "PO"]) {
    log(`${k}: ${insertable[k].length} absent document(s) ARE in the importer population -> INSERT with ${SCOPE[k].tool}`);
    if (outOfScope[k].length) log(`${k}: ${outOfScope[k].length} absent document(s) are OUTSIDE that population (fully delivered / invoiced-direct / cancelled); no importer would take them: ${outOfScope[k].slice(0, 12).join(", ")}${outOfScope[k].length > 12 ? " ..." : ""}`);
  }

  // ─────────── 2. the SO update lane ───────────
  const editedSo = (S.stamps.SO || []).filter((r) => !(r.Created && String(r.Created) >= S.since) && erpSoByAc.has(r.DocNo));
  const soLinesByDoc = new Map();
  for (const it of soItems) { if (!soLinesByDoc.has(it.linked_ac_docno)) soLinesByDoc.set(it.linked_ac_docno, []); soLinesByDoc.get(it.linked_ac_docno).push(it); }

  const descUpdates = [];
  const conflicts = [];
  const sofaCompartment = [];
  const photoGap = [];
  const unkeyed = [];
  let noBookLines = 0;

  for (const st of editedSo) {
    const h = erpSoByAc.get(st.DocNo);
    const bookLines = acSoLines.get(st.DocNo);
    if (!bookLines) { noBookLines++; continue; }
    if (touched.has(h.doc_no)) { conflicts.push({ acDoc: st.DocNo, doc: h.doc_no, why: `a person edited this order in the ERP (audit trail, or version ${h.version})` }); continue; }
    const erpLines = soLinesByDoc.get(st.DocNo) || [];
    const keyed = erpLines.filter((l) => l.linked_ac_dtlkey != null);
    if (keyed.length !== erpLines.length) unkeyed.push({ acDoc: st.DocNo, doc: h.doc_no, n: erpLines.length - keyed.length });

    // SOFA: a changed COMPARTMENT SET changes the number of ERP lines. Never
    // applied here — reported, and the compartment tools own the repair.
    for (const bl of bookLines.filter((l) => /SOFA/i.test(l.ItemCode || ""))) {
      const erpSofa = erpLines.filter((l) => String(l.linked_ac_dtlkey) === String(bl.DtlKey) && l.item_group === "sofa");
      if (!erpSofa.length) continue;
      const base = (erpSofa[0].item_code || "").replace(/-[^-]*$/, "");
      const model = SOFA_MODEL_ALIAS[base] || base;
      const RECL = ["-1S(R)", "-1A(R)(LHF)", "-1A(P)(LHF)", "-1S(P)"];
      const reclOK = RECL.some((sfx) => codeSet.has((model + sfx).toUpperCase()));
      const ps = parseSofa(bl.Desc2, model, reclOK, { knownColour });
      if (ps.conf === "low" || !ps.pieces.length) continue;      // never guess
      const bookPieces = ps.pieces.map((c) => `${model}-${c}`.toUpperCase()).sort();
      const erpPieces = erpSofa.map((l) => (l.item_code || "").toUpperCase()).sort();
      if (JSON.stringify(bookPieces) !== JSON.stringify(erpPieces)) {
        sofaCompartment.push({ acDoc: st.DocNo, doc: h.doc_no, dtl: bl.DtlKey, erpPieces, bookPieces });
      }
    }

    // description2, keyed on DtlKey, verbatim from the book
    for (const l of keyed) {
      const bl = acLineByDtl.get(String(l.linked_ac_dtlkey));
      if (!bl) continue;
      const wantD2 = txt(bl.Desc2);
      const curD2 = txt(l.description2);
      // COPY, NEVER COMPUTE: a blank book value never erases an ERP value.
      if (wantD2 !== null && wantD2 !== curD2) descUpdates.push({ id: l.id, doc: h.doc_no, acDoc: st.DocNo, dtl: l.linked_ac_dtlkey, from: curD2, to: wantD2 });
      if (!photoByDtl.has(String(l.linked_ac_dtlkey)) && !(l.photo_urls && l.photo_urls.length)) photoGap.push({ acDoc: st.DocNo, dtl: l.linked_ac_dtlkey });
    }
  }

  log("");
  log("SALES ORDERS EDITED IN AUTOCOUNT AND ALREADY IN THE ERP");
  log(`  candidates                                   ${editedSo.length}`);
  log(`  no book lines in the outstanding snapshot    ${noBookLines}  (delivered/invoiced since — the DO lane, not this one)`);
  log(`  REFUSED, a person edited them in the ERP     ${conflicts.length}`);
  log(`  description2 differences to write            ${descUpdates.length} line(s) across ${new Set(descUpdates.map((u) => u.doc)).size} order(s)`);
  log(`  SOFA compartment sets that disagree          ${sofaCompartment.length}  (REPORTED, never applied)`);
  log(`  ERP lines with no AutoCount DtlKey           ${unkeyed.reduce((a, b) => a + b.n, 0)} across ${unkeyed.length} order(s)`);
  log(`  lines whose photo the manifest lacks         ${photoGap.length}`);

  if (conflicts.length) {
    log("");
    log("CONFLICTS — AutoCount moved AND a person edited the ERP order. NOT TOUCHED:");
    for (const c of conflicts.slice(0, 60)) log(`   ${c.doc}  (${c.acDoc})  ${c.why}`);
    if (conflicts.length > 60) log(`   ... and ${conflicts.length - 60} more`);
  }
  if (sofaCompartment.length) {
    log("");
    log("SOFA COMPARTMENTS — the book now says a different piece set. Never guessed here;");
    log("run redecode-collapsed-sofa-lines.mjs / apply-sofa-compartment-corrections.mjs:");
    for (const s of sofaCompartment.slice(0, 30)) log(`   ${s.doc} dtl=${s.dtl}  ERP[${s.erpPieces.join(" + ")}]  BOOK[${s.bookPieces.join(" + ")}]`);
    if (sofaCompartment.length > 30) log(`   ... and ${sofaCompartment.length - 30} more`);
  }
  for (const u of descUpdates.slice(0, 15)) log(`   desc2 ${u.doc} dtl=${u.dtl}: ${JSON.stringify(u.from)} -> ${JSON.stringify(u.to)}`);

  // ─────────── 3. the payment / balance lane ───────────
  const payUpdates = [];
  const payConflicts = [];
  {
    const docs = editedSo.filter((st) => !touched.has(erpSoByAc.get(st.DocNo).doc_no)).map((st) => erpSoByAc.get(st.DocNo).doc_no);
    const pays = docs.length
      ? await sql`SELECT id, so_doc_no, method, amount_sen, note FROM scm.mfg_sales_order_payments WHERE so_doc_no = ANY(${docs}) AND company_id = 1`
      : [];
    const byDoc = new Map();
    for (const p of pays) { if (!byDoc.has(p.so_doc_no)) byDoc.set(p.so_doc_no, []); byDoc.get(p.so_doc_no).push(p); }
    for (const st of editedSo) {
      const h = erpSoByAc.get(st.DocNo);
      if (touched.has(h.doc_no)) continue;
      const bh = acSoHeader.get(st.DocNo);
      const lines = acSoLines.get(st.DocNo);
      if (!bh || !lines) continue;
      // the book's OWN figures, exactly as import-ac-outstanding-so.mjs reads them
      const total = lines.reduce((a, l) => a + centi(l.UnitPrice) * (Math.round(num(l.Qty)) || 1), 0);
      const bal = centi(bh.UDF_BALANCE);
      const paid = Math.max(0, total - bal);
      if (Number(h.local_total_sen) === total && Number(h.balance_sen) === bal && Number(h.paid_sen) === paid) continue;
      const rows = byDoc.get(h.doc_no) || [];
      const migrated = rows.filter((p) => p.method === "imported" && /^imported from AutoCount/.test(p.note || ""));
      if (rows.length !== migrated.length || migrated.length > 1) {
        payConflicts.push({ doc: h.doc_no, acDoc: st.DocNo, why: `${rows.length} payment row(s), ${migrated.length} of them the migration's — a person owns this order's money` });
        continue;
      }
      const pay = parsePayment(bh.UDF_PAYEMENT);
      payUpdates.push({ doc: h.doc_no, acDoc: st.DocNo, total, bal, paid, appr: pay.appr || null, acct: pay.acct || null,
        payId: migrated[0] ? migrated[0].id : null,
        was: { total: Number(h.local_total_sen), bal: Number(h.balance_sen), paid: Number(h.paid_sen) } });
    }
  }
  log("");
  log("PAYMENT / BALANCE");
  log(`  orders whose book money moved                ${payUpdates.length}`);
  log(`  REFUSED, a person owns the payment rows      ${payConflicts.length}`);
  for (const p of payUpdates.slice(0, 15)) log(`   ${p.doc}: total ${p.was.total} -> ${p.total}, balance ${p.was.bal} -> ${p.bal}, paid ${p.was.paid} -> ${p.paid}`);
  for (const p of payConflicts.slice(0, 20)) log(`   REFUSED ${p.doc}: ${p.why}`);

  // ─────────── 4. the transaction links ───────────
  //  PODTL carries FromSODtlKey + FromDocNo; FromDocType is NULL even on real
  //  production POs (verified PO-010163 <- SO-013423), so it is never read.
  //  DO/IV/GR/PI conversions DO carry FromDocType on their detail rows.
  const soItemByDtl = new Map(soItems.filter((i) => i.linked_ac_dtlkey != null).map((i) => [String(i.linked_ac_dtlkey), i]));
  const poItemByDtl = new Map(poItems.filter((i) => i.linked_ac_dtlkey != null).map((i) => [String(i.linked_ac_dtlkey), i]));
  const claimed = new Set(poItems.filter((i) => i.so_item_id).map((i) => String(i.so_item_id)));
  const linkPlan = [];
  const linkMissing = [];
  for (const e of S.edges.PO || []) {
    const key = acFromSoDtlKey(e);
    if (key == null) continue;
    const pi = poItemByDtl.get(String(e.DtlKey));
    const si = soItemByDtl.get(String(key));
    if (!pi) { linkMissing.push({ po: e.DocNo, why: "the PO line is not in the ERP yet (import it first)" }); continue; }
    if (!si) { linkMissing.push({ po: e.DocNo, why: `the SO line ${key} (${e.FromDocNo}) is not in the ERP` }); continue; }
    if (pi.so_item_id) continue;
    if (claimed.has(String(si.id))) { linkMissing.push({ po: e.DocNo, why: `SO line ${key} is already dedicated to another PO line` }); continue; }
    claimed.add(String(si.id));
    linkPlan.push({ poItemId: pi.id, soItemId: si.id, poNo: pi.po_number, soNo: e.FromDocNo });
  }
  /* The conversion CHAIN, measured rather than assumed. On the 2026-09-07 cut
     the delta's own edges say: DO comes from SO, IV comes from **DO**, GR comes
     from PO, PI comes from **GR**. So resolving an IV or a PI straight against
     the sales/purchase order tables answers a question nobody asked — the
     source has to be walked back one hop first, through the DO/GR edges in this
     same snapshot. A hop this snapshot cannot make (the parent predates SINCE)
     is reported as UNTRACEABLE, never as absent. */
  const parentOf = {};
  for (const kind of ["DO", "GR"]) {
    const m = new Map();
    for (const e of S.edges[kind] || []) { const f = txt(e.FromDocNo); if (f && !m.has(e.DocNo)) m.set(e.DocNo, { type: e.FromDocType, doc: f }); }
    // the export's chain-closure rows: parents older than SINCE, so absent above
    for (const e of (S.closure && S.closure[kind]) || []) { const f = txt(e.FromDocNo); if (f && !m.has(e.DocNo)) m.set(e.DocNo, { type: e.FromDocType, doc: f }); }
    parentOf[kind] = m;
  }
  const inErp = (type, docNo) => (type === "PO" ? erpPoByAc.has(docNo) : type === "SO" ? erpSoByAc.has(docNo) : null);
  const convByType = {};
  for (const kind of ["DO", "IV", "GR", "PI"]) {
    const edges = (S.edges[kind] || []).filter((e) => txt(e.FromDocNo));
    const bySrc = new Map();
    for (const e of edges) { const k = `${e.FromDocType}|${e.FromDocNo}`; if (!bySrc.has(k)) bySrc.set(k, new Set()); bySrc.get(k).add(e.DocNo); }
    let known = 0, unknown = 0, untraceable = 0;
    const unknownList = [];
    for (const [k] of bySrc) {
      let [t, n] = k.split("|");
      let hops = 0;
      while (inErp(t, n) === null && hops < 3) {                 // walk DO -> SO, GR -> PO
        const p = (parentOf[t] || new Map()).get(n);
        if (!p) { t = null; break; }
        t = p.type; n = p.doc; hops++;
      }
      if (t === null || inErp(t, n) === null) { untraceable++; continue; }
      if (inErp(t, n)) known++; else { unknown++; unknownList.push(`${t} ${n}`); }
    }
    convByType[kind] = { docs: new Set(edges.map((e) => e.DocNo)).size, sources: bySrc.size, from: [...new Set(edges.map((e) => e.FromDocType))].join("/"), known, unknown, untraceable, unknownList };
  }
  log("");
  log("TRANSACTION LINKS");
  log(`  PO lines that name an SO line (FromSODtlKey) ${(S.edges.PO || []).filter((e) => acFromSoDtlKey(e) != null).length}`);
  log(`  SO->PO dedications this run would write      ${linkPlan.length}`);
  log(`  SO->PO edges that cannot be linked yet       ${linkMissing.length}`);
  for (const m of linkMissing.slice(0, 10)) log(`   ${m.po}: ${m.why}`);
  log("  conversions on the delta documents (the source is walked back to an SO or a PO):");
  for (const k of ["DO", "IV", "GR", "PI"]) {
    const c = convByType[k];
    log(`   ${pad(k, 3)} ${rpad(c.docs, 4)} doc(s) raised from ${rpad(c.sources, 4)} ${pad(c.from, 3)} source(s) — ${c.known} resolve to a document the ERP has, ${c.unknown} to one it does not, ${c.untraceable} untraceable from this snapshot`);
    if (c.unknownList.length) log(`       not in the ERP: ${c.unknownList.slice(0, 8).join(", ")}${c.unknownList.length > 8 ? ` ... (+${c.unknownList.length - 8})` : ""}`);
  }

  if (!APPLY) {
    log("");
    log('PLAN ONLY — no writes. MODE=apply CONFIRM="SYNC AC DELTA" writes the desc2, payment and link lanes.');
    log("The INSERT lane is NOT this script's: run the importers named above.");
    await sql.end();
    return;
  }

  // ─────────── apply ───────────
  let nDesc = 0, nPay = 0, nLink = 0;
  if (LANES.has("desc")) {
    for (let i = 0; i < descUpdates.length; i += 300) {
      const b = descUpdates.slice(i, i + 300);
      await sql.begin(async (tx) => {
        for (const u of b) {
          const r = await tx`UPDATE scm.mfg_sales_order_items SET description2 = ${u.to}
                              WHERE id = ${u.id} AND company_id = 1 RETURNING id`;
          nDesc += r.length;
        }
      });
    }
    log(`description2 written: ${nDesc} of ${descUpdates.length} intended`);
  }
  if (LANES.has("pay")) {
    for (let i = 0; i < payUpdates.length; i += 200) {
      const b = payUpdates.slice(i, i + 200);
      await sql.begin(async (tx) => {
        for (const u of b) {
          const r = await tx`UPDATE scm.mfg_sales_orders
              SET local_total_sen = ${u.total}, balance_sen = ${u.bal}, paid_sen = ${u.paid}, deposit_sen = ${u.paid}
            WHERE doc_no = ${u.doc} AND company_id = 1 RETURNING doc_no`;
          nPay += r.length;
          if (u.payId) await tx`UPDATE scm.mfg_sales_order_payments
              SET amount_sen = ${u.paid}, approval_code = ${u.appr}, account_sheet = ${u.acct}
            WHERE id = ${u.payId}`;
        }
      });
    }
    log(`payment/balance written: ${nPay} of ${payUpdates.length} intended`);
  }
  if (LANES.has("links")) {
    for (let i = 0; i < linkPlan.length; i += 300) {
      const b = linkPlan.slice(i, i + 300);
      await sql.begin(async (tx) => {
        for (const u of b) {
          // never steal: only claim an SO line no other PO line holds
          const r = await tx`UPDATE scm.purchase_order_items SET so_item_id = ${u.soItemId}
                              WHERE id = ${u.poItemId} AND so_item_id IS NULL
                                AND NOT EXISTS (SELECT 1 FROM scm.purchase_order_items x WHERE x.so_item_id = ${u.soItemId})
                              RETURNING id`;
          nLink += r.length;
        }
      });
    }
    log(`SO->PO dedications written: ${nLink} of ${linkPlan.length} intended`);
  }

  /* ── verification: a FRESH connection, and it asserts the SHAPE ──
     A row count answers "did a row change", never "does the row now hold what
     I meant". Every sample is re-read on a connection this run has not used. */
  const v = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  let bad = 0;
  for (const u of descUpdates.slice(0, 5)) {
    const [row] = await v`SELECT description2, linked_ac_dtlkey, jsonb_typeof(COALESCE(variants,'{}'::jsonb)) AS vt FROM scm.mfg_sales_order_items WHERE id = ${u.id}`;
    if (!row || txt(row.description2) !== u.to || String(row.linked_ac_dtlkey) !== String(u.dtl) || row.vt !== "object") { bad++; log(`   VERIFY MISMATCH line ${u.id}`); }
  }
  for (const u of payUpdates.slice(0, 5)) {
    const [row] = await v`SELECT local_total_sen t, balance_sen b, paid_sen p FROM scm.mfg_sales_orders WHERE doc_no = ${u.doc} AND company_id = 1`;
    if (!row || Number(row.t) !== u.total || Number(row.b) !== u.bal || Number(row.p) !== u.paid || Number(row.t) - Number(row.b) !== Number(row.p)) { bad++; log(`   VERIFY MISMATCH ${u.doc}`); }
  }
  for (const u of linkPlan.slice(0, 5)) {
    const [row] = await v`SELECT i.so_item_id, s.doc_no, s.item_code FROM scm.purchase_order_items i
        LEFT JOIN scm.mfg_sales_order_items s ON s.id = i.so_item_id WHERE i.id = ${u.poItemId}`;
    if (!row || String(row.so_item_id) !== String(u.soItemId) || !row.doc_no || !row.item_code) { bad++; log(`   VERIFY MISMATCH po line ${u.poItemId}`); }
  }
  if (bad) { log(`VERIFY FAILED on ${bad} sample(s)`); await v.end(); await sql.end(); process.exit(1); }
  log(`VERIFY (fresh connection): ${Math.min(5, descUpdates.length)} line(s), ${Math.min(5, payUpdates.length)} order(s) and ${Math.min(5, linkPlan.length)} dedication(s) re-read with the shape intended.`);
  await v.end();
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
