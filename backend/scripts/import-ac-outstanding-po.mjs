#!/usr/bin/env node
// One-time GO-LIVE import: AutoCount OUTSTANDING Purchase Orders -> ERP
// scm.purchase_orders/_items for company 1 (Houzs Century). Companion to
// import-ac-outstanding-so.mjs. Source = the ERP's OWN AutoCount PO mirror
// public.purchase_orders (already synced: doc_no, so_doc_no, creditor, item_code,
// location, remaining_qty, original_qty, unit_price, delivery/supplier dates) —
// NO fresh AutoCount export needed.
//
// Owner rules (2026-08-09):
//  - Company 1 only. SOFA EXCLUDED (item_code ILIKE '%SOFA%').
//  - po_number = "HC-" + AutoCount PO no (HC-PO-009208); raw no in linked_ac_docno.
//  - supplier <- creditor_code (all match scm.suppliers.code). material_code <-
//    item_code via the binding CSV (material_kind=mfg_product, supplier_sku=the
//    AutoCount code, material_name=mfg_products.name). delivery_date + supplier_
//    delivery_date_2..4 <- mirror dates. warehouse <- location map.
//  - BEDFRAME variant backfill: from the already-imported SO line (join the PO's
//    so_doc_no to the imported SO's linked_ac_docno + material_code) -> gap/divan/
//    leg/custom_specials/variants/description2.
//  - qty = original ordered; received_qty = original - remaining (outstanding kept).
//
// Idempotent: skip po_numbers already present. DRY-RUN default; APPLY=1 to write.
import fs from "node:fs";
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
const isSofa = (c) => /SOFA/i.test(c || "");
const C1_ALIAS = { "SVC-DELIVERY": "TRANSPORTATION CHARGES", "SVC-DELIVERY-ADD": "TRANSPORTATION CHARGES", "SVC-DELIVERY-CROSS": "TRANSPORTATION CHARGES" };
// location -> warehouse code
const WH_MAP = { "KL": "KL WAREHOUSE", "PG": "PG WAREHOUSE", "SRW": "SRW WAREHOUSE", "SBH": "SBH WAREHOUSE", "KL DISP": "KL DISPLAY", "PG DISP": "PG DISPLAY", "SBH DISP": "SBH DISPLAY", "EM DISP": "EM DISPLAY", "SRW DISP": "EM DISPLAY", "HQ": "HQ", "KL SERVICE": "KL SERVICE", "PG SERVICE": "PG SERVICE" };

function parseCsvLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) { const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; } }
  out.push(cur); return out;
}
const esc = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const V = (v) => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "object" && v.__raw) return v.__raw;
  if (typeof v === "object" && "__json" in v) return v.__json == null ? "NULL" : esc(JSON.stringify(v.__json)) + "::jsonb";
  if (typeof v === "number") return isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  return esc(v);
};
const centi = (v) => Math.round((parseFloat(String(v ?? "").replace(/[^0-9.\-]/g, "")) || 0) * 100);

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}${LIMIT ? ` LIMIT=${LIMIT}` : ""}`);

  // binding ac->erp
  const csv = fs.readFileSync(path.join(here, "data", "autocount-erp-mapping-1561.csv"), "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  csv.shift();
  const byAc = new Map();
  for (const ln of csv) { const f = parseCsvLine(ln); if (f[0]) byAc.set(norm(f[0]), { erp: (f[1] || "").trim(), cat: (f[3] || "").trim().toUpperCase() }); }

  // masters
  const sup = await sql`SELECT id, code FROM scm.suppliers WHERE company_id = 1`;
  const supByCode = new Map(sup.map((s) => [s.code, s.id]));
  const wh = await sql`SELECT id, code FROM scm.warehouses WHERE company_id = 1`;
  const whByCode = new Map(wh.map((w) => [w.code.toUpperCase(), w.id]));
  const prod = await sql`SELECT code, name FROM scm.mfg_products WHERE company_id = 1`;
  const prodName = new Map(prod.map((p) => [p.code.toUpperCase(), p.name]));
  const codeSet = new Set(prod.map((p) => p.code.toUpperCase()));
  // bedframe variant backfill from imported SO lines: key = ac_so_no|material_code
  const soItems = await sql`SELECT h.linked_ac_docno ac, i.item_code, i.gap_inches, i.divan_height_inches, i.leg_height_inches, i.custom_specials, i.variants, i.description2
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = 1 AND i.item_group = 'bedframe' AND h.linked_ac_docno IS NOT NULL`;
  const soVar = new Map();
  for (const r of soItems) soVar.set(r.ac + "|" + (r.item_code || "").toUpperCase(), r);
  log(`suppliers=${sup.length} warehouses=${wh.length} products=${prod.length} soBedframeLines=${soItems.length}`);

  const whId = (loc) => { const k = (loc || "").trim().toUpperCase(); return whByCode.get((WH_MAP[k] || k).toUpperCase()) || null; };
  const resolveMat = (itemCode) => {
    const hit = byAc.get(norm(itemCode));
    let erp = hit ? hit.erp : null;
    if (erp && !codeSet.has(erp.toUpperCase()) && C1_ALIAS[erp.toUpperCase()]) erp = C1_ALIAS[erp.toUpperCase()];
    return { erp, cat: hit ? hit.cat : null };
  };

  // mirror outstanding PO lines (non-sofa, not cancelled)
  const rows = await sql`SELECT doc_no, so_doc_no, creditor_code, creditor_name, item_code, item_description, location, doc_date, remaining_qty, original_qty, unit_price, delivery_date, supplier_date1, supplier_date2, supplier_date3
    FROM public.purchase_orders WHERE company_id = 1 AND remaining_qty > 0 AND coalesce(cancelled,0) = 0 ORDER BY doc_no`;
  const groups = new Map();
  for (const r of rows) { if (isSofa(r.item_code)) continue; if (!groups.has(r.doc_no)) groups.set(r.doc_no, []); groups.get(r.doc_no).push(r); }
  let pos = [...groups.entries()];
  if (LIMIT) pos = pos.slice(0, LIMIT);

  const built = []; const exceptions = []; let noWh = 0, bfBackfilled = 0, bfNoLink = 0;
  for (const [acPo, ls] of pos) {
    const h = ls[0];
    const supId = supByCode.get(h.creditor_code) || null;
    if (!supId) { exceptions.push({ po: acPo, reason: "supplier " + h.creditor_code + " not found" }); continue; }
    const items = []; let subtotal = 0; let anyReceived = false;
    for (const l of ls) {
      const { erp, cat } = resolveMat(l.item_code);
      if (!erp) { exceptions.push({ po: acPo, code: l.item_code, reason: "no material mapping" }); continue; }
      const grp = ({ MATTRESS: "mattress", BEDFRAME: "bedframe", ACC: "accessory", ACCESSORY: "accessory", BEDLINES: "accessory", SERVICE: "service", TRANS: "service" })[cat] || "others";
      const qty = Math.round(Number(l.original_qty || l.remaining_qty) || 1);
      const rem = Math.round(Number(l.remaining_qty) || 0);
      const received = Math.max(0, qty - rem); if (received > 0) anyReceived = true;
      const up = centi(l.unit_price); const lt = up * qty; subtotal += lt;
      const w = whId(l.location); if (!w) noWh++;
      let bf = null;
      if (grp === "bedframe" && l.so_doc_no) { const v = soVar.get((l.so_doc_no || "").trim() + "|" + erp.toUpperCase()); if (v) { bf = v; bfBackfilled++; } else bfNoLink++; }
      else if (grp === "bedframe") bfNoLink++;
      items.push({ erp, grp, name: prodName.get(erp.toUpperCase()) || l.item_description || erp, supplierSku: l.item_code, desc: l.item_description, qty, received, up, lt, w, deliv: l.delivery_date, s2: l.supplier_date1, s3: l.supplier_date2, s4: l.supplier_date3, bf });
    }
    if (!items.length) continue;
    built.push({ poNo: "HC-" + acPo, acPo, supId, poDate: h.doc_date, locWh: whId(h.location), subtotal, status: anyReceived ? "PARTIALLY_RECEIVED" : "SUBMITTED", items });
  }

  log("");
  log(`Outstanding non-sofa POs: ${built.length} (of ${groups.size} total non-sofa groups)`);
  log(`PO lines: ${built.reduce((a, o) => a + o.items.length, 0)}  subtotal RM ${(built.reduce((a, o) => a + o.subtotal, 0) / 100).toLocaleString()}`);
  log(`bedframe variant backfilled from SO: ${bfBackfilled}; bedframe w/o SO link: ${bfNoLink}; lines w/o warehouse match: ${noWh}`);
  log(`exceptions: ${exceptions.length}`);
  for (const e of exceptions.slice(0, 15)) log(`   PO ${e.po} ${e.code ? 'code="' + e.code + '" ' : ''}${e.reason}`);

  if (built.length) {
    const s = built.find((o) => o.items.some((i) => i.grp === "bedframe" && i.bf)) || built[0];
    log(`\nSAMPLE ${s.poNo} <- ${s.acPo}  supplier=${[...supByCode].find(([c, id]) => id === s.supId)?.[0]}  status=${s.status}`);
    for (const i of s.items) log(`   [${i.grp}] ${i.erp} (sku ${i.supplierSku}) x${i.qty} recv${i.received} RM${(i.lt / 100).toFixed(2)} wh=${i.w ? "ok" : "-"} deliv=${i.deliv ? String(i.deliv).slice(0, 10) : "-"}${i.bf ? ` var(gap=${i.bf.gap_inches} div=${i.bf.divan_height_inches} leg=${i.bf.leg_height_inches})` : ""}`);
  }

  if (!APPLY) { log("\nDRY-RUN only. APPLY=1 to write."); await sql.end(); return; }

  log("\nAPPLYING (bulk)…");
  await sql`ALTER TABLE scm.purchase_orders ADD COLUMN IF NOT EXISTS linked_ac_docno text`;
  await sql`CREATE INDEX IF NOT EXISTS po_linked_ac_docno_idx ON scm.purchase_orders(linked_ac_docno)`;
  const allNo = built.map((o) => o.poNo);
  const existing = new Set();
  for (let i = 0; i < allNo.length; i += 1000) { const r = await sql`SELECT po_number FROM scm.purchase_orders WHERE company_id = 1 AND po_number = ANY(${allNo.slice(i, i + 1000)})`; for (const x of r) existing.add(x.po_number); }
  const todo = built.filter((o) => !existing.has(o.poNo));
  log(`already imported: ${existing.size}; to insert: ${todo.length}`);

  let nPo = 0, nItems = 0;
  for (const o of todo) {
    await sql.begin(async (tx) => {
      const ins = await tx`INSERT INTO scm.purchase_orders
        (po_number, linked_ac_docno, supplier_id, status, po_date, purchase_location_id, currency, subtotal_centi, tax_centi, total_centi, revision, company_id, created_by, notes)
        VALUES (${o.poNo}, ${o.acPo}, ${o.supId}, ${o.status}, ${o.poDate || sql`CURRENT_DATE`}, ${o.locWh}, 'MYR', ${o.subtotal}, 0, ${o.subtotal}, 1, 1, ${SYS_USER}, ${"imported from AutoCount " + o.acPo})
        ON CONFLICT (po_number) DO NOTHING RETURNING id`;
      if (!ins.length) return;
      const poId = ins[0].id;
      const iv = [];
      const d10 = (x) => (x ? V(String(x).slice(0, 10)) : "NULL");
      const gi = (x) => (x != null && Number.isFinite(Number(x)) ? String(Math.round(Number(x))) : "NULL");
      for (const i of o.items) {
        const cs = i.bf && i.bf.custom_specials ? i.bf.custom_specials : null;
        const va = i.bf && i.bf.variants ? i.bf.variants : null;
        iv.push("(" + [
          V(poId), V("mfg_product"), V(i.erp), V(i.name), V(i.supplierSku),
          String(i.qty), V(i.up), V(i.lt), String(i.received), V(i.grp),
          V(i.desc || null), V(i.bf ? i.bf.description2 : null), V("UNIT"), "0", "0",
          "0", "0", "0",
          gi(i.bf && i.bf.gap_inches), gi(i.bf && i.bf.divan_height_inches), gi(i.bf && i.bf.leg_height_inches),
          V({ __json: cs }), V({ __json: va }), i.w ? V(i.w) : "NULL",
          d10(i.deliv), d10(i.s2), d10(i.s3), d10(i.s4), "false", "1",
        ].join(",") + ")");
        nItems++;
      }
      await tx.unsafe(`INSERT INTO scm.purchase_order_items
        (purchase_order_id, material_kind, material_code, material_name, supplier_sku,
         qty, unit_price_centi, line_total_centi, received_qty, item_group,
         description, description2, uom, discount_centi, unit_cost_centi,
         divan_price_sen, leg_price_sen, special_order_price_sen,
         gap_inches, divan_height_inches, leg_height_inches,
         custom_specials, variants, warehouse_id,
         delivery_date, supplier_delivery_date_2, supplier_delivery_date_3, supplier_delivery_date_4, from_mrp, company_id)
        VALUES ${iv.join(",")}`);
      nPo++;
    });
  }
  log(`DONE. inserted POs=${nPo} items=${nItems}; skipped-existing=${existing.size}; exceptions=${exceptions.length}`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
