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
// It WRITES only the lanes nothing else owns — line `description2`, the
// migrated payment/balance row, and the three CONVERSION lanes below.
//
// THE THREE CONVERSION LANES (added 2026-09-07, #3047 measured them and wrote
// nothing). A conversion creates a CHILD document; the parent HEADER's stamp
// need not move at all, so the stamps delta above is blind to them by
// construction and the parent-side signal is the LINE's TransferedQty, which
// lives in ac-reconcile-truth.json.gz. Section 5 reads it and now also plans:
//
//   recv  copy PODTL.TransferedQty onto the matching ERP purchase-order line's
//         received_qty. Matched on linked_ac_dtlkey ONLY, and refused where
//         there is none. NEVER writes a value LOWER than the ERP already holds
//         (0 lines are over-received corpus-wide, so a decrease would mean the
//         MATCH is wrong, not the book), and NEVER above the ordered quantity.
//         GrQty is not read anywhere: it is AGGREGATED on (DocNo + ItemCode)
//         and reading it per line is what once put 65 migrated lines into
//         production with received_qty > qty.
//   do    create the delivery documents for the orders AutoCount has delivered
//         and the ERP does not reflect. The matcher and the writer are
//         lib/migrated-do-writer.mjs, SHARED with create-migrated-documents.mjs
//         — only the SOURCE differs (the truth snapshot instead of the cutover
//         cut, because the cutover cut cannot see a delivery raised after it).
//         Every document carries migrated_no_stock = true and posts NO
//         inventory movement: the units already came out through the AutoCount
//         balance snapshot, so a second deduction double-counts them. The
//         verification asserts that against scm.inventory_movements.
//   dedi  write so_item_id on the ERP purchase-order line from
//         PODTL.FromSODtlKey. FromDocType is NULL on all 10,792 SO->PO lines in
//         the live book, so it is never read — measured, not assumed.
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
// THE THREE CONVERSION LANES USE THE AUDIT TRAIL ALONE for that test, and
// deliberately NOT `version > 1`: version is an optimistic-locking token bumped
// by seven automated paths, and the probe in #3042 found 80 of 81 such
// "conflicts" were the automated stock-allocation sweep and exactly ONE was a
// person. On the purchase-order side the trail is scm.entity_audit_log
// (entity_type = 'PURCHASE_ORDER', migration 0139), matched on the fields these
// lanes would write and nothing else.
//
// SOFA is decomposed only by the shared decoder lib/parse-sofa.mjs — never
// hand-parsed here — and compartment CHANGES are reported, never applied,
// because a changed compartment set changes the NUMBER of ERP lines.
//
// MODE=plan (default) | MODE=apply, and apply also needs
//   CONFIRM="SYNC AC DELTA"
// RE-RUN: convergent. A second run against the same snapshot re-reads the live
// rows, finds every difference already applied and writes nothing; the refusal
// list is recomputed from scratch each run and is never persisted. The three
// conversion lanes converge the same way and for the same reason: `recv` plans
// only lines where the ERP is BELOW the book, so a written line no longer
// qualifies; `dedi` plans only lines whose so_item_id is NULL; `do` skips every
// AutoCount delivery the ERP already mirrors (linked_ac_docno), so a second run
// creates nothing and cannot duplicate a delivery note.
//
// LANES=desc,pay,links,recv,do,dedi (all of them by default).
// DO_SCOPE=since (default) | all — which unreflected deliveries lane `do`
// writes; the plan prints both counts either way.
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
/* The delivery-document matcher and writer, shared with
   create-migrated-documents.mjs. The rule has ONE home (see that file and
   docs/bugs/0043) and this lane feeds it a different SOURCE, never a copy. */
import {
  buildMigratedDoPlan, insertMigratedDo, loadAcErpItemMap, migratedDoNumber,
} from "./lib/migrated-do-writer.mjs";
import {
  SO_HEADER_LEGACY_PAYLOAD_KEYS,
  SO_PROCESSING_DATE_COLUMN,
  SO_PROCESSING_DATE_LEGACY_COLUMNS,
  SO_PROCESSING_DATE_PAYLOAD_KEY,
  soProcessingDateFragment,
} from "./lib/so-processing-date.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const MODE = (process.env.MODE || "plan").toLowerCase();
if (!["plan", "apply"].includes(MODE)) { console.error(`MODE must be plan or apply, got ${MODE}`); process.exit(2); }
const APPLY = MODE === "apply";
if (APPLY && process.env.CONFIRM !== "SYNC AC DELTA") {
  console.error('MODE=apply needs CONFIRM="SYNC AC DELTA" — refusing.');
  process.exit(2);
}
const LANES = new Set((process.env.LANES || "desc,pay,links,recv,do,dedi").split(",").map((s) => s.trim()).filter(Boolean));
/* DO_SCOPE picks WHICH unreflected deliveries lane `do` writes.
   since (default) = only the ones AutoCount raised on or after the day we
     took our copy of the order. Those are the conversions the ERP has not
     caught up with, and they are the owner's actual question.
   all             = those PLUS the ones already delivered BEFORE we copied
     the order. That absence is a DECISION, not a gap
     (check-ac-erp-reconcile.mjs says so), so writing it needs someone to
     ask for it by name. The plan prints both counts either way. */
const DO_SCOPE = (process.env.DO_SCOPE || "since").toLowerCase();
if (!["since", "all"].includes(DO_SCOPE)) { console.error(`DO_SCOPE must be since or all, got ${DO_SCOPE}`); process.exit(2); }
/* The migration's own actor, same value create-migrated-documents.mjs uses. */
const SYS_USER = "00000000-0000-4000-8000-000000000001";
const CO = 1;

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
  "proceeded_at", "proceededAt",
  SO_PROCESSING_DATE_COLUMN, SO_PROCESSING_DATE_PAYLOAD_KEY,
  ...SO_PROCESSING_DATE_LEGACY_COLUMNS,
  ...Object.keys(SO_HEADER_LEGACY_PAYLOAD_KEYS),
  "Processing Date", "customer_delivery_date", "customerDeliveryDate",
  "remark2", "remark3", "remark4", "Remark 2", "Remark 3", "Remark 4",
  "sales_exemption_expiry", "salesExemptionExpiry", '"note"', "'note'",
  "description", "description2", "Description", "Desc2",
  "unit_price_sen", "total_sen", "balance_sen", "paid_sen", "deposit_sen",
  "payment", "payments", "item_code", "qty", "variants", "custom_specials",
].map((n) => `%${n}%`);

const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const PDATE = soProcessingDateFragment(sql);

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
  /* A slightly NEGATIVE age is clock skew between the exporting desktop and
     this runner, not a forged snapshot; an hour of it is tolerated. Anything
     further into the future is refused, because the age is the only thing
     standing between a delta apply and a stale picture of the book. The export
     writes a timezone-aware stamp now — a naive local one read as +8h here and
     refused a snapshot cut twenty minutes earlier. */
  const SKEW = 1 / 24;
  if (!(ageDays >= -SKEW) || ageDays > MAX_AGE) {
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
    SELECT doc_no, linked_ac_docno, version, status, local_total_sen, balance_sen, paid_sen,
           created_at, (${PDATE} IS NOT NULL) AS proceeded
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
    SELECT po_number, linked_ac_docno, created_at FROM scm.purchase_orders
     WHERE company_id = 1 AND linked_ac_docno IS NOT NULL`;
  const erpPoByAc = new Map(poHeaders.map((h) => [h.linked_ac_docno, h]));
  const poItems = await sql`
    SELECT i.id, i.linked_ac_dtlkey, i.item_code, i.description, i.description2, i.so_item_id,
           i.qty::float8 AS qty, COALESCE(i.received_qty, 0)::float8 AS received_qty,
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
  /* THE THREE CONVERSION LANES TEST AUTHORSHIP ON THE AUDIT TRAIL ALONE.
     `touched` below also folds in `version > 1`, and that is NOT an
     authorship signal: version is an optimistic-locking token bumped by
     seven automated paths, and the probe in #3042 found 80 of 81 such
     "conflicts" were the automated stock-allocation sweep and exactly ONE
     was a person. Folding it in here would refuse ~79 orders in the name of
     a human who never touched them, and hide the one who did. */
  const touchedByAudit = new Set(touched);
  for (const h of soHeaders) if (Number(h.version) > 1) touched.add(h.doc_no);
  log(`ERP sales orders a person has edited: ${touched.size} (${byAudit} by audit trail, the rest by version > 1)`);

  /* The PURCHASE-ORDER side of the same question. Sales orders have their own
     table (scm.mfg_so_audit_log); every other SCM document records into
     scm.entity_audit_log keyed (entity_type, entity_id) with the human
     document number alongside (migration 0139). The needles are the fields
     THIS script would write on a purchase-order line, and nothing else - a
     person who renamed the supplier has not vetoed a received quantity. */
  const PO_TOUCHED_NEEDLES = ["received_qty", "receivedQty", "so_item_id", "soItemId"].map((n) => `%${n}%`);
  const allPoDocs = poHeaders.map((h) => h.po_number);
  const poTouched = new Set();
  for (let i = 0; i < allPoDocs.length; i += 2000) {
    const rows = await sql`SELECT DISTINCT entity_doc_no FROM scm.entity_audit_log
       WHERE entity_type = 'PURCHASE_ORDER' AND entity_doc_no = ANY(${allPoDocs.slice(i, i + 2000)})
         AND field_changes::text ILIKE ANY(${PO_TOUCHED_NEEDLES})`;
    for (const r of rows) poTouched.add(r.entity_doc_no);
  }
  log(`ERP purchase orders a person has edited in the fields this script writes: ${poTouched.size} (audit trail only)`);

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

  // ─────────── 5. CONVERSIONS ON THE ALREADY-MIGRATED POPULATION ───────────
  /* WHY THIS SECTION EXISTS, AND WHY SECTIONS 2-3 CANNOT ANSWER IT.
     A conversion creates a CHILD document. The PARENT header's stamp need not
     move at all — what moves is the parent LINE's TransferedQty. Measured on
     the 2026-09-07 stamps cut (since=2026-08-29): of the 115 purchase orders a
     goods receipt was raised from, 110 do NOT appear in stamps.PO; of the 166
     sales orders a delivery was raised from, 60 do NOT appear in stamps.SO. So
     every lane above that iterates `editedSo` — description2, sofa
     compartments, payment/balance — is blind to them by construction, and the
     conversion census in section 4 only asks whether the SOURCE is in the ERP,
     never whether the ERP reflects the CHILD.

     The parent-side signal is TransferedQty, and it lives in the committed
     ac-reconcile-truth.json.gz (every header and every line of all six types,
     no filtering). This section reads that, joins it to the ERP, and reports
     four cases. It WRITES NOTHING: a delivery, a receipt or a changed variant
     is repaired by the tool that owns that lane, and a second copy of an import
     rule is this repo's most expensive recurring bug. */
  /* The three conversion WRITE PLANS. Declared out here because section 5
     computes them and the apply block below consumes them; when the truth
     snapshot is missing or stale they stay empty and their lanes write
     nothing, which is the same refusal the report makes. */
  const recvPlan = [], recvRefused = [], recvNotes = [];
  const dediPlan = [], dediRefused = [];
  let doPlan = [];
  const doRefused = [], doNotes = [];
  const doDebtor = new Map();
  const TRUTH = "ac-reconcile-truth.json.gz";
  log("");
  if (!has(TRUTH)) {
    log(`CONVERSIONS: data/${TRUTH} is missing — run scripts/export-ac-reconcile-truth.mjs. Section skipped.`);
  } else {
    const T = gz(TRUTH);
    const tAge = (Date.now() - Date.parse(T.exported_at)) / 86400000;
    log(`CONVERSIONS ON THE ALREADY-MIGRATED POPULATION  (truth snapshot ${T.exported_at}, ${tAge.toFixed(2)} days old)`);
    if (!(tAge >= -SKEW) || tAge > MAX_AGE) {
      log(`  REFUSED: that snapshot is ${tAge.toFixed(2)} days old (limit ${MAX_AGE}). Re-cut it with scripts/export-ac-reconcile-truth.mjs before believing a number here.`);
    } else {
      const LFD = T.line_fields, HFD = T.header_fields, DFD = T.desc2_fields;
      const F = {
        doc: LFD.indexOf("docNo"), dtl: LFD.indexOf("dtlKey"), qty: LFD.indexOf("qty"),
        itemKey: LFD.indexOf("itemKey"), hasCode: LFD.indexOf("hasCode"),
        tq: LFD.indexOf("transferedQty"), fdt: LFD.indexOf("fromDocType"),
        fdn: LFD.indexOf("fromDocNo"), fsk: LFD.indexOf("fromSoDtlKey"),
      };
      const HDOC = HFD.indexOf("docNo"), HCAN = HFD.indexOf("cancelled"), HDATE = HFD.indexOf("docDate");
      const D2K = DFD.indexOf("dtlKey"), D2V = DFD.indexOf("desc2");
      const cell = (r, i) => (i < 0 ? null : txt(r[i]));
      /* A child document dated on or after the day we took our copy of the
         parent is a conversion that happened SINCE the migration — the owner's
         actual question. One dated before it is history the owner already
         decided not to import (check-ac-erp-reconcile.mjs calls that absence a
         DECISION, not a gap), so the two must never be added together. */
      const docDateOf = (kind) => {
        const m = new Map();
        for (const h of T.types[kind].headers || []) { const d = cell(h, HDOC); if (d) m.set(d, cell(h, HDATE)); }
        return m;
      };
      const day = (v) => (v == null ? null : String(v instanceof Date ? v.toISOString() : v).slice(0, 10));
      const raisedSince = (childDates, kids, erpCreatedAt) => {
        const cut = day(erpCreatedAt);
        if (!cut) return null;
        return kids.some((k) => { const d = day(childDates.get(k)); return d != null && d >= cut; });
      };
      /* Desc2 travels through an export, a gzip and an import. A difference that
         survives whitespace and quote normalisation is a REAL build change; one
         that does not is the round trip, and reporting the two as one number
         would hand the owner 202 "changed variants" when most are a curly quote. */
      const flatten = (v) => (v == null ? null : String(v)
        .replace(/[\u2018\u2019\u02BC\u2032\u00B4`]/g, "'")
        .replace(/[\u201C\u201D\u2033]/g, '"')
        .replace(/\s+/g, " ").trim());
      const cancelledSet = (kind) =>
        new Set((T.types[kind].headers || []).filter((h) => cell(h, HCAN) === "T").map((h) => cell(h, HDOC)));
      const soCancelled = cancelledSet("SO"), poCancelled = cancelledSet("PO");

      const enumerate = (title, arr) => {
        log(`  ${title} — first ${Math.min(20, arr.length)} of ${arr.length}:`);
        log("  ```enumeration");
        for (const x of arr.slice(0, 20)) log(`  ${x}`);
        if (arr.length > 20) log(`  ... and ${arr.length - 20} more`);
        log("  ```");
      };

      // ── the ERP's downstream documents, read once ──
      const erpDo = await sql`SELECT do_number, linked_ac_docno, so_doc_no, status, migrated_no_stock
                                FROM scm.delivery_orders WHERE company_id = 1`;
      const erpGrn = await sql`SELECT grn_number, linked_ac_docno, migrated_no_stock
                                 FROM scm.grns WHERE company_id = 1`;
      const erpDoByAc = new Set(erpDo.filter((d) => d.linked_ac_docno).map((d) => String(d.linked_ac_docno).trim()));
      const erpDoBySo = new Map();
      for (const d of erpDo) {
        if (!d.so_doc_no || String(d.status || "").toUpperCase() === "CANCELLED") continue;
        if (!erpDoBySo.has(d.so_doc_no)) erpDoBySo.set(d.so_doc_no, []);
        erpDoBySo.get(d.so_doc_no).push(d.do_number);
      }
      const erpGrnByAc = new Set(erpGrn.filter((g) => g.linked_ac_docno).map((g) => String(g.linked_ac_docno).trim()));
      log(`  ERP mirrors: ${erpDo.length} delivery order(s), ${erpDoByAc.size} of them carrying an AutoCount DO number; ${erpGrn.length} GRN(s), ${erpGrnByAc.size} carrying an AutoCount GR number`);

      // ══ CASE 1 — SO -> DO ══
      const doChildrenOfSo = new Map();
      for (const r of T.types.DO.lines) {
        if (cell(r, F.fdt) !== "SO") continue;
        const parent = cell(r, F.fdn); if (!parent) continue;
        if (!doChildrenOfSo.has(parent)) doChildrenOfSo.set(parent, new Set());
        doChildrenOfSo.get(parent).add(cell(r, F.doc));
      }
      const soAgg = new Map();
      for (const r of T.types.SO.lines) {
        const d = cell(r, F.doc); if (!d) continue;
        let e = soAgg.get(d); if (!e) { e = { qty: 0, tq: 0 }; soAgg.set(d, e); }
        e.qty += num(r[F.qty]); e.tq += num(r[F.tq]);
      }
      const doDate = docDateOf("DO");
      const c1 = { full: [], part: [], mirrored: 0, nativeOnly: [], gapFull: [], gapPart: [], gapDocs: [], gaps: [],
                   sinceFull: [], sincePart: [], beforeMigration: [], undated: [] };
      for (const [acNo, h] of erpSoByAc) {
        if (soCancelled.has(acNo)) continue;
        const a = soAgg.get(acNo);
        if (!a || a.tq <= 0) continue;
        const whole = a.tq >= a.qty;
        (whole ? c1.full : c1.part).push(acNo);
        const kids = [...(doChildrenOfSo.get(acNo) || [])];
        if (kids.some((k) => erpDoByAc.has(k))) { c1.mirrored++; continue; }
        if (erpDoBySo.has(h.doc_no)) {
          c1.nativeOnly.push(`${h.doc_no} (${acNo}) — ERP delivery ${erpDoBySo.get(h.doc_no).join("/")} carries no AutoCount DO number`);
          continue;
        }
        c1.gapDocs.push(acNo);
        const since = raisedSince(doDate, kids, h.created_at);
        c1.gaps.push({ acNo, doc: h.doc_no, whole, kids, since, tq: a.tq, qty: a.qty });
        const row = `${h.doc_no} (${acNo}) ${a.tq}/${a.qty} unit(s) delivered in the book${kids.length ? `, AutoCount ${kids.slice(0, 3).join("/")} dated ${kids.map((k) => day(doDate.get(k))).filter(Boolean).slice(0, 3).join("/") || "?"}` : ", no DO line names it"}, ERP copy taken ${day(h.created_at) || "?"}`;
        (whole ? c1.gapFull : c1.gapPart).push(row);
        if (since === null) c1.undated.push(row);
        else if (since) (whole ? c1.sinceFull : c1.sincePart).push(row);
        else c1.beforeMigration.push(row);
      }
      log("");
      log("CASE 1 — SALES ORDERS THE BOOK HAS DELIVERED (SO -> DO)");
      log(`  migrated sales orders in the ERP                          ${erpSoByAc.size}`);
      log(`  ... AutoCount now shows FULLY delivered                   ${c1.full.length}`);
      log(`  ... AutoCount now shows PARTLY delivered                  ${c1.part.length}`);
      log(`  the ERP mirrors an AutoCount delivery for it              ${c1.mirrored}`);
      log(`  the ERP has a delivery of its own, unlinked to the book   ${c1.nativeOnly.length}`);
      log(`  the ERP DOES NOT REFLECT it — fully delivered in the book ${c1.gapFull.length}`);
      log(`  the ERP DOES NOT REFLECT it — partly delivered            ${c1.gapPart.length}`);
  log("  ── of those gaps, split by WHEN the delivery was raised ──");
      log(`  delivered SINCE we took our copy, fully  -> ACT ON THESE          ${c1.sinceFull.length}`);
      log(`  delivered SINCE we took our copy, partly -> ACT ON THESE          ${c1.sincePart.length}`);
      log(`  already delivered BEFORE we copied it (the owner's DECISION)      ${c1.beforeMigration.length}`);
      log(`  cannot be dated from this snapshot                                ${c1.undated.length}`);
      if (c1.sinceFull.length) enumerate("CASE 1, delivered SINCE the migration, FULLY", c1.sinceFull);
      if (c1.sincePart.length) enumerate("CASE 1, delivered SINCE the migration, PARTLY", c1.sincePart);
      if (c1.beforeMigration.length) enumerate("CASE 1, delivered BEFORE the migration (not a gap)", c1.beforeMigration);
      if (c1.nativeOnly.length) enumerate("CASE 1, ERP-native delivery with no AutoCount number", c1.nativeOnly);

      // == LANE do - THE DELIVERIES THE ERP DOES NOT REFLECT ==
      /* THE SOURCE IS THE TRUTH SNAPSHOT, NOT THE CUTOVER CUT. The DO writer
         create-migrated-documents.mjs owns reads data/ac-partial-dos.json.gz -
         the partial deliveries against orders that were still open when the
         migration was taken. It cannot see a delivery raised afterwards, which
         is the whole population here: measured 2026-09-07, the committed
         fidelity DO snapshot is 307 documents behind the live book while the
         truth snapshot this section already reads is current. So the SOURCE
         differs and the RULE does not - the matcher and the writer are
         lib/migrated-do-writer.mjs, shared with that script.

         WHAT THE TRUTH PROJECTION CANNOT GIVE, and what happens instead:
         DODTL carries FromDocType + FromDocNo but NO FromDtlKey (see
         export-ac-reconcile-truth.mjs: only PODTL is exported with
         fromSoDtlKey), so a delivery line names its parent DOCUMENT and never
         its parent LINE. The matcher's item-code + sofa-model walk is therefore
         the only way across, exactly as it is for the cutover cut. The
         projection also has no line Description and no debtor: those stay blank
         and the debtor falls back to the sales order's own.

         ALL OR NOTHING, PER DOCUMENT. One book line that does not resolve
         refuses the WHOLE delivery note. A half-written delivery is
         indistinguishable from a real partial one and would let the rest ship
         twice; under-repair, never duplicate. */
      const doCancelled = cancelledSet("DO");
      const erpDoNumbers = new Set(erpDo.map((d) => d.do_number));
      const doLinesByDoc = new Map();
      for (const r of T.types.DO.lines) {
        const d = cell(r, F.doc); if (!d) continue;
        if (!doLinesByDoc.has(d)) doLinesByDoc.set(d, []);
        doLinesByDoc.get(d).push(r);
      }
      const doGapScope = c1.gaps.filter((g) => (DO_SCOPE === "all" ? true : g.since === true));
      const gapAcNos = [...new Set(doGapScope.map((g) => g.acNo))];
      const gapDocNos = [...new Set(doGapScope.map((g) => g.doc))];
      /* item_group / variants / description2 / the money are pulled because a
         DELIVERY ORDER IS A SNAPSHOT OF THE SALES ORDER AT DISPATCH - the same
         column list create-migrated-documents.mjs reads, and for the reasons
         written there (docs/bugs/0030 and 0617). */
      const doSoItems = gapAcNos.length ? await sql`
        SELECT i.id, i.item_code, i.line_no, i.qty::float8 AS qty, i.item_group, i.variants,
               i.description2, i.unit_price_sen, i.discount_sen, i.unit_cost_sen,
               h.doc_no, h.linked_ac_docno AS ac
          FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
         WHERE h.company_id = ${CO} AND h.linked_ac_docno = ANY(${gapAcNos})
           AND COALESCE(i.cancelled, false) = false
         ORDER BY i.line_no` : [];
      for (const r of gapDocNos.length
        ? await sql`SELECT doc_no, debtor_name FROM scm.mfg_sales_orders WHERE company_id = ${CO} AND doc_no = ANY(${gapDocNos})`
        : []) doDebtor.set(r.doc_no, r.debtor_name);
      /* What the ERP already counts as delivered on these orders, from its own
         rows. Used ONLY as the over-delivery assertion below - never to derive
         a quantity to write. */
      const deliveredBySo = new Map((gapDocNos.length
        ? await sql`SELECT d.so_doc_no, COALESCE(SUM(i.qty), 0)::float8 AS q
                      FROM scm.delivery_orders d JOIN scm.delivery_order_items i ON i.delivery_order_id = d.id
                     WHERE d.company_id = ${CO} AND d.so_doc_no = ANY(${gapDocNos})
                       AND upper(COALESCE(d.status::text, '')) <> 'CANCELLED'
                     GROUP BY d.so_doc_no`
        : []).map((r) => [r.so_doc_no, Number(r.q)]));
      const soItemsByAc = new Map();
      const soOrderedQty = new Map();
      for (const it of doSoItems) {
        if (!soItemsByAc.has(it.ac)) soItemsByAc.set(it.ac, []);
        soItemsByAc.get(it.ac).push(it);
        soOrderedQty.set(it.doc_no, (soOrderedQty.get(it.doc_no) || 0) + Number(it.qty || 0));
      }
      const itemMap = loadAcErpItemMap(path.join(here, "data"));
      for (const g of doGapScope) {
        if (touchedByAudit.has(g.doc)) { doRefused.push(`${g.doc} (${g.acNo}): a person edited this sales order in the ERP (audit trail)`); continue; }
        const mine = soItemsByAc.get(g.acNo) || [];
        if (!mine.length) { doRefused.push(`${g.doc} (${g.acNo}): the ERP order has no live line to deliver`); continue; }
        if (!g.kids.length) { doRefused.push(`${g.doc} (${g.acNo}): the book shows ${g.tq}/${g.qty} unit(s) delivered but NO delivery line names this order - there is no document to mirror`); continue; }
        for (const kid of g.kids) {
          const where = `${g.doc} (${g.acNo}) <- ${kid}`;
          if (erpDoByAc.has(kid)) continue;                                  // already mirrored
          if (doCancelled.has(kid)) { doRefused.push(`${where}: cancelled in AutoCount`); continue; }
          if (erpDoNumbers.has(migratedDoNumber(kid))) { doRefused.push(`${where}: the ERP already holds a delivery numbered ${migratedDoNumber(kid)}`); continue; }
          const bookRows = (doLinesByDoc.get(kid) || []).filter((r) => cell(r, F.fdt) === "SO" && cell(r, F.fdn) === g.acNo);
          if (!bookRows.length) { doRefused.push(`${where}: no line of that delivery names this sales order`); continue; }
          const codeless = bookRows.filter((r) => cell(r, F.hasCode) !== "1");
          if (codeless.length) { doRefused.push(`${where}: ${codeless.length} of its ${bookRows.length} line(s) carry no ItemCode, so nothing can be matched`); continue; }
          const rows = bookRows.map((r) => ({
            DoNo: kid, DoDate: doDate.get(kid) || null, SoNo: g.acNo,
            ItemCode: cell(r, F.itemKey), LineDesc: null, Qty: num(r[F.qty]),
            DebtorCode: null, DebtorName: null,
          }));
          const { plan, stats } = buildMigratedDoPlan({ rows, itemMap, soItems: mine });
          const dropped = stats.unmapped + stats.noSoLine + stats.exhausted;
          if (dropped > 0 || plan.length !== 1) {
            doRefused.push(`${where}: ALL-OR-NOTHING - ${dropped} of ${rows.length} book line(s) did not resolve to a sales-order line (unmapped ${stats.unmapped}, no ERP line ${stats.noSoLine}, no unclaimed line left ${stats.exhausted})`);
            continue;
          }
          if (stats.collapsed) doNotes.push(`${where}: ${stats.collapsed} duplicate line(s) refused by the shape guard`);
          doPlan.push(plan[0]);
        }
      }
      /* THE OVER-DELIVERY ASSERTION. `taken` inside the matcher is keyed per
         DELIVERY NOTE, so two notes against one order can each claim the same
         sales-order line - correct when the order really was shipped twice,
         wrong when the match went astray. Nothing downstream would catch it, so
         it is asserted here against the order's own ordered quantity plus what
         the ERP already delivered. An order that fails REFUSES ALL of its
         planned notes: a partial write of a set that does not add up is the
         worst of the three outcomes. */
      {
        const plannedBySo = new Map();
        for (const d of doPlan) plannedBySo.set(d.so, (plannedBySo.get(d.so) || 0) + d.items.reduce((t, i) => t + Number(i.qty || 0), 0));
        const overSo = new Set();
        for (const [doc, planned] of plannedBySo) {
          const ordered = soOrderedQty.get(doc) || 0;
          const already = deliveredBySo.get(doc) || 0;
          if (planned + already > ordered + 1e-6) {
            overSo.add(doc);
            doRefused.push(`${doc}: REFUSED, the plan would deliver ${planned} unit(s) on top of ${already} already delivered against ${ordered} ordered`);
          }
        }
        if (overSo.size) doPlan = doPlan.filter((d) => !overSo.has(d.so));
      }
      log("");
      log("LANE do - THE DELIVERY DOCUMENTS THIS RUN WOULD CREATE");
      log(`  DO_SCOPE=${DO_SCOPE}  (since = raised on or after the day we copied the order; all = plus the pre-migration history)`);
      log(`  unreflected sales orders, delivered SINCE we copied them   ${c1.gaps.filter((g) => g.since === true).length}`);
      log(`  unreflected sales orders, delivered BEFORE that            ${c1.gaps.filter((g) => g.since === false).length}   (the owner's DECISION; DO_SCOPE=all includes them)`);
      log(`  unreflected sales orders that cannot be dated              ${c1.gaps.filter((g) => g.since === null).length}   (never written by either scope)`);
      log(`  sales orders in scope for this run                         ${doGapScope.length}`);
      log(`  delivery documents this run would CREATE                   ${doPlan.length} (${doPlan.reduce((t, d) => t + d.items.length, 0)} line(s), ${doPlan.reduce((t, d) => t + d.items.reduce((a, i) => a + Number(i.qty || 0), 0), 0)} unit(s)) across ${new Set(doPlan.map((d) => d.so)).size} sales order(s)`);
      log(`  REFUSED                                                    ${doRefused.length}`);
      log("  every document carries migrated_no_stock = true and posts NO inventory movement (migration 0276)");
      if (doPlan.length) enumerate("LANE do, documents to create", doPlan.map((d) => `${migratedDoNumber(d.doNo)} <- ${d.so} (${d.acSo}) dated ${(d.date || "?").slice(0, 10)}: ${d.items.length} line(s), ${d.items.reduce((a, i) => a + Number(i.qty || 0), 0)} unit(s)`));
      if (doRefused.length) enumerate("LANE do, REFUSED", doRefused);
      if (doNotes.length) enumerate("LANE do, notes", doNotes);

      // ══ CASE 2 — PO -> GR ══
      const acPoLineByDtl = new Map();
      for (const r of T.types.PO.lines) { const k = cell(r, F.dtl); if (k) acPoLineByDtl.set(k, r); }
      const grChildrenOfPo = new Map();
      for (const r of T.types.GR.lines) {
        if (cell(r, F.fdt) !== "PO") continue;
        const parent = cell(r, F.fdn); if (!parent) continue;
        if (!grChildrenOfPo.has(parent)) grChildrenOfPo.set(parent, new Set());
        grChildrenOfPo.get(parent).add(cell(r, F.doc));
      }
      const grDate = docDateOf("GR");
      const poCreatedByAc = new Map(poHeaders.map((h) => [h.linked_ac_docno, h.created_at]));
      const c2 = { keyed: 0, agree: 0, short: [], over: [], noBookLine: 0, shortDocs: new Set(),
                   grAbsent: new Set(), since: [], before: [], undated: [], sinceDocs: new Set() };
      for (const l of poItems) {
        if (l.linked_ac_dtlkey == null) continue;
        if (poCancelled.has(String(l.linked_ac_docno))) continue;
        c2.keyed++;
        const bl = acPoLineByDtl.get(String(l.linked_ac_dtlkey));
        if (!bl) { c2.noBookLine++; continue; }
        const bookTq = num(bl[F.tq]), erpRecv = num(l.received_qty);
        if (Math.abs(bookTq - erpRecv) < 1e-6) { c2.agree++; continue; }
        const kids = [...(grChildrenOfPo.get(String(l.linked_ac_docno)) || [])];
        for (const k of kids) if (!erpGrnByAc.has(k)) c2.grAbsent.add(k);
        const row = `${l.po_number} (${l.linked_ac_docno}) dtl=${l.linked_ac_dtlkey} ${l.item_code}: book received ${bookTq}, ERP received_qty ${erpRecv}, ordered ${num(l.qty)}; AutoCount GR ${kids.length ? kids.slice(0, 3).join("/") : "none"}`;
        if (erpRecv < bookTq) {
          c2.short.push(row); c2.shortDocs.add(l.po_number);
          const since = raisedSince(grDate, kids, poCreatedByAc.get(l.linked_ac_docno));
          if (since === null) c2.undated.push(row);
          else if (since) { c2.since.push(row); c2.sinceDocs.add(l.po_number); }
          else c2.before.push(row);
          /* LANE `recv` - the write plan, with the three guards that decide it.
             1. THE KEY. The loop above has already skipped every line without
                a linked_ac_dtlkey, so the match is AutoCount's own line key
                and never a guess. There is no fallback on purpose.
             2. NEVER BELOW WHAT THE ERP HOLDS. This branch is the shortfall
                branch, so `to` is always above `from`; the whole corpus has 0
                over-received lines, which means a DECREASE would say the
                match is wrong, not that a receipt was undone.
             3. NEVER ABOVE THE ORDERED QUANTITY. received_qty > qty is the
                exact state that reading the AGGREGATED GrQty as a per-line
                figure once put into production on 65 migrated lines
                (topup-ac-po-lines.mjs header). TransferedQty is per LINE and
                must not produce it - so a line that would is REFUSED and
                listed, never clamped to something nobody can stand behind. */
          if (poTouched.has(l.po_number)) recvRefused.push(`${row}  REFUSED: a person edited this purchase order's received quantity or dedication in the ERP`);
          else if (bookTq > num(l.qty) + 1e-6) recvRefused.push(`${row}  REFUSED: the book's received figure is ABOVE the ordered quantity - writing it would recreate the received_qty > qty defect`);
          else recvPlan.push({ poItemId: l.id, poNo: l.po_number, acDoc: String(l.linked_ac_docno), dtl: String(l.linked_ac_dtlkey),
                               itemCode: l.item_code, from: erpRecv, to: bookTq, ordered: num(l.qty), since });
        } else c2.over.push(row);
      }
      log("");
      log("CASE 2 — PURCHASE ORDERS THE BOOK HAS RECEIVED (PO -> GR)");
      log(`  migrated PO lines carrying an AutoCount DtlKey            ${c2.keyed}`);
      log(`  received_qty AGREES with AutoCount TransferedQty          ${c2.agree}`);
      log(`  the line is not in the truth snapshot at all              ${c2.noBookLine}`);
      log(`  ERP received LESS than the book says                      ${c2.short.length} line(s) on ${c2.shortDocs.size} purchase order(s)`);
      log(`  ERP received MORE than the book says                      ${c2.over.length} line(s)`);
      log(`  AutoCount goods receipts behind them the ERP has no mirror for  ${c2.grAbsent.size}`);
      log("  ── of the short lines, split by WHEN the receipt was raised ──");
      log(`  received SINCE we took our copy -> ACT ON THESE            ${c2.since.length} line(s) on ${c2.sinceDocs.size} purchase order(s)`);
      log(`  already received BEFORE we copied it                       ${c2.before.length}`);
      log(`  cannot be dated from this snapshot                         ${c2.undated.length}`);
      if (c2.since.length) enumerate("CASE 2, received SINCE the migration", c2.since);
      if (c2.before.length) enumerate("CASE 2, received BEFORE the migration", c2.before);
      if (c2.over.length) enumerate("CASE 2, ERP ahead of the book", c2.over);

      /* The stated consequence of lane `recv`, not a refusal. A purchase order
         whose migrated GRN was already written mirrors the received_qty of the
         moment it was written; raising the line leaves that document behind,
         and create-migrated-documents.mjs will not top it up (it skips a PO it
         has already mirrored). Naming the count here is what turns a
         discrepancy someone will find later into a stated scope. */
      const migratedGrnPo = new Set(erpGrn.filter((g) => g.migrated_no_stock && g.linked_ac_docno).map((g) => String(g.linked_ac_docno).trim()));
      const recvWithGrn = recvPlan.filter((u) => migratedGrnPo.has(u.acDoc));
      log("");
      log("LANE recv - THE WRITE PLAN FOR received_qty");
      log(`  lines this run would raise                                ${recvPlan.length} on ${new Set(recvPlan.map((u) => u.poNo)).size} purchase order(s)`);
      log(`  ... received SINCE we took our copy                       ${recvPlan.filter((u) => u.since === true).length}`);
      log(`  ... received BEFORE it (our copy was short at import)     ${recvPlan.filter((u) => u.since === false).length}`);
      log(`  ... cannot be dated from this snapshot                    ${recvPlan.filter((u) => u.since === null).length}`);
      log(`  REFUSED                                                   ${recvRefused.length}`);
      log(`  units this run would add                                  ${recvPlan.reduce((t, u) => t + (u.to - u.from), 0)}`);
      log(`  of the planned lines, on a PO whose migrated GRN is already written  ${recvWithGrn.length} (that GRN keeps its own quantity; not a refusal)`);
      if (recvPlan.length) enumerate("LANE recv, lines to raise", recvPlan.map((u) => `${u.poNo} (${u.acDoc}) dtl=${u.dtl} ${u.itemCode}: received_qty ${u.from} -> ${u.to} of ${u.ordered} ordered`));
      if (recvRefused.length) enumerate("LANE recv, REFUSED", recvRefused);

      // ══ CASE 3 — SO -> PO ══
      /* FromDocType is NULL on PODTL even on real production rows (verified on
         PO-010163 <- SO-013423 and on a fresh test document), so the edge is
         FromSODtlKey + FromDocNo and FromDocType is never read here. */
      const c3 = { edges: 0, poDocs: new Set(), inErp: new Set(), absent: new Set(),
                   alreadyLinked: 0, missing: [], soLineAbsent: [] };
      /* LANE `dedi` shares its NEVER-STEAL bookkeeping with the section-4 link
         lane above: `claimed` already holds every sales-order line the ERP
         dedicates today plus every line that lane intends to claim, and
         `linkPlan` already owns its PO lines. Seeding from both is what stops
         the two lanes fighting over one line inside a single run. */
      const dediClaimed = new Set(claimed);
      const dediPoItems = new Set(linkPlan.map((u) => String(u.poItemId)));
      for (const r of T.types.PO.lines) {
        const key = cell(r, F.fsk), soNo = cell(r, F.fdn), poNo = cell(r, F.doc);
        if (!key || !soNo || !poNo) continue;
        if (!erpSoByAc.has(soNo)) continue;                 // parent SO never migrated: out of population
        if (poCancelled.has(poNo)) continue;
        c3.edges++; c3.poDocs.add(poNo);
        const poInErp = erpPoByAc.has(poNo);
        (poInErp ? c3.inErp : c3.absent).add(poNo);
        const si = soItemByDtl.get(String(key));
        if (!si) { c3.soLineAbsent.push(`${poNo} <- ${soNo} soDtl=${key}: the sales-order LINE is not in the ERP`); continue; }
        if (!poInErp) { c3.missing.push(`${si.doc_no} (${soNo}) line ${si.item_code} <- ${poNo}: the purchase order is not in the ERP at all`); continue; }
        const pi = poItemByDtl.get(String(cell(r, F.dtl)));
        if (!pi) { c3.missing.push(`${si.doc_no} (${soNo}) line ${si.item_code} <- ${poNo} dtl=${cell(r, F.dtl)}: the PO LINE is not in the ERP`); continue; }
        if (pi.so_item_id) { c3.alreadyLinked++; continue; }
        c3.missing.push(`${si.doc_no} (${soNo}) line ${si.item_code} <- ${pi.po_number} (${poNo}): so_item_id is NULL`);
        /* THE WRITE PLAN. The edge is FromSODtlKey + FromDocNo; FromDocType is
           NULL on all 10,792 SO->PO lines in the live book, so it is never read
           (measured, not assumed - see the comment above this loop). */
        const dediWhere = `${si.doc_no} (${soNo}) line ${si.item_code} <- ${pi.po_number} (${poNo}) dtl=${cell(r, F.dtl)}`;
        if (dediPoItems.has(String(pi.id))) continue;                    // the section-4 lane already claims this PO line
        if (poTouched.has(pi.po_number)) { dediRefused.push(`${dediWhere}: REFUSED, a person edited this purchase order's dedication in the ERP`); continue; }
        if (dediClaimed.has(String(si.id))) { dediRefused.push(`${dediWhere}: REFUSED, that sales-order line is already dedicated to another purchase-order line`); continue; }
        dediClaimed.add(String(si.id));
        dediPoItems.add(String(pi.id));
        dediPlan.push({ poItemId: pi.id, soItemId: si.id, poNo: pi.po_number, acPo: poNo, soDoc: si.doc_no, acSo: soNo, itemCode: si.item_code, soDtl: String(key) });
      }
      log("");
      log("CASE 3 — PURCHASE ORDERS RAISED FROM A MIGRATED SALES ORDER (SO -> PO)");
      log(`  book PO lines naming a MIGRATED sales-order line          ${c3.edges}`);
      log(`  distinct purchase orders behind them                      ${c3.poDocs.size}`);
      log(`  ... already in the ERP                                    ${c3.inErp.size}`);
      log(`  ... ABSENT from the ERP (import-ac-so-linked-pos.mjs)     ${c3.absent.size}`);
      log(`  the ERP line already carries its dedication               ${c3.alreadyLinked}`);
      log(`  ERP sales-order lines MISSING their PO dedication         ${c3.missing.length}`);
      log(`  the sales-order line itself is not in the ERP             ${c3.soLineAbsent.length}`);
      if (c3.absent.size) enumerate("CASE 3, purchase orders absent from the ERP", [...c3.absent]);
      if (c3.missing.length) enumerate("CASE 3, missing SO->PO dedication", c3.missing);
      if (c3.soLineAbsent.length) enumerate("CASE 3, sales-order line absent", c3.soLineAbsent);
      log("");
      log("LANE dedi - THE SO->PO DEDICATIONS THIS RUN WOULD WRITE");
      log(`  purchase-order lines that would gain their so_item_id     ${dediPlan.length} across ${new Set(dediPlan.map((u) => u.poNo)).size} purchase order(s)`);
      log(`  REFUSED                                                   ${dediRefused.length}`);
      log(`  already owned by the section-4 stamps lane this run       ${linkPlan.length}`);
      if (dediPlan.length) enumerate("LANE dedi, dedications to write", dediPlan.map((u) => `${u.poNo} (${u.acPo}) -> ${u.soDoc} (${u.acSo}) line ${u.itemCode} soDtl=${u.soDtl}`));
      if (dediRefused.length) enumerate("LANE dedi, REFUSED", dediRefused);

      // ══ CASE 4 — PROCEEDED LINES WHOSE BUILD TEXT MOVED SINCE WE COPIED IT ══
      /* check-ac-erp-reconcile.mjs already answers WHICH AXIS disagrees. The
         question it does not answer is WHEN. A variant the ERP holds was copied
         verbatim from Desc2 at import, so a line whose Desc2 differs TODAY is a
         line the book changed after we took our copy. blank-ok-until-proceeded
         is the owner's rule: on an order that is not proceeded a blank is
         legitimate and is NOT a gap. */
      const bookDesc2 = new Map();
      for (const r of T.types.SO.desc2) bookDesc2.set(String(r[D2K]), txt(r[D2V]));
      const proceededByAc = new Map(soHeaders.map((h) => [h.linked_ac_docno, h.proceeded === true]));
      const c4 = { keyed: 0, same: 0, filled: [], changed: [], cosmetic: [], cleared: [], notProceeded: 0, humanEdited: 0 };
      for (const l of soItems) {
        if (l.linked_ac_dtlkey == null) continue;
        if (soCancelled.has(String(l.linked_ac_docno))) continue;
        c4.keyed++;
        const book = bookDesc2.get(String(l.linked_ac_dtlkey)) || null;
        const erp = txt(l.description2);
        if (book === erp) { c4.same++; continue; }
        const h = erpSoByAc.get(l.linked_ac_docno);
        const where = `${h ? h.doc_no : "?"} (${l.linked_ac_docno}) dtl=${l.linked_ac_dtlkey} ${l.item_code}`;
        // COPY, NEVER COMPUTE: a book value that went blank never erases ours.
        if (book === null) { c4.cleared.push(where); continue; }
        if (proceededByAc.get(l.linked_ac_docno) !== true) { c4.notProceeded++; continue; }
        if (h && touched.has(h.doc_no)) { c4.humanEdited++; continue; }
        const row = `${where}: ERP ${JSON.stringify(erp)} -> BOOK ${JSON.stringify(book)}`;
        if (erp === null) { c4.filled.push(row); continue; }
        (flatten(erp) === flatten(book) ? c4.cosmetic : c4.changed).push(row);
      }
      log("");
      log("CASE 4 — PROCEEDED LINES WHOSE BUILD TEXT CHANGED IN THE BOOK SINCE WE COPIED IT");
      log(`  migrated SO lines carrying an AutoCount DtlKey            ${c4.keyed}`);
      log(`  the book's Desc2 still matches the ERP's copy             ${c4.same}`);
      log(`  PROCEEDED, ERP blank, the book has since FILLED it in     ${c4.filled.length}`);
      log(`  PROCEEDED, both filled, the book has since CHANGED it     ${c4.changed.length}   <- the real backlog`);
      log(`  PROCEEDED, differs only by quote style / line breaks       ${c4.cosmetic.length}   (export round trip, not a build change)`);
      log(`  NOT proceeded — blank is OK, not a gap (owner's rule)     ${c4.notProceeded}`);
      log(`  a person edited the ERP order; never overwritten here     ${c4.humanEdited}`);
      log(`  the book CLEARED a text the ERP still holds               ${c4.cleared.length}`);
      if (c4.filled.length) enumerate("CASE 4, filled in since we copied", c4.filled);
      if (c4.changed.length) enumerate("CASE 4, changed since we copied", c4.changed);
      if (c4.cosmetic.length) enumerate("CASE 4, cosmetic only (NOT a build change)", c4.cosmetic);

      // ══ how much of the above the HEADER-STAMP delta could see ══
      const stampSo = new Set((S.stamps.SO || []).map((r) => r.DocNo));
      const stampPo = new Set((S.stamps.PO || []).map((r) => r.DocNo));
      const blindSo = c1.gapDocs.filter((d) => !stampSo.has(d));
      const c2Ac = new Set(poItems.filter((l) => c2.shortDocs.has(l.po_number)).map((l) => String(l.linked_ac_docno)));
      const blindPo = [...c2Ac].filter((d) => !stampPo.has(d));
      log("");
      log("WHAT A HEADER-STAMP DELTA CAN AND CANNOT SEE");
      log("  A conversion moves the CHILD's stamp and the PARENT's LINE. The parent");
      log("  HEADER need not move at all, so a plan keyed on stamps misses it.");
      log(`  CASE 1: ${blindSo.length} of the ${c1.gapDocs.length} unreflected sales order(s) are absent from stamps.SO.`);
      log(`  CASE 2: ${blindPo.length} of the ${c2Ac.size} short purchase order(s) are absent from stamps.PO.`);
      log("  TransferedQty, not the header stamp, is the parent-side signal — which is");
      log("  why this section reads ac-reconcile-truth.json.gz and not ac-doc-stamps.json.gz.");
    }
  }

  if (!APPLY) {
    log("");
    log('PLAN ONLY — no writes. MODE=apply CONFIRM="SYNC AC DELTA" writes the lanes named in LANES.');
    log(`   desc  ${descUpdates.length} line(s)      pay   ${payUpdates.length} order(s)     links ${linkPlan.length} dedication(s)`);
    log(`   recv  ${recvPlan.length} line(s)      do    ${doPlan.length} document(s)  dedi  ${dediPlan.length} dedication(s)`);
    log("The INSERT lane is NOT this script's: run the importers named above.");
    log("Section 5's CASE 4 (build text) stays REPORT-ONLY — a changed Desc2 can change the NUMBER of ERP lines.");
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

  /* LANE recv — copy AutoCount's per-line PODTL.TransferedQty onto the matching
     ERP line. Matched on linked_ac_dtlkey and nothing else. The two guards that
     decided the plan are RE-ASSERTED inside the statement, because a goods
     receipt posted in the ERP between the plan and this write would move the
     live value: `received_qty <= to` refuses a DECREASE (which would lose a
     real receipt), `qty >= to` refuses the received_qty > qty state that
     reading the aggregated GrQty per line once created on 65 lines. A row that
     fails either is simply not updated and shows up in the count. */
  let nRecv = 0, nDo = 0, nDedi = 0;
  const doMade = [];
  const doFailed = [];
  if (LANES.has("recv")) {
    for (let i = 0; i < recvPlan.length; i += 300) {
      const b = recvPlan.slice(i, i + 300);
      await sql.begin(async (tx) => {
        for (const u of b) {
          const r = await tx`UPDATE scm.purchase_order_items SET received_qty = ${u.to}
                              WHERE id = ${u.poItemId} AND company_id = ${CO}
                                AND COALESCE(received_qty, 0) <= ${u.to}
                                AND qty >= ${u.to}
                              RETURNING id`;
          nRecv += r.length;
        }
      });
    }
    log(`received_qty written: ${nRecv} of ${recvPlan.length} intended`);
  }
  /* LANE do — the delivery documents. One transaction per document (the writer
     opens it), so one collision cannot take the other hundred down with it; a
     failure is recorded and the run exits non-zero at the end rather than
     swallowing it. NO INVENTORY MOVEMENT is written and the verification below
     asserts that against scm.inventory_movements, not against intent. */
  if (LANES.has("do")) {
    for (const d of doPlan) {
      try {
        const made = await insertMigratedDo(sql, d, { companyId: CO, sysUser: SYS_USER, debtorFallback: doDebtor.get(d.so) ?? null });
        doMade.push(made); nDo += 1;
      } catch (e) {
        doFailed.push(`${migratedDoNumber(d.doNo)} <- ${d.so}: ${e.message}`);
      }
    }
    log(`delivery documents created: ${nDo} of ${doPlan.length} intended${doFailed.length ? `, ${doFailed.length} FAILED` : ""}`);
    for (const f of doFailed) log(`   FAILED ${f}`);
  }
  /* LANE dedi — so_item_id from PODTL.FromSODtlKey, with the same never-steal
     re-check the section-4 link lane makes inside its own transaction. */
  if (LANES.has("dedi")) {
    for (let i = 0; i < dediPlan.length; i += 300) {
      const b = dediPlan.slice(i, i + 300);
      await sql.begin(async (tx) => {
        for (const u of b) {
          const r = await tx`UPDATE scm.purchase_order_items SET so_item_id = ${u.soItemId}
                              WHERE id = ${u.poItemId} AND so_item_id IS NULL
                                AND NOT EXISTS (SELECT 1 FROM scm.purchase_order_items x WHERE x.so_item_id = ${u.soItemId})
                              RETURNING id`;
          nDedi += r.length;
        }
      });
    }
    log(`SO->PO dedications written (lane dedi): ${nDedi} of ${dediPlan.length} intended`);
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
  for (const u of recvPlan.slice(0, 5)) {
    const [row] = await v`SELECT received_qty::float8 AS rq, qty::float8 AS q, linked_ac_dtlkey FROM scm.purchase_order_items WHERE id = ${u.poItemId}`;
    if (!row || Number(row.rq) !== u.to || Number(row.q) < Number(row.rq) || String(row.linked_ac_dtlkey) !== String(u.dtl)) { bad++; log(`   VERIFY MISMATCH po line ${u.poItemId}`); }
  }
  for (const m of doMade.slice(0, 5)) {
    const [row] = await v`SELECT d.do_number, d.so_doc_no, d.status::text AS status, d.migrated_no_stock, d.line_count,
                                 d.linked_ac_docno,
                                 (SELECT count(*) FROM scm.delivery_order_items i WHERE i.delivery_order_id = d.id) AS lines,
                                 (SELECT count(*) FROM scm.delivery_order_items i WHERE i.delivery_order_id = d.id AND i.so_item_id IS NULL) AS unlinked
                            FROM scm.delivery_orders d WHERE d.id = ${m.id}`;
    if (!row || row.migrated_no_stock !== true || String(row.status).toUpperCase() !== "DELIVERED"
        || Number(row.lines) !== m.lines || Number(row.line_count) !== m.lines
        || Number(row.unlinked) !== 0 || !row.so_doc_no || !row.linked_ac_docno) { bad++; log(`   VERIFY MISMATCH delivery ${m.doNo}`); }
  }
  /* THE MOVEMENT ASSERTION, over EVERY document this run created and not a
     sample: migrated paperwork that moved stock would deduct units the AutoCount
     balance snapshot already counted as gone, and nothing downstream would ever
     say so. Read on the fresh connection, by the same two keys check-do-integrity
     reads (source_doc_no and source_doc_id). */
  if (doMade.length) {
    const [{ n }] = await v`SELECT count(*)::int AS n FROM scm.inventory_movements m
       WHERE m.source_doc_type::text = 'DO'
         AND (m.source_doc_no = ANY(${doMade.map((d) => d.doNo)}) OR m.source_doc_id::text = ANY(${doMade.map((d) => String(d.id))}))`;
    if (Number(n) !== 0) { bad++; log(`   VERIFY FAILED: ${n} inventory movement(s) exist for the ${doMade.length} migrated delivery document(s) this run created — they must have NONE`); }
    else log(`VERIFY: 0 inventory movements against the ${doMade.length} delivery document(s) created, as designed.`);
  }
  for (const u of dediPlan.slice(0, 5)) {
    const [row] = await v`SELECT i.so_item_id, s.doc_no, s.item_code FROM scm.purchase_order_items i
        LEFT JOIN scm.mfg_sales_order_items s ON s.id = i.so_item_id WHERE i.id = ${u.poItemId}`;
    if (!row || String(row.so_item_id) !== String(u.soItemId) || row.doc_no !== u.soDoc || !row.item_code) { bad++; log(`   VERIFY MISMATCH dedication on po line ${u.poItemId}`); }
  }
  if (doFailed.length) { bad++; log(`VERIFY FAILED: ${doFailed.length} delivery document(s) could not be written`); }
  if (bad) { log(`VERIFY FAILED on ${bad} sample(s)`); await v.end(); await sql.end(); process.exit(1); }
  log(`VERIFY (fresh connection): ${Math.min(5, descUpdates.length)} desc2 line(s), ${Math.min(5, payUpdates.length)} order(s), ${Math.min(5, linkPlan.length)} link(s), ${Math.min(5, recvPlan.length)} received line(s), ${Math.min(5, doMade.length)} delivery document(s) and ${Math.min(5, dediPlan.length)} dedication(s) re-read with the shape intended.`);
  await v.end();
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
