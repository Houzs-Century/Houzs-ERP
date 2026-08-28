#!/usr/bin/env node
// One-time GO-LIVE import: AutoCount OUTSTANDING Purchase Orders -> ERP
// scm.purchase_orders / scm.purchase_order_items for company 1 (Houzs Century).
// Companion to import-ac-outstanding-so.mjs, same conventions.
//
// SOURCE: backend/scripts/data/ac-outstanding-po.json.gz — a REAL PO+PODTL export
// from the live AED_HOUZS book (the ERP mirror public.purchase_orders was useless
// here: its unit_price / original_qty / Desc2 are all NULL). Outstanding is
// Qty > TransferedQty, same rule as SO.
//
// Owner rules:
//  - Company 1 only. SOFA is EXCLUDED unless SOFA=1, in which case a sofa line
//    decomposes into one ERP line per compartment (shared lib/parse-sofa.mjs).
//  - po_number = "HC-" + AutoCount PO no; the raw number goes to linked_ac_docno
//    so write-back updates that PO instead of creating a duplicate.
//  - supplier_id  <- CreditorCode (matches scm.suppliers.code exactly)
//  - item_code <- ItemCode via the AutoCount<->ERP binding CSV;
//    material_name <- the ERP product name; supplier_sku keeps the AutoCount code
//  - warehouse_id <- Location, via the same short-code -> full warehouse name map
//    the SO import uses (KL -> KL WAREHOUSE ...)
//  - bedframe variants <- Desc2, parsed exactly like the SO import
//    (colour -> fabric_colours fabricId/colourId, gap/divan/leg, specials)
//  - delivery_date <- the line's DeliveryDate, read through lib/ac-po-line.mjs.
//    It used to be read as `l.DelivDate`, the name the FIRST export cut used;
//    the re-cut in a5f51653 (PR #1779) renamed it and 0 of 338 rows carry the
//    old key, so every line imported with a blank date and JavaScript said
//    nothing. The accessor is shared and tested against the committed snapshots.
//  - so_item_id <- FromSODtlKey -> the AutoCount sales order -> the ERP line
//    with the matching code, via the SHARED taker (lib/so-line-dedication.mjs)
//    so a sales-order line is claimed exactly once across every importer. This
//    column was missing from the INSERT entirely, which is why 267 documents
//    came in undedicated and no later script went back for them.
//  - linked_ac_dtlkey <- PODTL.DtlKey, so the link never has to be re-derived
//  - qty = ordered; received_qty = ordered - outstanding
// Idempotent: skips po_numbers already present. DRY-RUN by default; APPLY=1.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { buildFabricColourIndex, isPendingColour } from "./lib/fabric-colour-match.mjs";
import { parseBedframe } from "./lib/parse-bedframe.mjs";
import { SOFA_MODEL_ALIAS, parseSofa } from "./lib/parse-sofa.mjs";
import { acDeliveryDate, acDtlKey, acFromSoDtlKey } from "./lib/ac-po-line.mjs";
import { makeSoLineTaker } from "./lib/so-line-dedication.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const LIMIT = Number(process.env.LIMIT || 0);
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const SYS_USER = "00000000-0000-4000-8000-000000000001";

const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");
const num = (v) => { const n = parseFloat(String(v ?? "").replace(/[^0-9.\-]/g, "")); return isFinite(n) ? n : 0; };
const centi = (v) => Math.round(num(v) * 100);
const isSofa = (c) => /SOFA/i.test(c || "");
function parseCsvLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) { const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; } }
  out.push(cur); return out;
}
const CATG = { MATTRESS: "mattress", BEDFRAME: "bedframe", ACC: "accessory", ACCESSORY: "accessory", BEDLINES: "accessory", DIFFUSER: "others", CARPET: "others", DINING: "others", OTHER: "others", SERVICE: "service", TRANS: "service", SOFA: "sofa" };
const C1_ALIAS = { "SVC-DELIVERY": "TRANSPORTATION CHARGES", "SVC-DELIVERY-ADD": "TRANSPORTATION CHARGES", "SVC-DELIVERY-CROSS": "TRANSPORTATION CHARGES" };
const SALESLOC = { KL: "KL WAREHOUSE", PG: "PG WAREHOUSE", SRW: "SRW WAREHOUSE", SBH: "SBH WAREHOUSE", HQ: "HQ", "KL DISP": "KL DISPLAY", "PG DISP": "PG DISPLAY", "SBH DISP": "SBH DISPLAY", "EM DISP": "EM DISPLAY" };

function parsePayment(p) {
  const s = (p || "").trim();
  if (!s) return { acct: null, appr: null, extra: null };
  const groups = [...s.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]);
  let acct = null, appr = null; const kept = [];
  for (const g of groups) { if (g === "/" || g === "") continue; const parts = g.split("/"); if (!acct && parts[0]) acct = parts[0].trim(); if (!appr && parts[1]) appr = parts[1].trim(); kept.push(g); }
  return { acct, appr, extra: kept.length > 1 ? kept.join(" | ") : null };
}






async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}${LIMIT ? ` LIMIT=${LIMIT}` : ""}`);
  const rows = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", "ac-outstanding-po.json.gz"))).toString("utf8").replace(/^﻿/, ""));
  log(`AutoCount outstanding PO lines: ${rows.length}`);

  const csv = fs.readFileSync(path.join(here, "data", "autocount-erp-mapping-1561.csv"), "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  csv.shift();
  const byAc = new Map();
  for (const ln of csv) { const f = parseCsvLine(ln); if (f[0]) byAc.set(norm(f[0]), { erp: (f[1] || "").trim(), cat: (f[3] || "").trim().toUpperCase() }); }

  const sup = await sql`SELECT id, code FROM scm.suppliers WHERE company_id = 1`;
  const supByCode = new Map(sup.map((s) => [s.code, s.id]));
  const wh = await sql`SELECT id, code FROM scm.warehouses WHERE company_id = 1`;
  const whByCode = new Map(wh.map((w) => [w.code.toUpperCase(), w.id]));
  const whId = (loc) => { if (!loc) return null; const k = loc.trim().toUpperCase(); return whByCode.get((SALESLOC[k] || k).toUpperCase()) || whByCode.get(k) || null; };
  const products = await sql`SELECT code, name FROM scm.mfg_products WHERE company_id = 1`;
  const prodByCode = new Map(products.map((p) => [p.code.toUpperCase(), p]));
  const codeSet = new Set(products.map((p) => p.code.toUpperCase()));
  const fcRows = await sql`SELECT fabric_id, colour_id, label FROM scm.fabric_colours WHERE company_id = 1`;
  const { findColour } = buildFabricColourIndex(fcRows);
  // #1998 contract: an unlabelled colour is read only when the library CONFIRMS
  // the code. The predicate was built for the backfill and the importers never
  // passed it, so colour-first Desc2 lost even library-known codes.
  const knownColour = (c) => { const h = findColour(c); return h ? h.colour_id : null; };
  log(`suppliers=${sup.length} warehouses=${wh.length} products=${products.length} fabric_colours=${fcRows.length}`);

  /* DEDICATION. AutoCount SO DtlKey -> the order it sits on, so a PO line can
     find the sales-order line it was raised for. The taker is shared with
     import-ac-so-linked-pos.mjs and the repair, so a line is claimed once
     across all of them; a cancelled line is never offered. */
  const soByDtl = new Map(
    JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", "ac-outstanding-so.json.gz"))).toString("utf8").replace(/^﻿/, ""))
      .map((r) => [String(r.DtlKey), { doc: r.DocNo, code: r.ItemCode }]),
  );
  const soItems = await sql`SELECT i.id, i.item_code, i.line_no, h.linked_ac_docno AS ac
    FROM scm.mfg_sales_order_items i
    JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
   WHERE h.company_id = 1 AND h.linked_ac_docno IS NOT NULL
     AND COALESCE(i.cancelled, false) = false
   ORDER BY i.line_no`;
  const takenSoItem = new Set(
    (await sql`SELECT DISTINCT so_item_id FROM scm.purchase_order_items WHERE so_item_id IS NOT NULL`)
      .map((r) => r.so_item_id),
  );
  const taker = makeSoLineTaker(soItems, takenSoItem);
  /* A document already in the ERP is skipped at insert time, so it must not
     CLAIM sales-order lines while planning either — an undedicated PO already
     in the database would otherwise take a line out of the pool in memory and
     deny it to a document this run really does insert. Its real dedication is
     the repair's job, not this importer's. */
  const existingDocs = new Set(
    (await sql`SELECT linked_ac_docno FROM scm.purchase_orders WHERE company_id = 1 AND linked_ac_docno IS NOT NULL`)
      .map((r) => r.linked_ac_docno),
  );
  let skipDedication = false;
  /* One PO line, tried most-specific first: the ERP code this line becomes
     (for a sofa that is already the compartment), then the sales order's own
     item, then the sofa placeholder the decode falls back to. */
  const dedicate = (l, ...codes) => {
    if (skipDedication) return null;
    const src = soByDtl.get(acFromSoDtlKey(l) ?? "");
    if (!src) return null;
    const base = byAc.get(norm(src.code));
    for (const c of [...codes, base ? base.erp : null].filter(Boolean)) {
      const id = taker.take(src.doc, c);
      if (id) return id;
    }
    return null;
  };
  let noSoLine = 0;

  // group by PO, drop sofa lines
  const groups = new Map();
  const SOFA = process.env.SOFA === "1"; // owner 2026-08-10: 沙发 PO 也要进
  /* NO received-filter on the purchasing side (owner 2026-08-10: "沙发还没送货,
     但已经有了 PO,那个 PO 可能已经被收货,也可能还没被收货,这些也全都要拉进
     来"). A received PO still belongs in the ERP — the goods exist and the
     customer leg is still open. The SO side's DO rule governs the CUSTOMER
     delivery only and deliberately does not mirror onto purchasing. */
  const doneDocs = new Set();
  for (const r of rows) { if (doneDocs.has(r.DocNo)) continue; if (!SOFA && isSofa(r.ItemCode)) continue; if (!groups.has(r.DocNo)) groups.set(r.DocNo, []); groups.get(r.DocNo).push(r); }
  let pos = [...groups.entries()];
  if (LIMIT) pos = pos.slice(0, LIMIT);

  const built = []; const exceptions = []; const sofaDecode = []; let noWh = 0, bfCol = 0, bfPending = 0;
  for (const [acPo, ls] of pos) {
    skipDedication = existingDocs.has(acPo);
    const h = ls[0];
    const supId = supByCode.get(h.CreditorCode) || null;
    if (!supId) { exceptions.push({ po: acPo, reason: `supplier ${h.CreditorCode} not in scm.suppliers` }); continue; }
    const items = []; let subtotal = 0; let anyReceived = false;
    for (const l of ls) {
      const hit = byAc.get(norm(l.ItemCode));
      let erp = hit ? hit.erp : null; let cat = hit ? hit.cat : null;
      if (erp && !codeSet.has(erp.toUpperCase()) && C1_ALIAS[erp.toUpperCase()]) erp = C1_ALIAS[erp.toUpperCase()];
      if (!erp) { exceptions.push({ po: acPo, code: l.ItemCode, reason: "no material mapping" }); continue; }
      const grp = CATG[cat] || "others";
      const qty = Math.round(num(l.Qty)) || 1;
      const done = Math.round(num(l.TransferedQty)) || 0;
      if (done > 0) anyReceived = true;
      const up = centi(l.UnitPrice); const lt = up * qty; subtotal += lt;
      const w = whId(l.Location); if (!w) noWh++;
      let variants = null, bf = null;
      if (grp === "bedframe") {
        bf = parseBedframe(l.Desc2);
        const pending = isPendingColour(bf.color);
        const fc = pending ? null : findColour(bf.color);
        if (fc) bfCol++; else if (pending) bfPending++;
        else if (bf.color) exceptions.push({ po: acPo, code: l.ItemCode, reason: `colour "${bf.color}" not in fabric_colours` });
        const tot = (Number(bf.gap) || 0) + (Number(bf.divan) || 0) + (Number(bf.leg) || 0);
        variants = { fabricId: fc ? fc.fabric_id : null, colourId: fc ? fc.colour_id : null, fabricCode: fc ? fc.colour_id : null, colourLabel: fc ? fc.label : null, fabricLabel: fc ? fc.fabric_id : null, gap: bf.gap != null ? bf.gap + '"' : null, divanHeight: bf.divan != null ? bf.divan + '"' : null, legHeight: bf.leg != null ? bf.leg + '"' : null, totalHeight: tot ? tot + '"' : null, specials: bf.specials || [] };
      }
      if (grp === "sofa" && SOFA) {
        /* One AutoCount sofa PO line -> one ERP line per compartment, exactly
           like the SO import (same shared decoder). The supplier is whatever
           AutoCount's CreditorCode resolved to above; supplier_sku keeps the
           AutoCount code PLUS the compartment so the factory sheet names the
           piece (owner's supplier-SKU rule, 2026-08-09). Price rides the lead
           piece; the rest are 0 so the PO total still matches AutoCount. */
        let model = (erp || "").replace(/-1S$/i, "");
        model = SOFA_MODEL_ALIAS[model] || model;
        const RECL_PROBE = ["-1S(R)", "-1A(R)(LHF)", "-1A(P)(LHF)", "-1S(P)"];
        const reclOK = RECL_PROBE.some((sfx) => codeSet.has((model + sfx).toUpperCase()));
        const ps = parseSofa(l.Desc2, model, reclOK, { knownColour });
        const codes = ps.pieces.map((c) => `${model}-${c}`);
        const allExist = codes.length > 0 && codes.every((c) => codeSet.has(c.toUpperCase()));
        const colour = isPendingColour(ps.color) ? null : ps.color;
        const fc = colour ? findColour(colour) : null;
        sofaDecode.push({ po: acPo, code: l.ItemCode, d2: l.Desc2, model,
          pieces: ps.conf !== "low" && allExist ? ps.pieces : null,
          why: allExist ? ps.why : [...ps.why, "piece SKU missing: " + codes.filter((c) => !codeSet.has(c.toUpperCase())).join(",")] });
        if (ps.conf !== "low" && allExist) {
          let first = true;
          for (const comp of ps.pieces) {
            const code = `${model}-${comp}`;
            const pr = prodByCode.get(code.toUpperCase());
            const soItemId = dedicate(l, code, `${model}-1S`);
            if (!soItemId && !skipDedication) noSoLine++;
            items.push({ erp: code, grp, name: (pr && pr.name) || code, sku: `${l.ItemCode} ${comp}`,
              desc: l.Description, d2: l.Desc2, qty, received: done, soItemId, dtlKey: acDtlKey(l),
              up: first ? up : 0, lt: first ? lt : 0, w, deliv: acDeliveryDate(l), bf: null,
              variants: { seatHeight: ps.size, fabricId: fc ? fc.fabric_id : null, colourId: fc ? fc.colour_id : null,
                fabricCode: fc ? fc.colour_id : null, colourLabel: fc ? fc.label : (colour || null),
                fabricLabel: fc ? fc.fabric_id : null, specials: ps.specials } });
            first = false;
          }
        } else {
          const ph = `${model}-1S`;
          const pr = prodByCode.get(ph.toUpperCase());
          const phCode = codeSet.has(ph.toUpperCase()) ? ph : erp;
          const soItemId = dedicate(l, phCode, erp);
          if (!soItemId && !skipDedication) noSoLine++;
          items.push({ erp: phCode, grp,
            name: (pr && pr.name) || ph, sku: l.ItemCode, desc: l.Description, d2: l.Desc2,
            qty, received: done, soItemId, dtlKey: acDtlKey(l), up, lt, w, deliv: acDeliveryDate(l), bf: null,
            variants: { seatHeight: ps.size || null, colourLabel: colour || null, specials: ps.specials },
            note: "SOFA UNPARSED — 按图/原文补件: " + (ps.why.join("; ") || "unreadable") });
        }
        continue;
      }
      const prod = prodByCode.get(erp.toUpperCase());
      const soItemId = dedicate(l, erp);
      if (!soItemId && !skipDedication) noSoLine++;
      items.push({ erp, grp, name: (prod && prod.name) || l.Description || erp, sku: l.ItemCode, desc: l.Description, d2: l.Desc2, qty, received: done, soItemId, dtlKey: acDtlKey(l), up, lt, w, deliv: acDeliveryDate(l), bf, variants });
    }
    if (!items.length) continue;
    built.push({ poNo: "HC-" + acPo, acPo, supId, poDate: h.DocDate, locWh: whId(h.Location), subtotal, status: anyReceived ? "PARTIALLY_RECEIVED" : "SUBMITTED", items });
  }

  log("");
  if (sofaDecode.length) {
    log(`SOFA decode: ${sofaDecode.filter((d) => d.pieces).length} decomposed, ${sofaDecode.filter((d) => !d.pieces).length} placeholder (never guessed)`);
    for (const d of sofaDecode) log(`   ${d.po} ${d.code} | ${JSON.stringify(d.d2).slice(0, 60)} -> ${d.pieces ? d.pieces.join(" + ") : "PLACEHOLDER"}${d.why.length ? " (" + d.why.join("; ") + ")" : ""}`);
  }
  log(`POs to import: ${built.length}; lines: ${built.reduce((a, o) => a + o.items.length, 0)}; value RM ${(built.reduce((a, o) => a + o.subtotal, 0) / 100).toLocaleString()}`);
  log(`bedframe colour resolved: ${bfCol}; pending (TBC/KIV): ${bfPending}; lines without a warehouse match: ${noWh}`);
  const fresh = built.filter((o) => !existingDocs.has(o.acPo));
  const dedicated = fresh.reduce((a, o) => a + o.items.filter((i) => i.soItemId).length, 0);
  const dated = built.reduce((a, o) => a + o.items.filter((i) => i.deliv).length, 0);
  log(`POs already in the ERP (dedication left to the repair): ${built.length - fresh.length}`);
  log(`dedicated to an SO line: ${dedicated} of ${fresh.reduce((a, o) => a + o.items.length, 0)} new lines; no SO line found: ${noSoLine}; lines carrying a delivery date: ${dated}`);
  log(`exceptions: ${exceptions.length}`);
  for (const e of exceptions.slice(0, 15)) log(`   PO ${e.po} ${e.code ? `code="${e.code}" ` : ""}${e.reason}`);
  const s = built.find((o) => o.items.some((i) => i.grp === "bedframe" && i.variants && i.variants.colourId)) || built[0];
  if (s) {
    log(`\nSAMPLE ${s.poNo} <- ${s.acPo}  status=${s.status}`);
    for (const i of s.items) log(`   [${i.grp}] ${i.erp} (sku ${i.sku}) x${i.qty} recv${i.received} RM${(i.lt / 100).toFixed(2)} wh=${i.w ? "ok" : "-"} deliv=${i.deliv || "-"}${i.variants ? ` variants=${JSON.stringify(i.variants)}` : ""}`);
  }

  if (!APPLY) { log("\nDRY-RUN — set APPLY=1 to import."); await sql.end(); return; }

  log("\nAPPLYING…");
  await sql`ALTER TABLE scm.purchase_orders ADD COLUMN IF NOT EXISTS linked_ac_docno text`;
  await sql`CREATE INDEX IF NOT EXISTS po_linked_ac_docno_idx ON scm.purchase_orders(linked_ac_docno)`;
  const nums = built.map((o) => o.poNo);
  const existing = new Set();
  for (let i = 0; i < nums.length; i += 500) { const r = await sql`SELECT po_number FROM scm.purchase_orders WHERE company_id = 1 AND po_number = ANY(${nums.slice(i, i + 500)})`; for (const x of r) existing.add(x.po_number); }
  const todo = built.filter((o) => !existing.has(o.poNo));
  log(`already imported: ${existing.size}; to insert: ${todo.length}`);

  let nPo = 0, nItems = 0;
  for (const o of todo) {
    await sql.begin(async (tx) => {
      /* EXPECTED DELIVERY on the PO screen reads the HEADER. This import wrote
         only the per-line date, so every migrated PO showed a blank delivery
         date although AutoCount had one on every line. Earliest line date, the
         same derivation the app's own SO->PO convert uses. */
      const headerEta = o.items.map((it) => it.deliv).filter(Boolean).map((d) => String(d).slice(0, 10)).sort()[0] ?? null;
      const ins = await tx`INSERT INTO scm.purchase_orders
        (po_number, linked_ac_docno, supplier_id, status, po_date, expected_at, purchase_location_id, currency,
         subtotal_sen, tax_sen, total_sen, revision, company_id, created_by, notes)
        VALUES (${o.poNo}, ${o.acPo}, ${o.supId}, ${o.status}, ${o.poDate || sql`CURRENT_DATE`}, ${headerEta}, ${o.locWh}, 'MYR',
         ${o.subtotal}, 0, ${o.subtotal}, 1, 1, ${SYS_USER}, ${"imported from AutoCount " + o.acPo})
        ON CONFLICT (po_number) DO NOTHING RETURNING id`;
      if (!ins.length) return;
      const poId = ins[0].id;
      for (const i of o.items) {
        await tx`INSERT INTO scm.purchase_order_items
          (purchase_order_id, material_kind, item_code, material_name, supplier_sku,
           qty, unit_price_sen, line_total_sen, received_qty, item_group,
           description, description2, uom, notes, gap_inches, divan_height_inches, leg_height_inches,
           custom_specials, variants, warehouse_id, delivery_date, from_mrp, company_id,
           so_item_id, linked_ac_dtlkey)
          VALUES (${poId}, 'mfg_product', ${i.erp}, ${i.name}, ${i.sku},
           ${i.qty}, ${i.up}, ${i.lt}, ${i.received}, ${i.grp},
           ${i.desc || null}, ${i.d2 || null}, ${i.grp === "bedframe" ? "SET" : "UNIT"},
           ${i.note ? (i.d2 ? i.d2 + " | " + i.note : i.note) : (i.d2 || null)},
           ${i.bf && isFinite(i.bf.gap) ? Math.round(i.bf.gap) : null}, ${i.bf && isFinite(i.bf.divan) ? Math.round(i.bf.divan) : null}, ${i.bf && isFinite(i.bf.leg) ? Math.round(i.bf.leg) : null},
           ${i.variants && i.variants.specials && i.variants.specials.length ? sql.json(i.variants.specials) : null},
           ${i.variants ? sql.json(i.variants) : null}, ${i.w}, ${i.deliv || null}, false, 1,
           ${i.soItemId ?? null}, ${i.dtlKey ?? null})`;
        nItems++;
      }
      nPo++;
    });
  }
  log(`DONE. inserted POs=${nPo} items=${nItems}; skipped-existing=${existing.size}; exceptions=${exceptions.length}`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
