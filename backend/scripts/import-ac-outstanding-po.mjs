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
//  - Company 1 only. SOFA EXCLUDED (any line whose ItemCode contains SOFA is
//    skipped; a PO left with no lines is skipped entirely).
//  - po_number = "HC-" + AutoCount PO no; the raw number goes to linked_ac_docno
//    so write-back updates that PO instead of creating a duplicate.
//  - supplier_id  <- CreditorCode (matches scm.suppliers.code exactly)
//  - material_code <- ItemCode via the AutoCount<->ERP binding CSV;
//    material_name <- the ERP product name; supplier_sku keeps the AutoCount code
//  - warehouse_id <- Location, via the same short-code -> full warehouse name map
//    the SO import uses (KL -> KL WAREHOUSE ...)
//  - bedframe variants <- Desc2, parsed exactly like the SO import
//    (colour -> fabric_colours fabricId/colourId, gap/divan/leg, specials)
//  - delivery_date <- the line's DeliveryDate
//  - qty = ordered; received_qty = ordered - outstanding
// Idempotent: skips po_numbers already present. DRY-RUN by default; APPLY=1.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const LIMIT = Number(process.env.LIMIT || 0);
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const SYS_USER = "00000000-0000-4000-8000-000000000001";

const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");
const strip = (s) => norm(s).replace(/[^A-Z0-9]/g, "");
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
const isPendingColour = (c) => /(TBC|KIV)/i.test(c || "");

function parseBedframe(d2) {
  /* AutoCount Desc2 is free text typed by many people over years. Normalise the
     wrappers and misspellings FIRST so one set of patterns can read them all:
     strip [..]/(..) wrappers, "diavan"->divan, "mattressgap"/"mgap"->m.gap. */
  let s = (d2 || "").replace(/\s+/g, " ").trim();
  s = s.replace(/^[[(]\s*/, "").replace(/\s*[\])]\s*$/, "");
  s = s.replace(/DIAVAN/gi, "DIVAN").replace(/MATTRESS\s*GAP/gi, "M.GAP").replace(/\bM\s?GAP/gi, "M.GAP");
  const o = { raw: (d2 || "").replace(/\s+/g, " ").trim(), specials: [] };
  let m;
  /* gap / divan / leg. AutoCount uses ", ”, '', ’’, "inch", "in" interchangeably
     and sometimes runs them together ("Divan10/Gap14", "8''+2\"leg",
     "10inch+NoLeg"). QUOTE = every quote-ish inch marker. */
  const QUOTE = `["”“"″'’‘′]{1,2}`;
  /* HYDRAULIC beds first: the height lives inside a note — "Col:X(hydraulic 16”/
     Inner 14”/4Pump)" — and the INNER figure is the divan. Run before the general
     divan pattern so it cannot grab the 16" outer or a pump count. */
  if (/HYDRAULIC/i.test(s)) {
    let hm2;
    if ((hm2 = /INNER[^0-9]{0,4}(\d+(?:\.\d+)?)/i.exec(s))) o.divan = parseFloat(hm2[1]);
    else if ((hm2 = /(\d+(?:\.\d+)?)[^0-9]{0,4}INNER/i.exec(s))) o.divan = parseFloat(hm2[1]);
    else if ((hm2 = /HYDRAULIC[^0-9]{0,4}(\d+(?:\.\d+)?)/i.exec(s))) o.divan = parseFloat(hm2[1]);
    if (o.divan != null) o.leg = 0;
    o.specials.push("hydraulic");
  }
  // gap: also "M'GP:", "M'Gap:", "M.Gap :", and runs-together "M.GAP:14INCHES"
  if ((m = new RegExp(`(?:MATT(?:RESS)?|M)?\\s*['’.]?\\s*(?:GAP|GP)\\s*[:：]?\\s*(\\d+(?:\\.\\d+)?)`, "i").exec(s))) o.gap = parseFloat(m[1]);
  if (o.divan == null && (m = new RegExp(`\\bDIV(?:AN)?\\.?\\s*[:：]?\\s*(\\d+(?:\\.\\d+)?)\\s*(?:${QUOTE}|INCH(?:ES)?|IN)?\\s*(?:\\+\\s*(\\d+(?:\\.\\d+)?))?`, "i").exec(s))) { o.divan = parseFloat(m[1]); if (m[2] != null) o.leg = parseFloat(m[2]); }
  if (/NO\s*LEGS?/i.test(s)) o.leg = 0;
  else if (o.leg === undefined && (m = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:${QUOTE}|INCH(?:ES)?|IN)?\\s*(?:WOODEN\\s*)?LEGS?`, "i").exec(s))) o.leg = parseFloat(m[1]);
  // a divan stated with no leg mentioned at all = no leg (0), per owner's model
  if (o.leg === undefined && o.divan != null && !/LEG/i.test(s)) o.leg = 0;
  /* divan written WITHOUT the word "divan": "PC151-07/8inch+4inchLeg/Gap14inch"
     or 'DIVAN"8"'. Take the height that sits right before the leg figure. */
  if (o.divan == null && (m = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:${QUOTE}|INCH(?:ES)?|IN)\\s*\\+\\s*(?:NO\\s*LEGS?|(\\d+(?:\\.\\d+)?))`, "i").exec(s))) {
    o.divan = parseFloat(m[1]); if (o.leg === undefined) o.leg = m[2] != null ? parseFloat(m[2]) : 0;
  }
  if (o.divan == null && (m = new RegExp(`DIVAN\\s*${QUOTE}?\\s*(\\d+(?:\\.\\d+)?)`, "i").exec(s))) o.divan = parseFloat(m[1]);
  /* hydraulic beds state the height inside the note: "hydraulic 16”/Inner 14”",
     "12”innerhydraulic", "Hydraulic (Inner 10\")" — the INNER figure is the divan. */
  /* SPECIAL SIZE (owner): anything outside S/SS/Q/K/SK is "SP" and MUST carry its
     dimensions, e.g. 190x220 / 153x200. Capture them from Desc2 or Description. */
  if ((m = /(\d{2,3})\s*[xX*]\s*(\d{2,3})/.exec(s))) o.size = `${m[1]}x${m[2]}`;
  /* colour: AutoCount writes it many ways — "COL:", "COLOUR:", "Color:",
     "COL CUSHION:", or the bare code first ("PC151-01/8inch+NoLeg/Gap12inch").
     Missing the Color:/bare forms left 1,500+ lines with no colour. */
  if ((m = /(?:COL(?:OUR|OR)?|CLR)(?:\s*CUSHION)?\s*[-:：;]\s*([A-Z0-9][A-Z0-9\- ]*?)(?:\s*[\/,;(]|\s*DIVAN?\b|\s*GAP|\s*M['’.]|$)/i.exec(s))) o.color = m[1].trim();
  else if ((m = /(?:COL(?:OUR|OR)?|CLR)\s+([A-Z]{2,4}\s?-?\s?\d{2,4}[\d-]*)/i.exec(s))) o.color = m[1].trim(); // "colour PC151-01" (no colon)
  else if ((m = /^\s*([A-Z]{2,4}\s?-?\s?\d{2,4}\s?-\s?\d{1,3})\b/i.exec(s))) o.color = m[1].trim(); // bare code at the start
  // a colour code anywhere in the text (e.g. "Mgap 14 inch / colour PC151-01 / ...")
  if (!o.color && (m = /\b((?:PC|KS|BF|NB|SF|BO|AM|CH|CX|SC|DC|PU|HR|GD|FG|ZL|NV|RU)\s?-?\s?\d{2,4}\s?-\s?\d{1,3}|SF-AT\s?\d{1,3})\b/i.exec(s))) o.color = m[1].trim();
  if (o.color && /^(TBC|KIV)$/i.test(o.color)) o.color = null;   // "COL: KIV" = not chosen
  // colour written as a plain word ("Cream/Divan10/Gap13", "sliver/...")
  if (!o.color && (m = /(?:^|\/)\s*(CREAM|SILVER|SLIVER|WHITE|BLACK|GREY|GRAY|BEIGE|BROWN|BLUE|GREEN|PINK|IVORY|CHARCOAL)\b/i.exec(s))) o.color = m[1].trim();
  // "8 inch : 2 inch leg" / "8 inch 1 inch leg" — divan then leg without +
  if (o.divan == null && (m = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:${QUOTE}|INCH(?:ES)?|IN)\\s*[:,]?\\s*(\\d+(?:\\.\\d+)?)\\s*(?:${QUOTE}|INCH(?:ES)?|IN)?\\s*LEGS?`, "i").exec(s))) { o.divan = parseFloat(m[1]); if (o.leg === undefined) o.leg = parseFloat(m[2]); }
  // specials -> variants.specials (the "Special Orders" picker). Capture all HB
  // phrasings ("HB straight", "HB without panel", "HB & divan fully cover", "HB
  // straight to wall"), fully-cover(ed), and push-back.
  const hm = /\bHB\b[^\/,()]*/i.exec(s); if (hm) { const t = hm[0].replace(/\s+/g, " ").trim(); if (t.length > 2) o.specials.push(t); }
  if (/FULL(?:Y)?\s*COVER(?:ED)?/i.test(s) && !o.specials.some((x) => /cover/i.test(x))) o.specials.push("fully cover");
  if (/PUSH\s*BACK/i.test(s)) o.specials.push("push back");
  /* Every other option the staff describe in words. Without these, 245 lines
     mentioning a real option (drawer / curve / headboard only / side panel /
     infront / one-piece divan) imported with NOTHING ticked. */
  if (/LEFT\s*DRAWER|DRAWER\s*(?:AT\s*)?LEFT/i.test(s)) o.specials.push("Left Drawer");
  if (/RIGHT\s*DRAWER|DRAWER\s*(?:AT\s*)?RIGHT/i.test(s)) o.specials.push("Right Drawer");
  if (/FRONT\s*DRAWER|DRAWER\s*(?:AT\s*)?FRONT/i.test(s)) o.specials.push("Front Drawer");
  if (/DRAWER/i.test(s) && !o.specials.some((x) => /drawer/i.test(x))) o.specials.push("Front Drawer"); // unqualified drawer = front
  if (/DIVAN\s*CURVE|CURVE\s*DIVAN|DO\s*CURVE|EDGE.*CURVE/i.test(s)) o.specials.push("Divan Curve");
  if (/HEADBOARD\s*ONLY|HB\s*ONLY/i.test(s)) o.specials.push("Headboard Only");
  if (/NO\s*SIDE\s*PANEL|WITHOUT\s*(?:SIDE\s*)?PANEL/i.test(s)) o.specials.push("No Side Panel");
  if (/1\s*PIECE\s*DIVAN|ONE\s*PIECE\s*DIVAN/i.test(s)) o.specials.push("1 Piece Divan");
  if (/NYLON/i.test(s)) o.specials.push("Nylon Fabric");
  if (/IN\s*FRONT\s*L|INFRONT\s*L|ADD\s*1.*INFRONT/i.test(s)) o.specials.push('Add 1" Infront L');
  if (/DIVAN\s*TOP\s*\(?W\)?/i.test(s)) o.specials.push("Divan Top(W)");
  if (/DIVAN\s*A11/i.test(s)) o.specials.push("Divan A11");
  if (/SEPARATE\s*BACKREST/i.test(s)) o.specials.push("Separate Backrest Packing");
  // "straight to wall" / "H/B Straight" / "Headboard straight" — all HB Straight
  if (/STRAIGHT\s*TO\s*(?:THE\s*)?WALL|H\/?B\s*STRAIGHT|HEADBOARD\s*STRAIGHT|FLIP\s*ON\s*WALL/i.test(s)) o.specials.push("HB Straight");
  // "pull out" = a pull-out drawer
  if (/PULL\s*OUT|PULLOUT|PUT\s*OUT/i.test(s) && !o.specials.some((x) => /drawer/i.test(x))) o.specials.push("Front Drawer");
  o.specials = [...new Set(o.specials)];
  return o;
}

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
  const fcx = new Map(); for (const r of fcRows) for (const k of [norm(r.colour_id), norm(r.label), strip(r.colour_id), strip(r.label)]) if (k && !fcx.has(k)) fcx.set(k, r);
  const findColour = (c) => {
    if (!c) return null;
    const pad = (x) => x.replace(/(?<!\d)(\d)$/, "0$1");
    const toks = [c, (c.trim().split(/\s+/)[0] || "")];
    const m = /[A-Z]{1,4}\s?\d{2,4}\s?-?\s?\d*/i.exec(c); if (m) toks.push(m[0]);
    const cands = [];
    for (const t of toks) { if (!t) continue; cands.push(norm(t), strip(t), pad(strip(t))); if (/^\d/.test(t.trim())) cands.push(strip("PC" + t), pad(strip("PC" + t))); }
    for (const t of cands) { const h = fcx.get(t); if (h) return h; }
    return null;
  };
  log(`suppliers=${sup.length} warehouses=${wh.length} products=${products.length} fabric_colours=${fcRows.length}`);

  // group by PO, drop sofa lines
  const groups = new Map();
  for (const r of rows) { if (isSofa(r.ItemCode)) continue; if (!groups.has(r.DocNo)) groups.set(r.DocNo, []); groups.get(r.DocNo).push(r); }
  let pos = [...groups.entries()];
  if (LIMIT) pos = pos.slice(0, LIMIT);

  const built = []; const exceptions = []; let noWh = 0, bfCol = 0, bfPending = 0;
  for (const [acPo, ls] of pos) {
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
      const prod = prodByCode.get(erp.toUpperCase());
      items.push({ erp, grp, name: (prod && prod.name) || l.Description || erp, sku: l.ItemCode, desc: l.Description, d2: l.Desc2, qty, received: done, up, lt, w, deliv: l.DelivDate, bf, variants });
    }
    if (!items.length) continue;
    built.push({ poNo: "HC-" + acPo, acPo, supId, poDate: h.DocDate, locWh: whId(h.Location), subtotal, status: anyReceived ? "PARTIALLY_RECEIVED" : "SUBMITTED", items });
  }

  log("");
  log(`non-sofa POs to import: ${built.length}; lines: ${built.reduce((a, o) => a + o.items.length, 0)}; value RM ${(built.reduce((a, o) => a + o.subtotal, 0) / 100).toLocaleString()}`);
  log(`bedframe colour resolved: ${bfCol}; pending (TBC/KIV): ${bfPending}; lines without a warehouse match: ${noWh}`);
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
      const ins = await tx`INSERT INTO scm.purchase_orders
        (po_number, linked_ac_docno, supplier_id, status, po_date, purchase_location_id, currency,
         subtotal_centi, tax_centi, total_centi, revision, company_id, created_by, notes)
        VALUES (${o.poNo}, ${o.acPo}, ${o.supId}, ${o.status}, ${o.poDate || sql`CURRENT_DATE`}, ${o.locWh}, 'MYR',
         ${o.subtotal}, 0, ${o.subtotal}, 1, 1, ${SYS_USER}, ${"imported from AutoCount " + o.acPo})
        ON CONFLICT (po_number) DO NOTHING RETURNING id`;
      if (!ins.length) return;
      const poId = ins[0].id;
      for (const i of o.items) {
        await tx`INSERT INTO scm.purchase_order_items
          (purchase_order_id, material_kind, material_code, material_name, supplier_sku,
           qty, unit_price_centi, line_total_centi, received_qty, item_group,
           description, description2, uom, notes, gap_inches, divan_height_inches, leg_height_inches,
           custom_specials, variants, warehouse_id, delivery_date, from_mrp, company_id)
          VALUES (${poId}, 'mfg_product', ${i.erp}, ${i.name}, ${i.sku},
           ${i.qty}, ${i.up}, ${i.lt}, ${i.received}, ${i.grp},
           ${i.desc || null}, ${i.d2 || null}, ${i.grp === "bedframe" ? "SET" : "UNIT"},
           ${i.d2 || null},
           ${i.bf && isFinite(i.bf.gap) ? Math.round(i.bf.gap) : null}, ${i.bf && isFinite(i.bf.divan) ? Math.round(i.bf.divan) : null}, ${i.bf && isFinite(i.bf.leg) ? Math.round(i.bf.leg) : null},
           ${i.variants && i.variants.specials && i.variants.specials.length ? sql.json(i.variants.specials) : null},
           ${i.variants ? sql.json(i.variants) : null}, ${i.w}, ${i.deliv || null}, false, 1)`;
        nItems++;
      }
      nPo++;
    });
  }
  log(`DONE. inserted POs=${nPo} items=${nItems}; skipped-existing=${existing.size}; exceptions=${exceptions.length}`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
