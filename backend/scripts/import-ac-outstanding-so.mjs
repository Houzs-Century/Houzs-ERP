#!/usr/bin/env node
// One-time GO-LIVE import: AutoCount OUTSTANDING Sales Orders -> ERP
// scm.mfg_sales_orders/_items/_payments for company 1 (Houzs Century).
//
// Owner rules baked in (2026-08-09):
//  - Company 1 only. SOFA EXCLUDED this round: an order with ANY sofa line is
//    skipped whole (mixed + all-sofa held for a later round).
//  - ERP doc_no REUSES the AutoCount SO number with an "HC-" prefix
//    (HC-SO-000021); the raw AutoCount number is also stored in linked_ac_docno
//    so write-back UPDATEs that AutoCount SO instead of creating a duplicate.
//  - Item codes come from the AutoCount<->ERP binding CSV (proper CSV parse);
//    free-text lines (no ItemCode) are resolved by NAME+size against the live
//    mfg_products pick list. Bedframe Desc2 is parsed into gap/divan/leg/colour
//    and any "special" (fully cover / push back / HB style) into custom_specials.
//  - Payment + balance reconcile: total = Sum(qty*unitprice),
//    balance = UDF_BALANCE, paid = total - balance; UDF_PAYEMENT -> account_sheet
//    + approval_code; payment date unknown -> CURRENT_DATE (system date).
//
// Idempotent: header INSERT ... ON CONFLICT (doc_no) DO NOTHING RETURNING; items
// and payments are written only for a NEWLY inserted header, so a re-run is safe.
//
// DRY-RUN by default (reads only; works with a read-only role). APPLY=1 to write.
//   node scripts/import-ac-outstanding-so.mjs            # dry-run report
//   APPLY=1 node scripts/import-ac-outstanding-so.mjs    # write
import fs from "node:fs";
import { parsePayment } from "./lib/ac-payment-udf.mjs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { parseBedframe } from "./lib/parse-bedframe.mjs";
import { SOFA_MODEL_ALIAS, parseSofa } from "./lib/parse-sofa.mjs";
import { buildFabricColourIndex, isPendingColour } from "./lib/fabric-colour-match.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const LIMIT = Number(process.env.LIMIT || 0); // 0 = all; else first N orders (for a small verification run)
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

// ---------- helpers ----------
const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");
const num = (v) => { const n = parseFloat(String(v ?? "").replace(/[^0-9.\-]/g, "")); return isFinite(n) ? n : 0; };
const centi = (v) => Math.round(num(v) * 100);

// RFC-4180-ish CSV line parser (handles "quoted, fields" and "" escapes)
function parseCsvLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else {
      if (c === '"') q = true;
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

const CATG = { MATTRESS: "mattress", BEDFRAME: "bedframe", ACC: "accessory", ACCESSORY: "accessory", BEDLINES: "accessory", DIFFUSER: "others", CARPET: "others", DINING: "others", OTHER: "others", SERVICE: "service", TRANS: "service", SOFA: "sofa" };
// Company-1 pick-list aliases: the binding CSV emits 2990-style service codes,
// but company 1's own pick list names delivery "TRANSPORTATION CHARGES".
const C1_ALIAS = { "SVC-DELIVERY": "TRANSPORTATION CHARGES", "SVC-DELIVERY-ADD": "TRANSPORTATION CHARGES", "SVC-DELIVERY-CROSS": "TRANSPORTATION CHARGES" };
// AutoCount SalesLocation short code -> ERP full warehouse name (what the picker stores)
const SALESLOC = { KL: "KL WAREHOUSE", PG: "PG WAREHOUSE", SRW: "SRW WAREHOUSE", SBH: "SBH WAREHOUSE", HQ: "HQ", JB: "KL WAREHOUSE", KUANTAN: "KL WAREHOUSE" };
const salesLoc = (c) => c ? (SALESLOC[c.trim().toUpperCase()] || c.trim()) : null;
const isSofa = (c) => /SOFA/i.test(c || "");
const uomOf = (g) => (g === "bedframe" ? "SET" : "UNIT");
const strip = (s) => norm(s).replace(/[^A-Z0-9]/g, "");
// Malaysian postcode (first 2 digits) -> state
function stateOf(pc) {
  if (!pc) return null; const p = +String(pc).slice(0, 2);
  const R = [[[1, 2], "Perlis"], [[5, 9], "Kedah"], [[10, 14], "Penang"], [[15, 18], "Kelantan"], [[20, 24], "Terengganu"], [[25, 28], "Pahang"], [[30, 36], "Perak"], [[39, 39], "Pahang"], [[40, 48], "Selangor"], [[49, 49], "Pahang"], [[50, 60], "Kuala Lumpur"], [[62, 62], "Putrajaya"], [[63, 64], "Selangor"], [[68, 68], "Selangor"], [[69, 69], "Pahang"], [[70, 73], "Negeri Sembilan"], [[75, 78], "Melaka"], [[79, 86], "Johor"], [[87, 87], "Labuan"], [[88, 91], "Sabah"], [[93, 98], "Sarawak"]];
  for (const [[a, b], s] of R) if (p >= a && p <= b) return s; return null;
}

/* parsePayment moved to scripts/lib/ac-payment-udf.mjs, beside its INVERSE.
   The write-back has to emit this same format to send account_sheet and
   approval_code back, and a format read in one file and written in another is
   how the two stop agreeing. */


// SOFA decomposition lives in scripts/lib/parse-sofa.mjs (shared with the PO import).
// free-text name resolver against the live pick list
function buildNameResolver(products) {
  const byName = new Map(); // normalized name -> code
  const byNameNoDim = new Map(); // name w/o (dims) -> code
  const stripDim = (s) => norm(s).replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  for (const p of products) { byName.set(norm(p.name), p.code); const k = stripDim(p.name); if (!byNameNoDim.has(k)) byNameNoDim.set(k, p.code); }
  const SIZE = [[/\b183\s*X\s*190|6\s*FT|\(K\)/i, "(K)"], [/\b152\s*X\s*190|5\s*FT|\(Q\)/i, "(Q)"], [/\b107\s*X\s*190|3\.5\s*FT|\(SS\)/i, "(SS)"], [/\b(?<!1)90\s*X\s*190|3\s*FT|\(S\)/i, "(S)"], [/\b200\s*X\s*200|\(SK\)/i, "(SK)"]];
  return (desc) => {
    if (!desc) return null;
    const n = norm(desc);
    if (byName.has(n)) return byName.get(n);
    const k = stripDim(desc);
    if (byNameNoDim.has(k)) return byNameNoDim.get(k);
    if (/DELIVERY\s*FEE|DELIVERY\s*CHARGE|TRANSPORT/i.test(desc)) return "TRANSPORTATION CHARGES";
    // token match: brand/model words + size suffix
    let size = null; for (const [re, sz] of SIZE) if (re.test(desc)) { size = sz; break; }
    if (size) {
      const base = k.replace(/\bB\/?FRAME\b/g, "BEDFRAME").replace(/\bMATTRESS\b/g, "MATT").replace(/^NK-|^NB-|^DL-|^AK-/g, "").trim();
      const words = base.split(" ").filter((w) => w.length > 2);
      let best = null, bestScore = 0;
      for (const p of products) { const pn = stripDim(p.name); if (!p.code.toUpperCase().endsWith(size)) continue; const score = words.filter((w) => pn.includes(w)).length; if (score > bestScore) { bestScore = score; best = p.code; } }
      if (best && bestScore >= 2) return best;
    }
    return null;
  };
}

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}${LIMIT ? ` LIMIT=${LIMIT}` : ""}`);

  // ---- load AutoCount outstanding export (gz) ----
  const gzPath = path.join(here, "data", "ac-outstanding-so.json.gz");
  const rows = JSON.parse(zlib.gunzipSync(fs.readFileSync(gzPath)).toString("utf8").replace(/^﻿/, ""));
  log(`AutoCount outstanding lines: ${rows.length}`);

  // ---- load ac->erp binding (proper CSV parse) ----
  const csv = fs.readFileSync(path.join(here, "data", "autocount-erp-mapping-1561.csv"), "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  csv.shift();
  const byAc = new Map();
  for (const ln of csv) { const f = parseCsvLine(ln); if (f[0]) byAc.set(norm(f[0]), { erp: (f[1] || "").trim(), cat: (f[3] || "").trim().toUpperCase() }); }
  log(`binding rows: ${byAc.size}`);

  // ---- live pick list (company 1) ----
  const products = await sql`SELECT code, name, cost_price_sen FROM scm.mfg_products WHERE company_id = 1`;
  const codeSet = new Set(products.map((p) => p.code.toUpperCase()));
  const prodId = new Map(products.map((p) => [p.code.toUpperCase(), p]));
  const SYS_USER = "00000000-0000-4000-8000-000000000001";
  const wh = await sql`SELECT id, code FROM scm.warehouses WHERE company_id = 1`;
  const whByCode = new Map(wh.map((w) => [w.code.toUpperCase(), w.id]));
  const whId = (loc) => { if (!loc) return null; const k = loc.trim().toUpperCase(); return whByCode.get((SALESLOC[k] || k).toUpperCase()) || whByCode.get(k) || null; };
  const resolveName = buildNameResolver(products);
  log(`mfg_products (company 1): ${products.length}`);

  // ---- structured-field masters (salesperson / colour / venue) ----
  const staff = await sql`SELECT id, name FROM scm.staff`;
  const staffId = new Map(staff.map((s) => [norm(s.name), s.id]));
  const bindCsv = fs.readFileSync(path.join(here, "data", "agent-staff-binding.csv"), "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean); bindCsv.shift();
  const agentBind = new Map(); // norm(agent) -> {name} | {create:true}
  for (const ln of bindCsv) { const f = parseCsvLine(ln); const r = f[1] || ""; agentBind.set(norm(f[0]), r.startsWith("BIND:") ? { name: r.slice(5) } : { create: true }); }
  const createAgents = new Set(); // agent display names needing an inactive staff row
  const fcRows = await sql`SELECT fabric_id, colour_id, label FROM scm.fabric_colours WHERE company_id = 1`;
  const { findColour } = buildFabricColourIndex(fcRows);
  // #1998 contract: an unlabelled colour is read only when the library CONFIRMS
  // the code. The predicate was built for the backfill and the importers never
  // passed it, so colour-first Desc2 lost even library-known codes.
  const knownColour = (c) => { const h = findColour(c); return h ? h.colour_id : null; };
  // product -> allowed colour_ids (so we don't set a colour the picker would drop).
  // Best-effort: the colour-config table's product_id may reference a different
  // product table/type; if the join fails we skip this check (colour still
  // resolves via fabric_colours) rather than break the import.
  const allowedColour = new Map();
  try {
    const pbc = await sql`SELECT p.code, bc.label AS colour_id FROM scm.product_bedframe_colours pc JOIN scm.mfg_products p ON p.id::text = pc.product_id::text JOIN scm.bedframe_colours bc ON bc.id::text = pc.colour_id::text WHERE pc.company_id = 1 AND pc.active`;
    for (const r of pbc) { const k = r.code.toUpperCase(); if (!allowedColour.has(k)) allowedColour.set(k, new Set()); allowedColour.get(k).add(norm(r.colour_id)); }
  } catch { /* skip product-colour validation */ }
  let venues = []; try { venues = await sql`SELECT id, name FROM scm.venues WHERE company_id = 1`; } catch { /* venue is text */ }
  const findVenue = (v) => { if (!v) return null; return venues.find((x) => norm(x.name) === norm(v)) || venues.find((x) => norm(x.name).includes(norm(v)) || norm(v).includes(norm(x.name))) || null; };
  const resolveSalesperson = (agent) => { const b = agentBind.get(norm(agent)); if (!b) return null; if (b.name) return staffId.get(norm(b.name)) || null; createAgents.add((agent || "").trim()); return { create: norm(agent) }; };
  log(`staff=${staff.length} agentBindings=${agentBind.size} fabric_colours=${fcRows.length} venues=${venues.length}`);

  // ---- group into orders, pick pure-non-sofa ----
  const orders = new Map();
  for (const r of rows) { if (!orders.has(r.DocNo)) orders.set(r.DocNo, []); orders.get(r.DocNo).push(r); }
  const SOFA_ON = process.env.SOFA === "1";
  /* OWNER'S DO RULE (2026-08-10): "outstanding 指的是还没有转成 DO ... 如果
     convert to PO,它其实依然算作 outstanding". The export still carries orders
     whose every line is fully DO-transferred; importing those puts DELIVERED
     work into the ERP as outstanding. Drop them here — and never look at
     TransferedPOQty, which must NOT disqualify a line. Set ALLOW_DELIVERED=1
     only to reproduce the old behaviour for a comparison run. */
  const qn = (v) => { const x = parseFloat(v); return isFinite(x) ? x : 0; };
  const fullyDelivered = (ls) => ls.length > 0 && !ls.some((l) => qn(l.Qty) > qn(l.TransferedQty));
  let skipDelivered = 0;
  if (process.env.ALLOW_DELIVERED !== "1") {
    for (const [doc, ls] of [...orders]) if (fullyDelivered(ls)) { orders.delete(doc); skipDelivered++; }
  }
  let pure = [], skipMixed = 0, skipAllSofa = 0, sofaOrders = 0;
  for (const [doc, ls] of orders) {
    const s = ls.filter((l) => isSofa(l.ItemCode)).length;
    if (s === 0) pure.push([doc, ls]);
    else if (SOFA_ON) { sofaOrders++; pure.push([doc, ls]); }
    else if (s === ls.length) skipAllSofa++; else skipMixed++;
  }
  pure.sort((a, b) => (a[1][0].DocDate || "") < (b[1][0].DocDate || "") ? -1 : 1);
  const ONLY = (process.env.DOC || "").trim().replace(/^HC-/, ""); // import just one AutoCount DocNo (verification)
  if (ONLY) pure = pure.filter(([d]) => d === ONLY);
  if (LIMIT) pure = pure.slice(0, LIMIT);

  // ---- build ----
  const built = []; const exceptions = []; const notInPickList = new Set(); const sofaDecode = [];
  const catTotals = { mattress: 0, bedframe: 0, accessory: 0, service: 0, others: 0, sofa: 0 };
  let totAll = 0, balAll = 0, droppedZero = 0;
  for (const [acDoc, ls] of pure) {
    const h = ls[0];
    const items = []; let total = 0; const bucket = { mattress: 0, bedframe: 0, accessory: 0, service: 0, others: 0, sofa: 0 };
    let ln = 0;
    for (const l of ls) {
      ln++;
      const hit = byAc.get(norm(l.ItemCode));
      let erp = hit ? hit.erp : null; let cat = hit ? hit.cat : null;
      let resolvedFree = false;
      if (!erp) { // free-text or unmapped -> name resolve
        const r = resolveName(l.Description);
        if (r) { erp = r; resolvedFree = true; const pcat = products.find((p) => p.code === r); cat = /SVC|DELIVER/i.test(r) ? "SERVICE" : (l.Description && /MATT/i.test(l.Description) ? "MATTRESS" : /FRAME/i.test(l.Description || "") ? "BEDFRAME" : "OTHER"); }
      }
      if (erp && !codeSet.has(erp.toUpperCase()) && C1_ALIAS[erp.toUpperCase()]) erp = C1_ALIAS[erp.toUpperCase()];
      if (!erp) {
        // Owner 2026-08-09: blank AutoCount lines (no code, no name) with a price
        // are charges -> TRANSPORTATION CHARGES; a zero-value blank line is dropped.
        if (num(l.UnitPrice) > 0) { erp = "TRANSPORTATION CHARGES"; cat = "TRANS"; resolvedFree = true; }
        else { droppedZero++; continue; }
      }
      const grp = CATG[cat] || "others";
      if (!codeSet.has(erp.toUpperCase())) notInPickList.add(erp);
      const qty = Math.round(num(l.Qty)) || 1;
      const up = centi(l.UnitPrice); const lineTotal = up * qty; total += lineTotal; if (bucket[grp] !== undefined) bucket[grp] += lineTotal;
      let bf = null, variants = null;
      if (grp === "bedframe") {
        bf = parseBedframe(l.Desc2);
        const pending = isPendingColour(bf.color);          // TBC/KIV -> colour not chosen, leave blank (not a bug)
        const fcHit = pending ? null : findColour(bf.color);
        if (bf.color && !pending && !fcHit) exceptions.push({ ac: acDoc, code: l.ItemCode, desc: `colour "${bf.color}" not in fabric_colours`, price: 0 });
        else if (fcHit) { const allow = allowedColour.get((erp || "").toUpperCase()); if (allow && !allow.has(norm(fcHit.colour_id))) exceptions.push({ ac: acDoc, code: l.ItemCode, desc: `colour ${fcHit.colour_id} not a configured option for ${erp}`, price: 0 }); }
        const tot = (Number(bf.gap) || 0) + (Number(bf.divan) || 0) + (Number(bf.leg) || 0);
        // key names MUST match a real UI-created line exactly (the Fabrics picker
        // reads fabricCode; totalHeight is shown as "Total height (auto)")
        variants = {
          fabricId: fcHit ? fcHit.fabric_id : null, colourId: fcHit ? fcHit.colour_id : null,
          fabricCode: fcHit ? fcHit.colour_id : null, colourLabel: fcHit ? fcHit.label : null,
          fabricLabel: fcHit ? fcHit.fabric_id : null,
          gap: bf.gap != null ? bf.gap + '"' : null, divanHeight: bf.divan != null ? bf.divan + '"' : null,
          legHeight: bf.leg != null ? bf.leg + '"' : null, totalHeight: tot ? tot + '"' : null,
          specials: bf.specials || [],
        };
      }
      // description MUST be the ERP product name (what a picker-selected item stores),
      // not the AutoCount Description — else list shows item_code but Edit shows the AC text.
      // ── SOFA: decompose one AutoCount sofa line into per-compartment lines ──
      if (grp === "sofa" && process.env.SOFA === "1") {
        let model = (erp || "").replace(/-1S$/i, "");
        model = SOFA_MODEL_ALIAS[model] || model;
        // owner 2026-08-10: R 的含义看款 — 有 recliner/power 件的款才有 recliner 语义
        const RECL_PROBE = ["-1S(R)", "-1A(R)(LHF)", "-1A(P)(LHF)", "-1S(P)"];
        const reclOK = RECL_PROBE.some((sfx) => codeSet.has((model + sfx).toUpperCase()));
        const ps = parseSofa(l.Desc2, model, reclOK, { knownColour });
        const pieceCodes = ps.pieces.map((c) => `${model}-${c}`);
        const allExist = pieceCodes.length > 0 && pieceCodes.every((c) => codeSet.has(c.toUpperCase()));
        const fullyOk = ps.conf !== "low" && allExist;
        const colour = isPendingColour(ps.color) ? null : ps.color;
        const fcHit = colour ? findColour(colour) : null;
        sofaDecode.push({ ac: acDoc, code: l.ItemCode, d2: l.Desc2, model, cm: !colour || !!fcHit,
          pieces: fullyOk ? ps.pieces : null, size: ps.size, colour: ps.color,
          conf: fullyOk ? ps.conf : "low", why: fullyOk ? ps.why : [...ps.why, ...(allExist || !pieceCodes.length ? [] : ["piece SKU missing: " + pieceCodes.filter((c) => !codeSet.has(c.toUpperCase())).join(",")])] });
        if (fullyOk) {
          let first = true;
          for (const comp of ps.pieces) {
            const code = `${model}-${comp}`;
            const pr = prodId.get(code.toUpperCase());
            items.push({ erp: code, grp: "sofa", desc: (pr && pr.name) || code, d2: l.Desc2,
              qty, up: first ? up : 0, lineTotal: first ? lineTotal : 0, loc: l.Location, bf: null,
              variants: { seatHeight: ps.size, fabricId: fcHit ? fcHit.fabric_id : null,
                colourId: fcHit ? fcHit.colour_id : null, fabricCode: fcHit ? fcHit.colour_id : null,
                colourLabel: fcHit ? fcHit.label : (colour || null), fabricLabel: fcHit ? fcHit.fabric_id : null,
                specials: ps.specials },
              resolvedFree: false, unitCost: 0, lineCost: 0, warehouseId: whId(l.Location),
              remark: ps.why.length ? "sofa: " + ps.why.join("; ") : null });
            first = false;
          }
        } else {
          // never guess pieces — placeholder on the base SKU, human completes
          const base = `${model}-1S`;
          const pr = prodId.get(base.toUpperCase());
          items.push({ erp: base, grp: "sofa", desc: (pr && pr.name) || base, d2: l.Desc2,
            qty, up, lineTotal, loc: l.Location, bf: null,
            variants: { seatHeight: ps.size || null, colourLabel: colour || null, specials: ps.specials },
            resolvedFree: false, unitCost: 0, lineCost: 0, warehouseId: whId(l.Location),
            remark: "SOFA UNPARSED — 按图/原文补件: " + (ps.why.join("; ") || "unreadable") });
        }
        continue;
      }
      const prodRow = prodId.get((erp || "").toUpperCase());
      const unitCost = prodRow && prodRow.cost_price_sen ? prodRow.cost_price_sen : 0; // per-unit cost (sen)
      const lineCost = unitCost * qty;
      items.push({ erp, grp, desc: (prodRow && prodRow.name) || l.Description, d2: l.Desc2, qty, up, lineTotal, loc: l.Location, bf, variants, resolvedFree, unitCost, lineCost, warehouseId: whId(l.Location) });
    }
    const bal = centi(h.UDF_BALANCE); const paid = Math.max(0, total - bal);
    const pay = parsePayment(h.UDF_PAYEMENT);
    // ---- structured picker fields ----
    const salespersonId = resolveSalesperson(h.SalesAgent); // uuid | {create} | null
    const addrStr = [h.InvAddr1, h.InvAddr2, h.InvAddr3, h.InvAddr4].filter(Boolean).join(", ");
    const pcM = /\b(\d{5})\b/.exec(addrStr); const postcode = pcM ? pcM[1] : null;
    const cState = stateOf(postcode);
    let city = null; if (postcode) city = (addrStr.slice(addrStr.indexOf(postcode) + 5).split(",")[0] || "").replace(new RegExp(cState || "$^", "i"), "").trim() || null;
    let emergency = null; { const dp = (h.DeliverPhone1 || "").trim(); if (dp && norm(dp) !== norm(h.Phone1)) emergency = dp; else { const parts = (h.Phone1 || "").split(/[\/,]/).map((x) => x.trim()).filter(Boolean); if (parts.length > 1) emergency = parts[1]; } }
    const venue = findVenue(h.UDF_VENUE);
    const procDate = h.UDF_PDate || null; // present only after the re-export adds UDF_PDate
    // rule (owner): a PROCESSED order (has processing date) must carry full address + bedframe colour
    if (procDate) { const bfMissing = items.some((i) => i.grp === "bedframe" && (!i.variants || !i.variants.colourId)); const sofaUnparsed = items.some((i) => i.grp === "sofa" && /SOFA UNPARSED/.test(i.remark || "")); if (!addrStr || bfMissing || sofaUnparsed) exceptions.push({ ac: acDoc, code: "(processed)", desc: `processed order missing ${!addrStr ? "address " : ""}${bfMissing ? "bedframe colour " : ""}${sofaUnparsed ? "SOFA PIECES(看图补件!)" : ""}`.trim(), price: 0 }); }
    totAll += total; balAll += bal; for (const k in bucket) catTotals[k] += bucket[k];
    built.push({ docNo: "HC-" + acDoc, acDoc, h, items, total, bal, paid, pay, bucket, salespersonId, postcode, city, cState, emergency, venue, procDate });
  }

  // ---- report ----
  log("");
  log(`Source orders ${orders.size} / lines ${rows.length}`);
  log(`  skipped fully-delivered (already a DO, owner's rule): ${skipDelivered}`);
  log(`  importing: ${built.length}${LIMIT ? ` (LIMIT ${LIMIT})` : ""}${process.env.SOFA === "1" ? ` (incl ${sofaOrders} sofa orders)` : " (pure non-sofa)"}`);
  log(`  skipped mixed / all-sofa:  ${skipMixed} / ${skipAllSofa}`);
  if (sofaDecode.length) {
    const good = sofaDecode.filter((s) => s.pieces);
    const bad = sofaDecode.filter((s) => !s.pieces);
    log("");
    log(`SOFA decode: ${good.length} decomposed, ${bad.length} placeholder (never guessed)`);
    const pd = new Set(); // processed docs for flagging
    for (const b of built) if (b.procDate) pd.add(b.acDoc);
    for (const s of sofaDecode) {
      const tag = pd.has(s.ac) ? "[PROC]" : "      ";
      if (s.pieces) log(`  ${tag} ${s.ac} ${s.code} | ${JSON.stringify(s.d2).slice(0, 70)} -> ${s.pieces.join(" + ")} @${s.size ?? "?"} col=${s.colour ?? "-"}${s.colour && !s.cm ? " col✗库无此色" : ""}${s.why.length ? " (" + s.why.join("; ") + ")" : ""}`);
      else log(`  ${tag} ${s.ac} ${s.code} | ${JSON.stringify(s.d2).slice(0, 70)} -> PLACEHOLDER ${s.model}-1S (${s.why.join("; ")})`);
    }
  }
  log(`Total RM ${(totAll / 100).toLocaleString()}  balance RM ${(balAll / 100).toLocaleString()}  paid RM ${((totAll - balAll) / 100).toLocaleString()}`);
  log(`Category RM: ` + Object.entries(catTotals).map(([k, v]) => `${k}=${(v / 100).toLocaleString()}`).join("  "));
  log(`Blank zero-value lines dropped: ${droppedZero}`);
  log(`Unmatched lines (exceptions): ${exceptions.length}`);
  for (const e of exceptions.slice(0, 20)) log(`   ${e.ac}  code="${e.code}"  "${e.desc}"  RM${e.price}`);
  if (notInPickList.size) { log(`erp codes NOT in company-1 pick list: ${notInPickList.size}`); for (const c of [...notInPickList].slice(0, 20)) log(`   ${c}`); }
  log(`staff to auto-create (inactive salesperson): ${createAgents.size}  [${[...createAgents].join(", ")}]`);

  // ---- sample preview (structured picker fields) for owner Edit-verification ----
  for (const o of built.filter((x) => ["HC-SO-013152", "HC-SO-013160", "HC-SO-013124"].includes(x.docNo))) {
    log(`\nSAMPLE ${o.docNo}  ${o.h.DebtorName}`);
    log(`  salesperson: "${o.h.SalesAgent}" -> ${o.salespersonId && o.salespersonId.create ? "(create inactive staff)" : "salesperson_id=" + o.salespersonId}`);
    log(`  venue=${o.venue ? "venue_id=" + o.venue.id : '"' + (o.h.UDF_VENUE || "") + '" (text)'}  emergency=${o.emergency || "-"}  postcode/city/state=${o.postcode || "-"} / ${o.city || "-"} / ${o.cState || "-"}`);
    for (const i of o.items.filter((x) => x.grp === "bedframe")) log(`  bedframe ${i.erp}: variants=${JSON.stringify(i.variants)}`);
  }

  if (!APPLY) { log("\nDRY-RUN only — no writes. Set APPLY=1 to import."); await sql.end(); return; }

  // ---- apply (BULK, chunked) — per-order round trips are far too slow over the
  //      GitHub->Supabase link, so build multi-row INSERTs (~3 statements per
  //      150-order chunk). Idempotent: skip doc_nos already present. ----
  log("\nAPPLYING (bulk)…");
  await sql`ALTER TABLE scm.mfg_sales_orders ADD COLUMN IF NOT EXISTS linked_ac_docno text`;
  await sql`CREATE INDEX IF NOT EXISTS mfg_so_linked_ac_docno_idx ON scm.mfg_sales_orders(linked_ac_docno)`;
  // single-order verification (DOC=...): delete that one order first so it re-imports
  if (ONLY) { const d = "HC-" + ONLY; await sql`DELETE FROM scm.mfg_sales_order_payments WHERE so_doc_no = ${d}`; await sql`DELETE FROM scm.mfg_sales_order_items WHERE doc_no = ${d}`; await sql`DELETE FROM scm.mfg_sales_orders WHERE doc_no = ${d}`; log(`DOC mode: cleared existing ${d} for re-import`); }

  const esc = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const CUR = { __raw: "CURRENT_DATE" };
  const V = (v) => {
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "object" && v.__raw) return v.__raw;
    if (typeof v === "object" && "__json" in v) return v.__json == null ? "NULL" : esc(JSON.stringify(v.__json)) + "::jsonb";
    if (typeof v === "number") return isFinite(v) ? String(v) : "NULL";
    if (typeof v === "boolean") return v ? "true" : "false";
    return esc(v);
  };

  // auto-create INACTIVE salesperson staff for AutoCount agents with no ERP account
  const toCreate = [...createAgents].filter((n) => !staffId.has(norm(n)));
  if (toCreate.length) {
    const initialsOf = (n) => (norm(n).split(/\s+/).map((w) => w[0]).join("").slice(0, 4)) || "X";
    const vals = toCreate.map((n) => "(" + ["gen_random_uuid()", V("ACIMP-" + strip(n).slice(0, 12)), V(n), V(initialsOf(n)), "'#9CA3AF'", "'sales'", "false"].join(",") + ")").join(",");
    await sql.unsafe(`INSERT INTO scm.staff (id, staff_code, name, initials, color, role, active) VALUES ${vals} ON CONFLICT DO NOTHING`);
    log(`created ${toCreate.length} inactive salesperson staff`);
  }
  if (createAgents.size) { const created = await sql`SELECT id, name FROM scm.staff WHERE name = ANY(${[...createAgents]})`; for (const r of created) staffId.set(norm(r.name), r.id); }
  // resolve {create} salesperson placeholders now that staff exist
  for (const o of built) { if (o.salespersonId && o.salespersonId.create) o.salespersonId = staffId.get(o.salespersonId.create) || null; }

  // idempotency: which doc_nos are already in?
  const allDocs = built.map((o) => o.docNo);
  const existing = new Set();
  for (let i = 0; i < allDocs.length; i += 1000) {
    const rows = await sql`SELECT doc_no FROM scm.mfg_sales_orders WHERE company_id = 1 AND doc_no = ANY(${allDocs.slice(i, i + 1000)})`;
    for (const r of rows) existing.add(r.doc_no);
  }
  const todo = built.filter((o) => !existing.has(o.docNo));
  log(`already imported: ${existing.size}; to insert: ${todo.length}`);

  const HCOLS = "(doc_no,linked_ac_docno,so_date,debtor_name,debtor_code,agent,salesperson_id,sales_location,ref,customer_so_no,venue,venue_id,branding,address1,address2,address3,address4,postcode,city,customer_state,phone,emergency_contact_phone,status,company_id,currency,local_total_sen,balance_sen,paid_sen,deposit_sen,line_count,mattress_sofa_sen,bedframe_sen,accessories_sen,service_sen,others_sen,payment_method,approval_code,payment_date,proceeded_at)";
  /* warehouse_id was resolved per line (`warehouseId: whId(l.Location)`) and then
     left OUT of this list, so every migrated line landed with the location as
     text and no warehouse. Stock is bucketed by warehouse_id, so nothing could
     ever be allocated to them — sofa hardest of all, because
     sofa-set-coverage.findCoveringBatch returns null on a null warehouse before
     it reads any stock. Existing rows are repaired by
     backfill-so-line-warehouse.mjs; this stops it recurring. */
  const ICOLS = "(doc_no,line_no,item_group,item_code,description,description2,uom,location,warehouse_id,qty,unit_price_sen,total_sen,balance_sen,company_id,gap_inches,divan_height_inches,leg_height_inches,variants,custom_specials,remark)";
  const PCOLS = "(so_doc_no,paid_at,method,approval_code,account_sheet,amount_sen,is_deposit,company_id,note)";

  let nOrders = 0, nItems = 0, nPay = 0;
  const CHUNK = 150;
  for (let i = 0; i < todo.length; i += CHUNK) {
    const batch = todo.slice(i, i + CHUNK);
    const hv = [], iv = [], pv = [];
    for (const o of batch) {
      const h = o.h;
      hv.push("(" + [
        V(o.docNo), V(o.acDoc), h.DocDate ? V(h.DocDate) : V(CUR), V(h.DebtorName || "CUSTOMER"), V(h.DebtorCode || null), V(h.SalesAgent || null), V(o.salespersonId || null),
        V(salesLoc(h.SalesLocation)), V(h.Ref || null), V(h.Ref || null), V(h.UDF_VENUE || null), V(o.venue ? o.venue.id : null), V(h.UDF_BRANDING || null),
        V(h.InvAddr1 || null), V(h.InvAddr2 || null), V(h.InvAddr3 || null), V(h.InvAddr4 || null), V(o.postcode || null), V(o.city || null), V(o.cState || null),
        V(h.Phone1 || null), V(o.emergency || null),
        V("CONFIRMED"), "1", V("MYR"), V(o.total), V(o.bal), V(o.paid), V(o.paid), V(o.items.length),
        V(o.bucket.mattress + (o.bucket.sofa || 0)), V(o.bucket.bedframe), V(o.bucket.accessory), V(o.bucket.service), V(o.bucket.others),
        V(o.paid > 0 ? "imported" : null), V(o.pay.appr || null), o.paid > 0 ? (h.DocDate ? V(h.DocDate) : V(CUR)) : "NULL",
        o.procDate ? V(o.procDate) : "NULL",
      ].join(",") + ")");
      let lineNo = 0;
      for (const it of o.items) {
        lineNo++;
        const variants = it.variants || null; // resolved {fabricId,colourId,colourLabel,gap,divanHeight,legHeight,specials}
        const specials = it.variants && it.variants.specials && it.variants.specials.length ? it.variants.specials : null;
        iv.push("(" + [V(o.docNo), String(lineNo), V(it.grp), V(it.erp), V(it.desc || null), V(it.d2 || null), V(uomOf(it.grp)), V(it.loc || null), V(it.warehouseId || null), String(it.qty), V(it.up), V(it.lineTotal), V(it.lineTotal), "1", it.bf && isFinite(it.bf.gap) ? String(Math.round(it.bf.gap)) : "NULL", it.bf && isFinite(it.bf.divan) ? String(Math.round(it.bf.divan)) : "NULL", it.bf && isFinite(it.bf.leg) ? String(Math.round(it.bf.leg)) : "NULL", V({ __json: variants }), V({ __json: specials }), V(it.remark ?? (it.resolvedFree ? "name-matched from free-text" : null))].join(",") + ")");
        nItems++;
      }
      if (o.paid > 0) { pv.push("(" + [V(o.docNo), h.DocDate ? V(h.DocDate) : V(CUR), V("imported"), V(o.pay.appr || null), V(o.pay.acct || null), V(o.paid), "true", "1", V("imported from AutoCount " + o.acDoc + (o.pay.extra ? " [" + o.pay.extra + "]" : ""))].join(",") + ")"); nPay++; }
      nOrders++;
    }
    await sql.begin(async (tx) => {
      await tx.unsafe(`INSERT INTO scm.mfg_sales_orders ${HCOLS} VALUES ${hv.join(",")} ON CONFLICT (doc_no) DO NOTHING`);
      if (iv.length) await tx.unsafe(`INSERT INTO scm.mfg_sales_order_items ${ICOLS} VALUES ${iv.join(",")}`);
      if (pv.length) await tx.unsafe(`INSERT INTO scm.mfg_sales_order_payments ${PCOLS} VALUES ${pv.join(",")}`);
    });
    log(`  ..${Math.min(i + CHUNK, todo.length)}/${todo.length}`);
  }
  log(`DONE. inserted orders=${nOrders} items=${nItems} payments=${nPay}; skipped-existing=${existing.size}; exceptions=${exceptions.length}`);
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
