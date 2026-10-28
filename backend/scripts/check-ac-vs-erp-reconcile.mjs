#!/usr/bin/env node
// Reconcile the ERP against AutoCount on the three things the owner wants
// verified together before the floor switches over (2026-08-10):
//
//   1. PO -> SO dedication: which sales orders have a PO raised for them, and
//      of those, which POs are already received.
//   2. Stock STATUS: which lines are READY / PARTIAL / PENDING, and for the
//      not-ready ones, whether their dedicated PO says they should be ready.
//   3. Stock BALANCE: ERP on-hand vs the AutoCount snapshot, per item, so any
//      drift shows up as a number rather than a feeling.
//
// The AutoCount side comes from the checked-in snapshot files, so this runs
// read-only against the ERP with no second database connection.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { soProcessingDateFragment } from "./lib/so-processing-date.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
/* The ONE name of the Processing Date column, spliced as SQL text rather than
   bound as a parameter — see lib/so-processing-date.mjs for why. */
const PDATE = soProcessingDateFragment(sql);
const CO = 1;
const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");
const isSofa = (c) => /SOFA/i.test(c || "");
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8").replace(/^﻿/, ""));

function parseCsvLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) { const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; } }
  out.push(cur); return out;
}

async function main() {
  const csv = fs.readFileSync(path.join(here, "data", "autocount-erp-mapping-1561.csv"), "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  csv.shift();
  const byAc = new Map();
  for (const ln of csv) { const f = parseCsvLine(ln); if (f[0]) byAc.set(norm(f[0]), (f[1] || "").trim()); }

  log("═══ 1. PO ↔ SO dedication ═══");
  /* "Processed" throughout this file = carries a Processing Date, which lives in
     internal_expected_dd (what the UI writes, what soProcessingLocked and MRP
     read). proceeded_at is only the IN_PRODUCTION stamp and named a narrower
     set, so these reconciliation totals disagreed with the screens they were
     being compared against. */
  const [ded] = await sql`SELECT
      COUNT(*) FILTER (WHERE i.item_group IN ('bedframe','sofa'))::int bf_lines,
      COUNT(*) FILTER (WHERE i.item_group IN ('bedframe','sofa') AND poi.id IS NOT NULL)::int with_po,
      COUNT(*) FILTER (WHERE i.item_group IN ('bedframe','sofa') AND COALESCE(poi.received_qty,0) > 0)::int po_received
    FROM scm.mfg_sales_order_items i
    JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    LEFT JOIN scm.purchase_order_items poi ON poi.so_item_id = i.id
    WHERE h.company_id = ${CO} AND h.${PDATE} IS NOT NULL AND COALESCE(i.cancelled,false) = false
      AND h.status NOT IN ('CANCELLED','CLOSED','DELIVERED','SHIPPED','INVOICED')`;
  log(`processed bedframe/sofa lines: ${ded.bf_lines}; with a dedicated PO: ${ded.with_po}; whose PO is received: ${ded.po_received}`);
  const [poc] = await sql`SELECT COUNT(*)::int pos,
      COUNT(*) FILTER (WHERE status IN ('RECEIVED','PARTIALLY_RECEIVED'))::int received
    FROM scm.purchase_orders WHERE company_id = ${CO} AND linked_ac_docno IS NOT NULL`;
  log(`imported POs: ${poc.pos} (received/partially: ${poc.received})`);

  log("");
  log("═══ 2. stock status ═══");
  const st = await sql`SELECT i.item_group, i.stock_status, COUNT(*)::int n
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = ${CO} AND h.${PDATE} IS NOT NULL AND COALESCE(i.cancelled,false) = false
      AND h.status NOT IN ('CANCELLED','CLOSED','DELIVERED','SHIPPED','INVOICED')
    GROUP BY 1, 2 ORDER BY 1, 3 DESC`;
  for (const r of st) log(`   ${r.item_group ?? "(none)"} ${r.stock_status ?? "(null)"}: ${r.n}`);
  const [hdrs] = await sql`SELECT COUNT(*) FILTER (WHERE status = 'READY_TO_SHIP')::int ready,
      COUNT(*) FILTER (WHERE status = 'CONFIRMED')::int confirmed
    FROM scm.mfg_sales_orders WHERE company_id = ${CO} AND ${PDATE} IS NOT NULL
      AND status NOT IN ('CANCELLED','CLOSED','DELIVERED','SHIPPED','INVOICED')`;
  log(`processed order headers: READY_TO_SHIP ${hdrs.ready}; CONFIRMED ${hdrs.confirmed}`);

  /* Lines that SHOULD be ready by the bound rule but are not — after the
     allocation has run, this list must be empty. Anything left is a real
     defect, not a timing artefact.
     DELIVERED lines are excluded (2026-08-29): a line whose DOs already cover
     its qty has deliverable remaining 0, the allocator rightly leaves it
     alone, and its stock_status legitimately never flips to READY. The first
     version of this lens counted 35 such sofa piece lines as defects —
     traced on SO-003295/SO-009585, both delivered in the book, mirrors and
     all (round ledger 4h). A lens that cannot see deliveries indicts the
     allocator for obeying them. */
  const shouldBe = await sql`SELECT h.doc_no, i.item_code, i.item_group, i.stock_status, poi.received_qty, i.qty,
      COALESCE(del.dq, 0) AS delivered
    FROM scm.mfg_sales_order_items i
    JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    JOIN scm.purchase_order_items poi ON poi.so_item_id = i.id
    LEFT JOIN (
      SELECT d.so_item_id, SUM(d.qty) AS dq
      FROM scm.delivery_order_items d
      JOIN scm.delivery_orders dh ON dh.id = d.delivery_order_id
      WHERE COALESCE(dh.status::text, '') NOT ILIKE '%cancel%'
      GROUP BY d.so_item_id
    ) del ON del.so_item_id = i.id
    WHERE h.company_id = ${CO} AND h.${PDATE} IS NOT NULL AND COALESCE(i.cancelled,false) = false
      AND h.status NOT IN ('CANCELLED','CLOSED','DELIVERED','SHIPPED','INVOICED')
      AND COALESCE(poi.received_qty,0) >= i.qty AND i.stock_status <> 'READY'
      AND i.qty - COALESCE(del.dq, 0) > 0
    ORDER BY h.doc_no LIMIT 200`;
  /* Bound mode is bedframe + sofa ONLY (owner 2026-08-10: "SOFA 和 BEDFRAME…要走
     Convert to PO 的那个模式。可是 MATTRESS 跟 Accessories…走回我们正常 MRP 的
     模式"). A pooled line with a received dedication is NOT a defect: its units
     went into the shared pool and may legitimately have been taken by an older
     order. Only the bound groups have to be READY. */
  const boundLate = shouldBe.filter((r) => ['bedframe', 'sofa'].includes(r.item_group));
  const pooledLate = shouldBe.filter((r) => !['bedframe', 'sofa'].includes(r.item_group));
  log(`fully-received BOUND dedications still not READY (must be 0 after a recompute): ${boundLate.length}`);
  for (const r of boundLate.slice(0, 20)) log(`   ${r.doc_no} ${r.item_code} [${r.item_group}] ${r.stock_status} recv ${r.received_qty}/${r.qty}`);
  if (boundLate.length > 20) log(`   ... and ${boundLate.length - 20} more`);
  log(`pooled lines with a received dedication and not READY (informational, pooled stock may be spoken for): ${pooledLate.length}`);

  /* Sofa ships only from ONE batch, and both the allocator and the DO gate read
     batch_no off the lot. Migrated stock that arrived through the balance
     snapshot has no batch_no, which would leave every sofa set unallocatable no
     matter how much of it is on hand — so measure the coverage rather than
     assume it. */
  const [sofaLots] = await sql`SELECT
      COUNT(*)::int lots,
      COUNT(*) FILTER (WHERE l.batch_no IS NOT NULL)::int with_batch,
      COALESCE(SUM(l.qty_remaining), 0)::int qty,
      COALESCE(SUM(l.qty_remaining) FILTER (WHERE l.batch_no IS NOT NULL), 0)::int qty_with_batch
    FROM scm.v_inventory_lots_open l
    JOIN scm.mfg_products p ON p.code = l.item_code AND p.company_id = ${CO}
    WHERE p.category::text = 'SOFA' AND l.qty_remaining > 0`;
  log(`sofa open lots: ${sofaLots.lots} (${sofaLots.with_batch} carry a batch_no); units ${sofaLots.qty} (${sofaLots.qty_with_batch} batched)`);
  if (sofaLots.lots > 0 && sofaLots.with_batch === 0) {
    log("   -> no sofa lot carries a batch_no, so findCoveringBatch can never match and every sofa set stays PENDING regardless of stock. Batch attribution is the blocker, not quantity.");
  }

  log("");
  log("═══ 3. stock balance vs AutoCount ═══");
  const bal = gz("ac-stock-balance.json.gz");
  const acByErp = new Map();
  for (const b of bal) {
    if (isSofa(b.ItemCode) || !b.BalQty) continue;
    const erp = byAc.get(norm(b.ItemCode));
    if (!erp) continue;
    acByErp.set(norm(erp), (acByErp.get(norm(erp)) ?? 0) + Number(b.BalQty));
  }
  const erpBal = await sql`SELECT item_code, SUM(qty)::int qty FROM scm.inventory_balances
    WHERE company_id = ${CO} GROUP BY item_code`;
  const erpByCode = new Map(erpBal.map((r) => [norm(r.item_code), Number(r.qty)]));
  let same = 0; const diffs = [];
  for (const [code, acQty] of acByErp) {
    const erpQty = erpByCode.get(code) ?? 0;
    if (Math.round(acQty) === erpQty) same++;
    else diffs.push({ code, ac: Math.round(acQty), erp: erpQty, d: erpQty - Math.round(acQty) });
  }
  const extra = [...erpByCode.entries()].filter(([c, q]) => q !== 0 && !acByErp.has(c));
  diffs.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  log(`items compared: ${acByErp.size}; MATCHING exactly: ${same}; differing: ${diffs.length}; in ERP but not in the AC snapshot: ${extra.length}`);
  for (const d of diffs.slice(0, 20)) log(`   ${d.code}: AutoCount ${d.ac} vs ERP ${d.erp} (${d.d > 0 ? "+" : ""}${d.d})`);
  for (const [c, q] of extra.slice(0, 10)) log(`   ERP-only: ${c} = ${q}`);

  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
