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
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

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
const isSofa = (c) => /SOFA/i.test(c || "");
const uomOf = (g) => (g === "bedframe" ? "SET" : "UNIT");

function parseBedframe(d2) {
  const s = (d2 || "").replace(/\s+/g, " ").trim();
  const o = { raw: s, specials: [] };
  let m;
  if ((m = /(?:MATT(?:RESS)?\.?\s*GAP|M\.?\s*GAP|\bGAP)\s*[:：]?\s*(\d+(?:\.\d+)?)/i.exec(s))) o.gap = parseFloat(m[1]);
  if ((m = /\bDIV(?:AN)?\.?\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(?:"|INCH|IN)?\s*(?:\+\s*(\d+(?:\.\d+)?))?/i.exec(s))) { o.divan = parseFloat(m[1]); if (m[2]) o.leg = parseFloat(m[2]); }
  if (/NO\s*LEG/i.test(s)) o.leg = 0;
  else if (o.leg === undefined && (m = /(\d+(?:\.\d+)?)\s*(?:"|INCH|IN)?\s*(?:WOODEN\s*)?LEG/i.exec(s))) o.leg = parseFloat(m[1]);
  if ((m = /COL(?:OUR)?(?:\s*CUSHION)?\s*[:：;]?\s*([A-Z0-9][A-Z0-9\- ]*?)(?:\s*[\/,;]|\s*DIVAN|\s*GAP|$)/i.exec(s))) o.color = m[1].trim();
  if (/FULL\s*COVER|FULLCOVER/i.test(s)) o.specials.push("fully cover");
  if (/PUSH\s*BACK/i.test(s)) o.specials.push("push back");
  if (/HB\s+([A-Z ]+?STRAIGHT|DO\s+STRAIGHT|DIVAN)/i.test(s)) { const hm = /HB\s+([A-Z ]+)/i.exec(s); if (hm) o.specials.push("HB " + hm[1].trim().split(/[\/,]/)[0].trim()); }
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
  const products = await sql`SELECT code, name FROM scm.mfg_products WHERE company_id = 1`;
  const codeSet = new Set(products.map((p) => p.code.toUpperCase()));
  const resolveName = buildNameResolver(products);
  log(`mfg_products (company 1): ${products.length}`);

  // ---- group into orders, pick pure-non-sofa ----
  const orders = new Map();
  for (const r of rows) { if (!orders.has(r.DocNo)) orders.set(r.DocNo, []); orders.get(r.DocNo).push(r); }
  let pure = [], skipMixed = 0, skipAllSofa = 0;
  for (const [doc, ls] of orders) { const s = ls.filter((l) => isSofa(l.ItemCode)).length; if (s === 0) pure.push([doc, ls]); else if (s === ls.length) skipAllSofa++; else skipMixed++; }
  pure.sort((a, b) => (a[1][0].DocDate || "") < (b[1][0].DocDate || "") ? -1 : 1);
  if (LIMIT) pure = pure.slice(0, LIMIT);

  // ---- build ----
  const built = []; const exceptions = []; const notInPickList = new Set();
  const catTotals = { mattress: 0, bedframe: 0, accessory: 0, service: 0, others: 0 };
  let totAll = 0, balAll = 0, droppedZero = 0;
  for (const [acDoc, ls] of pure) {
    const h = ls[0];
    const items = []; let total = 0; const bucket = { mattress: 0, bedframe: 0, accessory: 0, service: 0, others: 0 };
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
      const bf = grp === "bedframe" ? parseBedframe(l.Desc2) : null;
      items.push({ erp, grp, desc: l.Description, d2: l.Desc2, qty, up, lineTotal, loc: l.Location, bf, resolvedFree });
    }
    const bal = centi(h.UDF_BALANCE); const paid = Math.max(0, total - bal);
    const pay = parsePayment(h.UDF_PAYEMENT);
    totAll += total; balAll += bal; for (const k in bucket) catTotals[k] += bucket[k];
    built.push({ docNo: "HC-" + acDoc, acDoc, h, items, total, bal, paid, pay, bucket });
  }

  // ---- report ----
  log("");
  log(`Source orders ${orders.size} / lines ${rows.length}`);
  log(`  importing (pure non-sofa): ${built.length}${LIMIT ? ` (LIMIT ${LIMIT})` : ""}`);
  log(`  skipped mixed / all-sofa:  ${skipMixed} / ${skipAllSofa}`);
  log(`Total RM ${(totAll / 100).toLocaleString()}  balance RM ${(balAll / 100).toLocaleString()}  paid RM ${((totAll - balAll) / 100).toLocaleString()}`);
  log(`Category RM: ` + Object.entries(catTotals).map(([k, v]) => `${k}=${(v / 100).toLocaleString()}`).join("  "));
  log(`Blank zero-value lines dropped: ${droppedZero}`);
  log(`Unmatched lines (exceptions): ${exceptions.length}`);
  for (const e of exceptions.slice(0, 20)) log(`   ${e.ac}  code="${e.code}"  "${e.desc}"  RM${e.price}`);
  if (notInPickList.size) { log(`erp codes NOT in company-1 pick list: ${notInPickList.size}`); for (const c of [...notInPickList].slice(0, 20)) log(`   ${c}`); }

  if (!APPLY) { log("\nDRY-RUN only — no writes. Set APPLY=1 to import."); await sql.end(); return; }

  // ---- apply (BULK, chunked) — per-order round trips are far too slow over the
  //      GitHub->Supabase link, so build multi-row INSERTs (~3 statements per
  //      150-order chunk). Idempotent: skip doc_nos already present. ----
  log("\nAPPLYING (bulk)…");
  await sql`ALTER TABLE scm.mfg_sales_orders ADD COLUMN IF NOT EXISTS linked_ac_docno text`;
  await sql`CREATE INDEX IF NOT EXISTS mfg_so_linked_ac_docno_idx ON scm.mfg_sales_orders(linked_ac_docno)`;

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

  // idempotency: which doc_nos are already in?
  const allDocs = built.map((o) => o.docNo);
  const existing = new Set();
  for (let i = 0; i < allDocs.length; i += 1000) {
    const rows = await sql`SELECT doc_no FROM scm.mfg_sales_orders WHERE company_id = 1 AND doc_no = ANY(${allDocs.slice(i, i + 1000)})`;
    for (const r of rows) existing.add(r.doc_no);
  }
  const todo = built.filter((o) => !existing.has(o.docNo));
  log(`already imported: ${existing.size}; to insert: ${todo.length}`);

  const HCOLS = "(doc_no,linked_ac_docno,so_date,debtor_name,debtor_code,agent,sales_location,ref,venue,branding,address1,address2,address3,address4,phone,status,company_id,currency,local_total_centi,balance_centi,paid_centi,deposit_centi,line_count,mattress_sofa_centi,bedframe_centi,accessories_centi,service_centi,others_centi,payment_method,approval_code,payment_date)";
  const ICOLS = "(doc_no,line_no,item_group,item_code,description,description2,uom,location,qty,unit_price_centi,total_centi,balance_centi,company_id,gap_inches,divan_height_inches,leg_height_inches,variants,custom_specials,remark)";
  const PCOLS = "(so_doc_no,paid_at,method,approval_code,account_sheet,amount_centi,is_deposit,company_id,note)";

  let nOrders = 0, nItems = 0, nPay = 0;
  const CHUNK = 150;
  for (let i = 0; i < todo.length; i += CHUNK) {
    const batch = todo.slice(i, i + CHUNK);
    const hv = [], iv = [], pv = [];
    for (const o of batch) {
      const h = o.h;
      hv.push("(" + [V(o.docNo), V(o.acDoc), h.DocDate ? V(h.DocDate) : V(CUR), V(h.DebtorName || "CUSTOMER"), V(h.DebtorCode || null), V(h.SalesAgent || null), V(h.SalesLocation || null), V(h.Ref || null), V(h.UDF_VENUE || null), V(h.UDF_BRANDING || null), V(h.InvAddr1 || null), V(h.InvAddr2 || null), V(h.InvAddr3 || null), V(h.InvAddr4 || null), V(h.Phone1 || null), V("CONFIRMED"), "1", V("MYR"), V(o.total), V(o.bal), V(o.paid), V(o.paid), V(o.items.length), V(o.bucket.mattress), V(o.bucket.bedframe), V(o.bucket.accessory), V(o.bucket.service), V(o.bucket.others), V(o.paid > 0 ? "imported" : null), V(o.pay.appr || null), o.paid > 0 ? V(CUR) : "NULL"].join(",") + ")");
      let lineNo = 0;
      for (const it of o.items) {
        lineNo++;
        const variants = it.bf ? { color: it.bf.color || null, specials: it.bf.specials, raw: it.bf.raw || null } : null;
        const specials = it.bf && it.bf.specials.length ? it.bf.specials : null;
        iv.push("(" + [V(o.docNo), String(lineNo), V(it.grp), V(it.erp), V(it.desc || null), V(it.d2 || null), V(uomOf(it.grp)), V(it.loc || null), String(it.qty), V(it.up), V(it.lineTotal), V(it.lineTotal), "1", it.bf && isFinite(it.bf.gap) ? String(Math.round(it.bf.gap)) : "NULL", it.bf && isFinite(it.bf.divan) ? String(Math.round(it.bf.divan)) : "NULL", it.bf && isFinite(it.bf.leg) ? String(Math.round(it.bf.leg)) : "NULL", V({ __json: variants }), V({ __json: specials }), V(it.resolvedFree ? "name-matched from free-text" : null)].join(",") + ")");
        nItems++;
      }
      if (o.paid > 0) { pv.push("(" + [V(o.docNo), V(CUR), V("imported"), V(o.pay.appr || null), V(o.pay.acct || null), V(o.paid), "true", "1", V("imported from AutoCount " + o.acDoc + (o.pay.extra ? " [" + o.pay.extra + "]" : ""))].join(",") + ")"); nPay++; }
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
