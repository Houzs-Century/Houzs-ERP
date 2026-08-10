#!/usr/bin/env node
// Create the AutoCount paperwork the ERP is missing — goods receipts for POs
// AutoCount already received, and delivery orders for the part of an order
// AutoCount already delivered — WITHOUT moving any stock.
//
// Owner approved the design 2026-08-10: "建这一个模式，GR 和 DO 一起用."
//
// WHY NO MOVEMENTS. On-hand came into the ERP once, through the AutoCount
// balance snapshot. That snapshot already counts every past receipt as IN and
// every past delivery as OUT. A GRN posting an IN here would receive the same
// units twice; a DO posting an OUT would ship them twice. So these documents
// carry the quantities, the links and the dates, and nothing else — the stock
// effect is already in the ledger.
//
// Every row is stamped migrated_no_stock = true (migration 0276). That flag is
// the instruction to every future reconciliation and repair job: this document
// has no movements ON PURPOSE. "Fixing" it doubles the inventory.
//
// KIND=grn | do | both (default both). DRY-RUN by default; APPLY=1 writes.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const KIND = (process.env.KIND || "both").toLowerCase();
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const CO = 1;
const SYS_USER = "00000000-0000-4000-8000-000000000001";
const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8").replace(/^﻿/, ""));

function parseCsvLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) { const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; } }
  out.push(cur); return out;
}

async function nextSeq(table, col, prefix) {
  const [{ maxno }] = await sql.unsafe(
    `SELECT COALESCE(MAX(${col}), '') AS maxno FROM scm.${table} WHERE company_id = ${CO} AND ${col} LIKE '${prefix}%'`);
  return Number(String(maxno).replace(prefix, "")) || 0;
}

// ── goods receipts for the POs AutoCount already received ────────────────────
async function doGrns() {
  log("═══ GRN — receipts AutoCount already made ═══");
  const lines = await sql`SELECT i.id, i.purchase_order_id, i.material_code, i.material_name,
      i.received_qty, i.unit_price_centi, i.item_group, i.variants, i.warehouse_id,
      p.po_number, p.linked_ac_docno, p.supplier_id, p.purchase_location_id, p.linked_ac_grn_docnos
    FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
    WHERE p.company_id = ${CO} AND p.linked_ac_docno IS NOT NULL AND COALESCE(i.received_qty,0) > 0
    ORDER BY p.po_number, i.id`;
  const done = new Set((await sql`SELECT linked_ac_docno FROM scm.grns
      WHERE company_id = ${CO} AND migrated_no_stock = true AND linked_ac_docno IS NOT NULL`)
    .map((r) => r.linked_ac_docno));

  /* One ERP GRN per PURCHASE ORDER, not per AutoCount GR document: a single
     AutoCount receipt can span several POs, and the ERP's GRN belongs to one
     PO. The AutoCount GR numbers this stands for ride along on the header, so
     the trail back is exact even though the shape differs. */
  const byPo = new Map();
  for (const l of lines) {
    if (!byPo.has(l.purchase_order_id)) byPo.set(l.purchase_order_id, { po: l, items: [] });
    byPo.get(l.purchase_order_id).items.push(l);
  }
  const plan = [...byPo.values()].filter((g) => !done.has(g.po.linked_ac_docno));
  log(`POs with received quantity: ${byPo.size}; already mirrored: ${byPo.size - plan.length}; to create: ${plan.length}`);
  const grnUnits = plan.reduce((s2, g) => s2 + g.items.reduce((t, i) => t + Number(i.received_qty || 0), 0), 0);
  log(`lines: ${plan.reduce((s2, g) => s2 + g.items.length, 0)}; units: ${grnUnits}`);
  if (!plan.length) return;
  for (const g of plan.slice(0, 8)) log(`   ${g.po.po_number} <- ${g.po.linked_ac_docno}: ${g.items.length} line(s), ${g.items.reduce((t, i) => t + Number(i.received_qty || 0), 0)} unit(s)`);
  if (!APPLY) { log("DRY-RUN — set APPLY=1 to create. No inventory movement is written in either mode."); return; }

  let seq = await nextSeq("grns", "grn_number", "HC-GRN-");
  let made = 0;
  for (const g of plan) {
    seq += 1;
    const grnNo = `HC-GRN-${String(seq).padStart(6, "0")}`;
    await sql.begin(async (tx) => {
      const [hdr] = await tx`INSERT INTO scm.grns
          (grn_number, purchase_order_id, supplier_id, warehouse_id, status, posted_at, received_at,
           currency, company_id, created_by, notes, migrated_no_stock, linked_ac_docno)
        VALUES (${grnNo}, ${g.po.purchase_order_id}, ${g.po.supplier_id},
                ${g.items[0].warehouse_id ?? g.po.purchase_location_id}, 'POSTED', NOW(), CURRENT_DATE, 'MYR',
                ${CO}, ${SYS_USER},
                ${`mirrors the AutoCount receipt for ${g.po.linked_ac_docno}` +
                   (g.po.linked_ac_grn_docnos?.length ? ` (AutoCount GR ${g.po.linked_ac_grn_docnos.join(", ")})` : "") +
                   ". No stock movement: the units are already on hand from the balance snapshot."},
                true, ${g.po.linked_ac_docno})
        RETURNING id`;
      for (const it of g.items) {
        await tx`INSERT INTO scm.grn_items
            (grn_id, purchase_order_item_id, material_kind, material_code, material_name, item_group,
             qty_received, qty_accepted, qty_rejected, unit_price_centi, line_total_centi, variants, company_id)
          VALUES (${hdr.id}, ${it.id}, 'mfg_product', ${it.material_code}, ${it.material_name}, ${it.item_group},
                  ${it.received_qty}, ${it.received_qty}, 0, ${it.unit_price_centi},
                  ${Math.round(Number(it.received_qty) * Number(it.unit_price_centi || 0))},
                  ${it.variants ? sql.json(it.variants) : null}, ${CO})`;
      }
    });
    made += 1;
    if (made % 50 === 0) log(`  ..${made}/${plan.length}`);
  }
  log(`DONE. GRNs created: ${made}. No inventory movement written — by design.`);
}

// ── delivery orders for the part AutoCount already delivered ─────────────────
async function doDos() {
  log("");
  log("═══ DO — deliveries AutoCount already made against still-open orders ═══");
  const rows = gz("ac-partial-dos.json.gz");
  const csv = fs.readFileSync(path.join(here, "data", "autocount-erp-mapping-1561.csv"), "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  csv.shift();
  const byAc = new Map();
  for (const ln of csv) { const f = parseCsvLine(ln); if (f[0]) byAc.set(norm(f[0]), (f[1] || "").trim()); }

  const done = new Set((await sql`SELECT linked_ac_docno FROM scm.delivery_orders
      WHERE company_id = ${CO} AND migrated_no_stock = true AND linked_ac_docno IS NOT NULL`)
    .map((r) => r.linked_ac_docno));

  const soItems = await sql`SELECT i.id, i.item_code, i.line_no, i.qty, h.doc_no, h.linked_ac_docno ac, h.id AS so_id
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL ORDER BY i.line_no`;
  const soByKey = new Map();
  for (const it of soItems) {
    const k = `${it.ac}|${norm(it.item_code)}`;
    if (!soByKey.has(k)) soByKey.set(k, []);
    soByKey.get(k).push(it);
  }

  const byDo = new Map();
  let noSoLine = 0, unmapped = 0;
  for (const r of rows) {
    const erp = byAc.get(norm(r.ItemCode));
    if (!erp) { unmapped++; continue; }
    const cands = soByKey.get(`${r.SoNo}|${norm(erp)}`);
    const pick = cands && cands.length ? cands[0] : null;
    if (!pick) { noSoLine++; continue; }
    if (!byDo.has(r.DoNo)) byDo.set(r.DoNo, { doNo: r.DoNo, date: r.DoDate, so: pick.doc_no, soId: pick.so_id, items: [] });
    byDo.get(r.DoNo).items.push({ code: erp, name: r.LineDesc, qty: Math.round(Number(r.Qty || 0)), soItemId: pick.id });
  }
  const plan = [...byDo.values()].filter((d) => !done.has(d.doNo));
  log(`AutoCount delivery lines against open orders: ${rows.length}; unmapped code ${unmapped}; no ERP SO line ${noSoLine}`);
  log(`DO documents: ${byDo.size}; already mirrored: ${byDo.size - plan.length}; to create: ${plan.length} (${plan.reduce((s, d) => s + d.items.length, 0)} lines, ${plan.reduce((s, d) => s + d.items.reduce((t, i) => t + i.qty, 0), 0)} units)`);
  for (const d of plan.slice(0, 8)) log(`   ${d.doNo} <- ${d.so}: ${d.items.length} line(s)`);
  if (!APPLY) { log("DRY-RUN — set APPLY=1 to create. No inventory movement is written in either mode."); return; }

  let seq = await nextSeq("delivery_orders", "do_number", "HC-DO-");
  let made = 0;
  for (const d of plan) {
    seq += 1;
    const doNo = `HC-DO-${String(seq).padStart(6, "0")}`;
    await sql.begin(async (tx) => {
      const [hdr] = await tx`INSERT INTO scm.delivery_orders
          (do_number, so_doc_no, status, do_date, currency, company_id, created_by,
           notes, migrated_no_stock, linked_ac_docno)
        VALUES (${doNo}, ${d.so}, 'DELIVERED', ${(d.date || "").slice(0, 10) || null}, 'MYR',
                ${CO}, ${SYS_USER},
                ${`mirrors AutoCount delivery ${d.doNo}. No stock movement: the balance snapshot already counts these units as delivered.`},
                true, ${d.doNo})
        RETURNING id`;
      for (const it of d.items) {
        await tx`INSERT INTO scm.delivery_order_items
            (delivery_order_id, so_item_id, item_code, description, uom, qty, company_id)
          VALUES (${hdr.id}, ${it.soItemId}, ${it.code}, ${it.name || null}, 'UNIT', ${it.qty}, ${CO})`;
      }
    });
    made += 1;
  }
  log(`DONE. DOs created: ${made}. No inventory movement written — by design.`);
}

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"} kind=${KIND}`);
  if (KIND === "grn" || KIND === "both") await doGrns();
  if (KIND === "do" || KIND === "both") await doDos();
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
