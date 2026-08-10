#!/usr/bin/env node
// LINE-LEVEL top-up for the migrated AutoCount purchase orders.
//
// WHY THIS EXISTS. Both PO importers are idempotent at DOCUMENT level:
//
//     const nums = built.map((o) => o.poNo);        // import-ac-outstanding-po.mjs:205-208
//     const existing = new Set();                   // SELECT po_number ... = ANY(...)
//     const todo = built.filter((o) => !existing.has(o.poNo));
//
// so a document that already exists is skipped WHOLE - including any line the
// earlier run did not carry. Two APPLY runs without SOFA created 123 documents
// (98 pure non-sofa + 25 MIXED). When the SOFA=1 run came it reported
// "POs to import: 160; already imported: 123; to insert: 37" and the sofa lines
// riding those 25 mixed documents were never written. Re-running cannot fix it:
// the next run says "already imported: 160; to insert: 0". The same shape sits
// at import-ac-so-linked-pos.mjs:132, so this top-up reads BOTH exports.
//
// MATCHING RULE - in full in lib/po-line-topup-core.mjs, in short: a row is
// claimed for an AutoCount ItemCode by linked_ac_dtlkey where it has one
// (migration 0273 / #1819 - the column is nullable and backfill-ac-line-keys
// cannot reach a decomposed sofa compartment, so it is the strongest signal and
// never the only one), then by supplier_sku (the importers write the ItemCode
// there, and `${ItemCode} ${compartment}` for a sofa piece), then - only for a
// row carrying NO supplier_sku - by material_code / sofa model prefix. 225 of
// the 862 migrated PO lines have no supplier_sku, written by neither importer,
// and they are real AutoCount lines: matching on supplier_sku alone would have
// inserted 183 duplicates. Every row this script writes is given its
// linked_ac_dtlkey, which is the one place a new row can get the key for free.
//
// AND IT IS ALL-OR-NOTHING PER FAMILY. One AutoCount ItemCode on one document
// with ZERO claimed rows is the confirmed defect and gets written. One with
// SOME rows but fewer than expected is REPORTED and left alone - a half-written
// sofa build is just as likely a build a human corrected, and guessing would
// double a compartment. Under-repair, never duplicate.
//
// WHAT IT WRITES, and nothing else:
//   - the missing scm.purchase_order_items rows, built by the SAME rules the
//     importers use (shared lib/parse-sofa.mjs, lib/fabric-colour-match.mjs and
//     lib/parse-bedframe.mjs - never a second decoder)
//   - so_item_id where the export gives a FromSODtlKey AND that SO line
//     resolves AND is not already claimed; NULL otherwise, never wrong. The
//     claim is re-checked inside the transaction so a concurrent sibling repair
//     cannot make us steal one.
//   - the header's subtotal_centi / total_centi, INCREMENTED by exactly the
//     value of the rows this run inserted (an increment, not a recompute, so a
//     hand-adjusted header is not clobbered).
//
// WHAT IT DOES NOT DO, on purpose:
//   - never creates a purchase order. A document missing entirely is the
//     importers' job and check-cutover-completeness already reports it.
//   - never changes status. A document whose status no longer matches its
//     received quantities is REPORTED, not rewritten - a human may have moved it.
//   - never posts an inventory movement. These units came in with the AutoCount
//     balance snapshot (see 0276_scm_migrated_documents.sql).
//
// Idempotent: re-running claims the rows it wrote and inserts nothing.
// DRY-RUN by default; APPLY=1 writes. DOC=PO-009435 limits it to one document.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { buildFabricColourIndex, isPendingColour } from "./lib/fabric-colour-match.mjs";
import { parseBedframe } from "./lib/parse-bedframe.mjs";
import { SOFA_MODEL_ALIAS, parseSofa } from "./lib/parse-sofa.mjs";
import {
  buildFamilies, claimErpRows, diffExpectedRows, groupByDoc, mergeAcPoLines, planFamilyInserts,
} from "./lib/po-line-topup-core.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const ONLY = (process.env.DOC || "").trim().replace(/^HC-/, "");
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const CO = 1;
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8").replace(/^﻿/, ""));

const norm = (s) => String(s ?? "").trim().toUpperCase().replace(/\s+/g, " ");
const centi = (v) => Math.round((Number(v) || 0) * 100);
function parseCsvLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) { const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; } }
  out.push(cur); return out;
}
// the mapping CSV's own category vocabulary, folded to the ERP's item_group
const CATG = { MATTRESS: "mattress", BEDFRAME: "bedframe", ACC: "accessory", ACCESSORY: "accessory", BEDLINES: "accessory", DIFFUSER: "others", CARPET: "others", DINING: "others", OTHER: "others", SERVICE: "service", TRANS: "service", SOFA: "sofa" };
// scm.mfg_product_category, folded the same way (import-ac-so-linked-pos.mjs:78)
const PCATG = { SOFA: "sofa", BEDFRAME: "bedframe", ACCESSORY: "accessory", MATTRESS: "mattress", SERVICE: "service" };
const C1_ALIAS = { "SVC-DELIVERY": "TRANSPORTATION CHARGES", "SVC-DELIVERY-ADD": "TRANSPORTATION CHARGES", "SVC-DELIVERY-CROSS": "TRANSPORTATION CHARGES" };
const SALESLOC = {
  KL: "KL WAREHOUSE", PG: "PG WAREHOUSE", SRW: "SRW WAREHOUSE", SBH: "SBH WAREHOUSE",
  HQ: "HQ", "KL DISP": "KL DISPLAY", "PG DISP": "PG DISPLAY", "SBH DISP": "SBH DISPLAY",
  "EM DISP": "EM DISPLAY", "C&C DISP": "C&C DISPLAY",
  "SERV KL": "KL SERVICE", "SERV PG": "PG SERVICE",
  SUNWAY: "SUNWAY SHOWROOM", "KELANA.J": "KELANA.J SHOWROOM",
};

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}${ONLY ? ` DOC=${ONLY}` : ""}`);

  const acLines = mergeAcPoLines(gz("ac-outstanding-po.json.gz"), gz("ac-so-linked-pos.json.gz"));
  const acByDoc = groupByDoc(acLines);
  log(`AutoCount PO lines (outstanding + SO-linked, deduped on DtlKey): ${acLines.length} across ${acByDoc.size} documents`);

  const csv = fs.readFileSync(path.join(here, "data", "autocount-erp-mapping-1561.csv"), "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  csv.shift();
  const byAc = new Map();
  for (const ln of csv) { const f = parseCsvLine(ln); if (f[0]) byAc.set(norm(f[0]), { erp: (f[1] || "").trim(), cat: (f[3] || "").trim().toUpperCase() }); }

  const products = await sql`SELECT code, name, category::text AS category FROM scm.mfg_products WHERE company_id = ${CO}`;
  const prodByCode = new Map(products.map((p) => [p.code.toUpperCase(), p]));
  const codeSet = new Set(products.map((p) => p.code.toUpperCase()));
  const prodCat = new Map(products.map((p) => [norm(p.code), PCATG[String(p.category ?? "").toUpperCase()] ?? null]));
  const whs = await sql`SELECT id, code FROM scm.warehouses WHERE company_id = ${CO}`;
  const whByCode = new Map(whs.map((w) => [norm(w.code), w.id]));
  const whId = (loc) => { const k = norm(loc); return whByCode.get(norm(SALESLOC[k] || k)) ?? whByCode.get(k) ?? null; };
  const fcRows = await sql`SELECT fabric_id, colour_id, label FROM scm.fabric_colours WHERE company_id = ${CO}`;
  const { findColour } = buildFabricColourIndex(fcRows);
  log(`catalogue: products=${products.length} warehouses=${whs.length} fabric_colours=${fcRows.length}`);

  // AutoCount SO DtlKey -> the SO line it belongs to, so a PO line can dedicate
  const soLineByDtl = new Map();
  for (const r of gz("ac-outstanding-so.json.gz")) soLineByDtl.set(String(r.DtlKey), { doc: r.DocNo, code: r.ItemCode, d2: r.Desc2 });

  const soItems = await sql`SELECT i.id, i.item_code, i.line_no, h.linked_ac_docno ac
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL ORDER BY i.line_no`;
  const soByKey = new Map();
  for (const it of soItems) {
    const k = `${it.ac}|${norm(it.item_code)}`;
    if (!soByKey.has(k)) soByKey.set(k, []);
    soByKey.get(k).push(it);
  }
  const takenSoItem = new Set(
    (await sql`SELECT DISTINCT so_item_id FROM scm.purchase_order_items WHERE so_item_id IS NOT NULL`).map((r) => r.so_item_id),
  );
  const handedOut = new Map();
  const takeSoLine = (src, erpCode) => {
    if (!src || !erpCode) return null;
    const k = `${src.doc}|${norm(erpCode)}`;
    const cands = soByKey.get(k);
    if (!cands) return null;
    const used = handedOut.get(k) ?? 0;
    const pick = cands.find((c, i) => i >= used && !takenSoItem.has(c.id));
    if (!pick) return null;
    handedOut.set(k, cands.indexOf(pick) + 1);
    takenSoItem.add(pick.id);
    return pick.id;
  };

  const poRows = await sql`SELECT id, po_number, linked_ac_docno, status FROM scm.purchase_orders
    WHERE company_id = ${CO} AND linked_ac_docno IS NOT NULL`;
  const poByAc = new Map(poRows.map((p) => [p.linked_ac_docno, p]));
  /* linked_ac_dtlkey arrived with migration 0273 (#1819) and is the strongest
     claim there is. Guarded because a DRY-RUN can legitimately run against a
     database the migration has not reached yet. */
  const HAS_DTLKEY = (await sql`SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'scm' AND table_name = 'purchase_order_items' AND column_name = 'linked_ac_dtlkey'`).length > 0;
  const itemRows = HAS_DTLKEY
    ? await sql`SELECT i.purchase_order_id, i.supplier_sku, i.material_code, i.linked_ac_dtlkey
        FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
        WHERE p.company_id = ${CO} AND p.linked_ac_docno IS NOT NULL`
    : await sql`SELECT i.purchase_order_id, i.supplier_sku, i.material_code, NULL::bigint AS linked_ac_dtlkey
        FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
        WHERE p.company_id = ${CO} AND p.linked_ac_docno IS NOT NULL`;
  const itemsByPo = new Map();
  for (const r of itemRows) {
    if (!itemsByPo.has(r.purchase_order_id)) itemsByPo.set(r.purchase_order_id, []);
    itemsByPo.get(r.purchase_order_id).push({ supplierSku: r.supplier_sku, materialCode: r.material_code, linkedAcDtlKey: r.linked_ac_dtlkey });
  }
  const noSku = itemRows.filter((r) => !r.supplier_sku).length;
  const keyed = itemRows.filter((r) => r.linked_ac_dtlkey != null).length;
  log(`ERP: purchase orders carrying linked_ac_docno ${poRows.length}; their lines ${itemRows.length}`);
  log(`   linked_ac_dtlkey column ${HAS_DTLKEY ? "present" : "NOT YET APPLIED here"}; lines carrying a key ${keyed}; lines with no supplier_sku (claimed by material_code) ${noSku}`);

  /* One AutoCount ItemCode -> the ERP terms every stage needs. Returns null when
     the mapping CSV does not know the code: never guessed. */
  const resolveErp = (itemCode) => {
    const hit = byAc.get(norm(itemCode));
    let erp = hit ? hit.erp : null;
    const csvCat = hit ? hit.cat : null;
    if (erp && !codeSet.has(erp.toUpperCase()) && C1_ALIAS[erp.toUpperCase()]) erp = C1_ALIAS[erp.toUpperCase()];
    if (!erp) return null;
    /* item_group: the catalogue's own category first (what bound-mode readiness
       reads and what import-ac-so-linked-pos.mjs uses), the mapping CSV second. */
    const fromCat = prodCat.get(norm(erp));
    const fromCsv = CATG[csvCat] ?? null;
    const grp = fromCat ?? fromCsv ?? "others";
    let sofaModel = null;
    if (grp === "sofa") {
      const m = String(erp).replace(/-1S$/i, "");
      sofaModel = SOFA_MODEL_ALIAS[m] || m;
    }
    return { erp, grp, sofaModel, fromCat, fromCsv };
  };

  const sofaDecode = [];
  const groupDisagree = [];

  /* The rows ONE AutoCount line should become, by the importers' own rules. */
  const buildExpected = (l, doc) => {
    const r = resolveErp(l.itemCode);
    if (!r) return null;
    if (r.fromCat && r.fromCsv && r.fromCat !== r.fromCsv) groupDisagree.push({ doc, code: l.itemCode, catalogue: r.fromCat, csv: r.fromCsv });
    const qty = Math.round(l.qty ?? 0) || 1;
    const recv = Math.round(l.receivedQty ?? 0);
    const up = centi(l.unitPrice ?? 0);
    const wh = whId(l.location);
    const deliv = l.deliveryDate ? String(l.deliveryDate).slice(0, 10) : null;
    const src = l.fromSoDtlKey ? soLineByDtl.get(l.fromSoDtlKey) : null;
    const base = { doc, dtlKey: l.dtlKey, description: l.description, desc2: l.desc2, qty, recv, wh, deliv, grp: r.grp, src };

    if (r.grp === "sofa") {
      const model = r.sofaModel;
      const reclOK = ["-1S(R)", "-1A(R)(LHF)", "-1A(P)(LHF)", "-1S(P)"].some((sfx) => codeSet.has((model + sfx).toUpperCase()));
      let ps = parseSofa(l.desc2, model, reclOK);
      let usedSoText = false;
      if ((ps.conf === "low" || !ps.pieces.length) && src && src.d2) {
        const alt = parseSofa(src.d2, model, reclOK);
        if (alt.pieces.length && alt.conf !== "low") { ps = alt; usedSoText = true; }
      }
      const codes = ps.pieces.map((c) => `${model}-${c}`);
      const allExist = codes.length > 0 && codes.every((c) => codeSet.has(c.toUpperCase()));
      const colour = isPendingColour(ps.color) ? null : ps.color;
      const fc = colour ? findColour(colour) : null;
      sofaDecode.push({ doc, code: l.itemCode, usedSoText, pieces: ps.conf !== "low" && allExist ? ps.pieces : null });
      const variants = { seatHeight: ps.size || null, fabricId: fc ? fc.fabric_id : null, colourId: fc ? fc.colour_id : null,
        fabricCode: fc ? fc.colour_id : null, colourLabel: fc ? fc.label : (colour || null), fabricLabel: fc ? fc.fabric_id : null, specials: ps.specials };
      if (ps.conf !== "low" && allExist) {
        const rows = [];
        let lead = true;
        for (const comp of ps.pieces) {
          const code = `${model}-${comp}`;
          rows.push({ ...base, materialCode: code, materialName: (prodByCode.get(code.toUpperCase()) || {}).name || code,
            supplierSku: `${l.itemCode} ${comp}`, up: lead ? up : 0, variants, bf: null, note: null,
            soCode: code, soFallbackCode: `${model}-1S` });
          lead = false;
        }
        return rows;
      }
      const ph = `${model}-1S`;
      const code = codeSet.has(ph.toUpperCase()) ? ph : r.erp;
      return [{ ...base, materialCode: code, materialName: (prodByCode.get(code.toUpperCase()) || {}).name || code,
        supplierSku: l.itemCode, up, variants: { seatHeight: ps.size || null, colourLabel: colour || null, specials: ps.specials },
        bf: null, note: "SOFA UNPARSED - 按图/原文补件: " + (ps.why.join("; ") || "unreadable"),
        soCode: code, soFallbackCode: r.erp }];
    }

    let bf = null, variants = null;
    if (r.grp === "bedframe") {
      bf = parseBedframe(l.desc2);
      const pending = isPendingColour(bf.color);
      const fc = pending ? null : findColour(bf.color);
      const tot = (Number(bf.gap) || 0) + (Number(bf.divan) || 0) + (Number(bf.leg) || 0);
      variants = { fabricId: fc ? fc.fabric_id : null, colourId: fc ? fc.colour_id : null, fabricCode: fc ? fc.colour_id : null,
        colourLabel: fc ? fc.label : null, fabricLabel: fc ? fc.fabric_id : null,
        gap: bf.gap != null ? bf.gap + '"' : null, divanHeight: bf.divan != null ? bf.divan + '"' : null,
        legHeight: bf.leg != null ? bf.leg + '"' : null, totalHeight: tot ? tot + '"' : null, specials: bf.specials || [] };
    }
    const prod = prodByCode.get(r.erp.toUpperCase());
    return [{ ...base, materialCode: r.erp, materialName: (prod && prod.name) || l.description || r.erp,
      supplierSku: l.itemCode, up, variants, bf, note: null,
      soCode: src ? (byAc.get(norm(src.code)) || {}).erp : null, soFallbackCode: null }];
  };

  const plan = [];
  const unmapped = [];
  const partials = [];
  const docsNotInErp = [];
  let acConsidered = 0, expectedTotal = 0, unassignedRows = 0, ambiguousRows = 0;

  for (const [doc, lines] of acByDoc) {
    if (ONLY && doc !== ONLY) continue;
    const po = poByAc.get(doc);
    if (!po) { docsNotInErp.push(doc); continue; }
    const existing = itemsByPo.get(po.id) ?? [];
    const families = buildFamilies(lines, (ic) => {
      const r = resolveErp(ic);
      return r ? { code: r.erp, sofaModel: r.sofaModel } : {};
    });
    const claim = claimErpRows(families, existing);
    unassignedRows += claim.unassigned.length;
    ambiguousRows += claim.ambiguous.length;

    const rows = [];
    for (const f of families) {
      const expected = [];
      for (const l of f.lines) {
        acConsidered++;
        const built = buildExpected(l, doc);
        if (!built) { unmapped.push({ doc, code: l.itemCode }); continue; }
        expected.push(...built);
      }
      expectedTotal += expected.length;
      if (!expected.length) continue;
      const { verdict, insert } = planFamilyInserts(f, expected);
      if (verdict === "partial") partials.push({ doc, po, itemCode: f.itemCode, acLines: f.acLines, claimed: f.claimed, expected: expected.length });
      rows.push(...insert);
    }
    if (rows.length) plan.push({ po, doc, rows, acLines: lines.length, existingRows: existing.length });
  }

  /* Dedicate only the rows that will actually be written, and only after the
     claim - taking an SO line for a row that turns out to be present already
     would steal it from the sibling repair for nothing. */
  let dedicated = 0, noSoLine = 0, noWarehouse = 0;
  for (const p of plan) {
    for (const r of p.rows) {
      r.soItemId = takeSoLine(r.src, r.soCode) ?? (r.soFallbackCode ? takeSoLine(r.src, r.soFallbackCode) : null);
      if (r.soItemId) dedicated++; else noSoLine++;
      if (!r.wh) noWarehouse++;
    }
  }

  const rowsToInsert = plan.reduce((a, p) => a + p.rows.length, 0);
  const valueCenti = plan.reduce((a, p) => a + p.rows.reduce((b, r) => b + r.up * r.qty, 0), 0);
  const sofaRows = plan.reduce((a, p) => a + p.rows.filter((r) => r.grp === "sofa").length, 0);
  const recvRows = plan.reduce((a, p) => a + p.rows.filter((r) => r.recv > 0).length, 0);

  log("");
  log(`AutoCount lines considered: ${acConsidered}; ERP rows they should produce: ${expectedTotal}`);
  log(`MISSING ERP rows (their AutoCount ItemCode has ZERO rows on the document): ${rowsToInsert} across ${plan.length} purchase orders`);
  log(`   of those: sofa ${sofaRows}; other ${rowsToInsert - sofaRows}; carrying received qty ${recvRows}; value RM ${(valueCenti / 100).toFixed(2)}`);
  log(`   dedicated to an SO line ${dedicated}; no SO line resolved ${noSoLine}; no warehouse match ${noWarehouse}`);
  log(`PARTIALLY represented AutoCount ItemCodes (some rows present, fewer than expected) - REPORTED, NOT TOUCHED: ${partials.length}`);
  for (const p of partials.slice(0, 25)) log(`   ${p.doc} "${p.itemCode}": AutoCount ${p.acLines} line(s), ERP rows ${p.claimed}, rebuild would be ${p.expected}`);
  if (partials.length > 25) log(`   ... and ${partials.length - 25} more`);
  log(`AutoCount lines with no material mapping (reported, never guessed): ${unmapped.length}`);
  for (const u of unmapped.slice(0, 15)) log(`   ${u.doc} "${u.code}"`);
  log(`AutoCount documents in the export but not in the ERP (NOT created here): ${docsNotInErp.length}`);
  for (const d of docsNotInErp.slice(0, 20)) log(`   absent PO: ${d}`);
  log(`ERP rows no AutoCount ItemCode on their document could claim: ${unassignedRows}; claimable by two ItemCodes so claimed by neither: ${ambiguousRows}`);

  log("");
  log("MISSING ROWS, one line each:");
  for (const p of plan) {
    log(`   ${p.po.po_number} (AutoCount ${p.doc}) [${p.po.status}] AutoCount ${p.acLines} lines / ERP ${p.existingRows} rows -> +${p.rows.length}`);
    for (const r of p.rows) log(`      + ${r.materialCode} sku="${r.supplierSku}" x${r.qty} recv${r.recv} RM${((r.up * r.qty) / 100).toFixed(2)} group=${r.grp} wh=${r.wh ? "ok" : "-"} so_item=${r.soItemId ? "yes" : "null"}`);
  }

  const statusMismatch = plan.filter((p) => p.rows.some((r) => r.recv > 0) && p.po.status === "SUBMITTED");
  log("");
  log(`purchase orders whose status would no longer match their received quantities (REPORTED, not changed): ${statusMismatch.length}`);
  for (const p of statusMismatch) log(`   ${p.po.po_number} status=${p.po.status} but ${p.rows.filter((r) => r.recv > 0).length} of the missing rows are received`);

  const ok = sofaDecode.filter((d) => d.pieces).length;
  log("");
  log(`SOFA decode over every AutoCount sofa line read: ${ok} decomposed, ${sofaDecode.length - ok} placeholder (never guessed); read from the SO's own text ${sofaDecode.filter((d) => d.usedSoText).length}`);
  if (groupDisagree.length) {
    log(`item_group disagreements catalogue-vs-CSV (catalogue wins): ${groupDisagree.length}`);
    for (const g of groupDisagree.slice(0, 10)) log(`   ${g.doc} "${g.code}" catalogue=${g.catalogue} csv=${g.csv}`);
  }

  if (!APPLY) {
    log("");
    log("DRY-RUN - set APPLY=1 to write. No inventory movement is ever written by this script.");
    await sql.end();
    return;
  }

  log("");
  log("APPLYING...");
  let wrote = 0, docsWritten = 0, deltaCenti = 0, dedicationsWritten = 0, keysWritten = 0, skippedRaced = 0;
  for (const p of plan) {
    await sql.begin(async (tx) => {
      /* Re-read inside the transaction: if another run - or the sibling repair -
         wrote these rows since the read above, this inserts nothing. */
      const live = (await tx`SELECT supplier_sku, material_code FROM scm.purchase_order_items WHERE purchase_order_id = ${p.po.id}`)
        .map((r) => ({ supplierSku: r.supplier_sku, materialCode: r.material_code }));
      /* NB this last guard keys on supplier_sku only, deliberately - it is the
         column this script always writes, so it is the one that can prove a row
         it is about to write is already there. */
      const { toInsert } = diffExpectedRows(p.rows, live);
      skippedRaced += p.rows.length - toInsert.length;
      if (!toInsert.length) return;
      let added = 0;
      for (const r of toInsert) {
        let soItemId = r.soItemId ?? null;
        if (soItemId) {
          const claimed = await tx`SELECT 1 FROM scm.purchase_order_items WHERE so_item_id = ${soItemId} LIMIT 1`;
          if (claimed.length) soItemId = null; // never wrong: leave it NULL rather than steal
        }
        const [ins] = await tx`INSERT INTO scm.purchase_order_items
            (purchase_order_id, material_kind, material_code, material_name, supplier_sku,
             description, description2, notes,
             qty, received_qty, unit_price_centi, line_total_centi, item_group, uom,
             gap_inches, divan_height_inches, leg_height_inches,
             custom_specials, variants,
             warehouse_id, so_item_id, company_id, delivery_date, from_mrp)
          VALUES (${p.po.id}, 'mfg_product', ${r.materialCode}, ${r.materialName}, ${r.supplierSku},
                  ${r.description || null}, ${r.desc2 || null},
                  ${r.note ? (r.desc2 ? r.desc2 + " | " + r.note : r.note) : (r.desc2 || null)},
                  ${r.qty}, ${r.recv}, ${r.up}, ${r.up * r.qty}, ${r.grp},
                  ${r.grp === "bedframe" ? "SET" : "UNIT"},
                  ${r.bf && isFinite(r.bf.gap) ? Math.round(r.bf.gap) : null},
                  ${r.bf && isFinite(r.bf.divan) ? Math.round(r.bf.divan) : null},
                  ${r.bf && isFinite(r.bf.leg) ? Math.round(r.bf.leg) : null},
                  ${r.variants && r.variants.specials && r.variants.specials.length ? sql.json(r.variants.specials) : null},
                  ${r.variants ? sql.json(r.variants) : null},
                  ${r.wh}, ${soItemId}, ${CO}, ${r.deliv}, false)
          RETURNING id`;
        /* Give the new row the AutoCount line key straight away. Nothing else
           can: backfill-ac-line-keys matches on (DocNo + ERP code) and a sofa
           compartment's code is `${model}-{piece}`, which no AutoCount ItemCode
           maps to - so a compartment written without it would stay keyless and
           the write-back's /edit could never address it. */
        if (HAS_DTLKEY && ins && r.dtlKey) {
          await tx`UPDATE scm.purchase_order_items SET linked_ac_dtlkey = ${Number(r.dtlKey)} WHERE id = ${ins.id}`;
          keysWritten++;
        }
        if (soItemId) dedicationsWritten++;
        added += r.up * r.qty;
        wrote++;
      }
      if (added) {
        await tx`UPDATE scm.purchase_orders
          SET subtotal_centi = COALESCE(subtotal_centi, 0) + ${added},
              total_centi = COALESCE(total_centi, 0) + ${added}
          WHERE id = ${p.po.id}`;
        deltaCenti += added;
      }
      docsWritten++;
    });
  }
  log(`DONE. rows inserted ${wrote} across ${docsWritten} purchase orders; SO dedications written ${dedicationsWritten}; AutoCount line keys written ${keysWritten}; header value added RM ${(deltaCenti / 100).toFixed(2)}; rows already present at write time ${skippedRaced}`);
  log("no inventory movement written, no document created, no status changed - by design.");
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
