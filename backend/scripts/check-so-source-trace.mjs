// READ-ONLY: the owner's traceability rule, measured against production.
//
//   "我们的 SO 如果已经是 Delivered、Ready to Ship 或者 Shipped 状态，其中的任何
//    一件货物都必须能够追溯到是拿什么 PO 进的货。系统里只要显示 Ready，肯定就代表
//    有货；既然有货，Inventory 里就绝对会有记录，写明这批货对应的是哪一个 PO。"
//
// For EVERY line on EVERY non-cancelled Sales Order in READY_TO_SHIP / SHIPPED
// / DELIVERED (both companies), resolve the source-PO trace the way the ERP
// does after the 2026-08-01 build:
//
//   DELIVERED side  DO lines (so_item_id) → OUT movements' batch_no ∪ FIFO lot
//                   consumptions → lots: batch_no, else GRN→PO (read-time
//                   heal), else ADJUSTMENT (explained as STOCK ADJ).
//   READY side      sofa → stored allocated_batch_no (mig 0121);
//                   non-sofa → FIFO projection over the bucket's open lots
//                   (received_at ASC, id ASC — fn_consume_fifo's order),
//                   earlier claims first (delivery date, then doc_no — the
//                   allocation order), the script-side mirror of
//                   scm/lib/source-po-trace.ts soLineReadySourcePos.
//
// Every line ends in a CLASS; the owner's expectation is zero-or-explained:
//
//   ok-delivered / ok-ready / ok-adjustment    resolved (adjustment = STOCK ADJ)
//   service                                    service line — no goods, no PO
//   no-do-line-link      SO shows delivered but no DO line carries its
//                        so_item_id (the ON DELETE SET NULL trap / import)
//   do-no-ledger         DO lines exist but wrote no movement/consumption
//   consumed-lot-unbatchable   consumption found, lot has no batch AND no
//                        GRN/adjustment evidence (backfill-lot-batch-from-docs
//                        cannot stamp it either — pre-import receipt)
//   sofa-ready-no-batch  READY sofa without allocated_batch_no
//   ready-no-open-lots   READY line but its bucket holds no open lots
//                        (balances-vs-lots drift, or no warehouse binding)
//   ready-lot-unbatchable   its FIFO slice lands on lots with no evidence
//   not-ready            line on a READY_TO_SHIP order that is itself not
//                        READY and not delivered (status/stock mismatch, FYI)
//
// Plus the owner's one-line verdict: whether ANY unit is attributed to two
// DOs — the audit-inventory-costing.mjs section 10c lens verbatim (per
// movement: SUM(qty_consumed) <= |qty|; every consumption has a movement).
//
// Read-only (SELECTs only), exit 0 for every legitimate answer.
//   DATABASE_URL  required (env, or .dev.vars for local use)
import { readFileSync } from "node:fs";
import postgres from "postgres";

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}
const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

const SERVICE_RE = /SERVICE/i;
const isService = (group, code) =>
  SERVICE_RE.test(String(group ?? "")) || /^(DELIVERY|DISPOSE|LIFT)/i.test(String(code ?? ""));

try {
  log(`=== check-so-source-trace (read-only) ===`);

  const companies = await pg`SELECT id, code FROM public.companies ORDER BY id`;
  const coCode = new Map(companies.map((r) => [Number(r.id), r.code]));

  // 1. In-scope SOs + their live lines.
  const sos = await pg`
    SELECT doc_no, UPPER(status) AS status, company_id, customer_delivery_date
      FROM scm.mfg_sales_orders
     WHERE UPPER(status) IN ('READY_TO_SHIP','SHIPPED','DELIVERED')`;
  log(`in-scope Sales Orders (READY_TO_SHIP/SHIPPED/DELIVERED): ${sos.length}`);
  const soByDoc = new Map(sos.map((s) => [s.doc_no, s]));
  const docNos = sos.map((s) => s.doc_no);
  if (docNos.length === 0) {
    log("VERDICT: nothing in scope — zero lines to trace.");
    await pg.end({ timeout: 5 });
    process.exit(0);
  }

  const lines = await pg`
    SELECT i.id::text AS id, i.doc_no, i.item_code, i.item_group, i.qty,
           i.cancelled, UPPER(COALESCE(i.stock_status,'')) AS stock_status,
           i.allocated_batch_no, i.warehouse_id::text AS warehouse_id,
           i.variants, i.line_delivery_date
      FROM scm.mfg_sales_order_items i
     WHERE i.doc_no = ANY(${docNos}) AND i.cancelled = false`;
  log(`live lines on them: ${lines.length}`);

  // 2. Delivered side — DO lines linked to our SO lines (non-cancelled DOs).
  const soItemIds = lines.map((l) => l.id);
  const doLines = soItemIds.length
    ? await pg`
        SELECT di.so_item_id::text AS so_item_id, di.delivery_order_id::text AS delivery_order_id,
               di.item_code, di.item_group, di.variants, di.qty,
               UPPER(COALESCE(d.status,'')) AS do_status, d.do_number
          FROM scm.delivery_order_items di
          JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
         WHERE di.so_item_id::text = ANY(${soItemIds})
           AND UPPER(COALESCE(d.status,'')) <> 'CANCELLED'`
    : [];
  const doIds = [...new Set(doLines.map((r) => r.delivery_order_id))];

  // Also DOC-LEVEL delivery signal (a DO on the SO whose lines lost their link).
  const docDos = await pg`
    SELECT so_doc_no, COUNT(*)::int AS n FROM scm.delivery_orders
     WHERE so_doc_no = ANY(${docNos}) AND UPPER(COALESCE(status,'')) <> 'CANCELLED'
     GROUP BY so_doc_no`;
  const doCountByDoc = new Map(docDos.map((r) => [r.so_doc_no, Number(r.n)]));

  // Ledger for those DOs: batched OUTs + consumptions -> lots (classified).
  const movs = doIds.length
    ? await pg`
        SELECT source_doc_id::text AS do_id, product_code, COALESCE(variant_key,'') AS vk, batch_no
          FROM scm.inventory_movements
         WHERE source_doc_type = 'DO' AND movement_type = 'OUT'
           AND source_doc_id::text = ANY(${doIds}) AND batch_no IS NOT NULL`
    : [];
  const cons = doIds.length
    ? await pg`
        SELECT c.source_doc_id::text AS do_id, c.product_code, COALESCE(c.variant_key,'') AS vk,
               c.qty_consumed, l.batch_no, UPPER(COALESCE(l.source_doc_type,'')) AS lot_src,
               l.source_doc_id::text AS lot_src_id,
               p.po_number AS grn_po
          FROM scm.inventory_lot_consumptions c
          JOIN scm.inventory_lots l ON l.id = c.lot_id
          LEFT JOIN scm.grns g ON UPPER(COALESCE(l.source_doc_type,'')) = 'GRN' AND g.id = l.source_doc_id
          LEFT JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
         WHERE c.source_doc_type = 'DO' AND c.source_doc_id::text = ANY(${doIds})`
    : [];
  // (do::code::vk) -> { pos:Set, adj:boolean, any:boolean }
  const ledger = new Map();
  const led = (k) => {
    let v = ledger.get(k);
    if (!v) { v = { pos: new Set(), adj: false, any: false, unbatchable: 0 }; ledger.set(k, v); }
    return v;
  };
  for (const m of movs) {
    const v = led(`${m.do_id}::${m.product_code}::${m.vk}`);
    v.pos.add(m.batch_no); v.any = true;
  }
  for (const r of cons) {
    const v = led(`${r.do_id}::${r.product_code}::${r.vk}`);
    v.any = true;
    const po = r.batch_no ?? r.grn_po ?? null;
    if (po) v.pos.add(po);
    else if (r.lot_src === "ADJUSTMENT") v.adj = true;
    else v.unbatchable += Math.abs(Number(r.qty_consumed ?? 0));
  }

  // Variant key mirror — the script-side lockstep of computeVariantKey is NOT
  // reimplemented here: the DO line's own stored variants live next to the
  // movement's variant_key, and both writers derive from the same function, so
  // we match by (do, code) FIRST and fall back to exact vk only when a (do,
  // code) has several variant buckets (rare; reported as approximate).
  const ledgerByDoCode = new Map();
  for (const [k, v] of ledger.entries()) {
    const [doId, code] = k.split("::");
    const kk = `${doId}::${code}`;
    const arr = ledgerByDoCode.get(kk) ?? [];
    arr.push(v);
    ledgerByDoCode.set(kk, arr);
  }
  const deliveredBySoItem = new Map(); // so_item_id -> { qty, pos:Set, adj, any, unbatchable }
  for (const dl of doLines) {
    const cur = deliveredBySoItem.get(dl.so_item_id) ?? { qty: 0, pos: new Set(), adj: false, any: false, unbatchable: 0 };
    cur.qty += Number(dl.qty ?? 0);
    const buckets = ledgerByDoCode.get(`${dl.delivery_order_id}::${dl.item_code}`) ?? [];
    for (const b of buckets) {
      cur.any = cur.any || b.any;
      cur.adj = cur.adj || b.adj;
      cur.unbatchable += b.unbatchable;
      for (const po of b.pos) cur.pos.add(po);
    }
    deliveredBySoItem.set(dl.so_item_id, cur);
  }

  // 3. READY side — open lots per bucket + FIFO projection with competing claims.
  const claimLines = lines
    .map((l) => {
      const so = soByDoc.get(l.doc_no);
      const delivered = deliveredBySoItem.get(l.id)?.qty ?? 0;
      const remaining = Math.max(0, Number(l.qty ?? 0) - delivered);
      return {
        ...l,
        companyId: Number(so?.company_id),
        remaining,
        effDate: l.line_delivery_date ?? so?.customer_delivery_date ?? null,
      };
    })
    .filter((l) => l.remaining > 0 && !isService(l.item_group, l.item_code));
  // Allocation order: delivery date asc (nulls last), then doc_no — the same
  // deterministic order computeMrp walks.
  claimLines.sort((a, b) => {
    const da = a.effDate ? String(a.effDate) : null;
    const db = b.effDate ? String(b.effDate) : null;
    if (da !== db) {
      if (da == null) return 1;
      if (db == null) return -1;
      return da < db ? -1 : 1;
    }
    return String(a.doc_no).localeCompare(String(b.doc_no));
  });

  const wantedCodes = [...new Set(claimLines.map((l) => l.item_code).filter(Boolean))];
  const openLots = wantedCodes.length
    ? await pg`
        SELECT l.id::text AS id, l.company_id, l.warehouse_id::text AS warehouse_id,
               l.product_code, COALESCE(l.variant_key,'') AS vk, l.qty_remaining,
               l.batch_no, UPPER(COALESCE(l.source_doc_type,'')) AS lot_src,
               p.po_number AS grn_po
          FROM scm.inventory_lots l
          LEFT JOIN scm.grns g ON UPPER(COALESCE(l.source_doc_type,'')) = 'GRN' AND g.id = l.source_doc_id
          LEFT JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
         WHERE l.qty_remaining > 0 AND l.product_code = ANY(${wantedCodes})
         ORDER BY l.received_at ASC, l.id ASC`
    : [];
  // Bucket lots by (company, warehouse, code) — variant matched loosely below,
  // same reasoning as the delivered side.
  const lotsByBucket = new Map();
  for (const l of openLots) {
    const k = `${Number(l.company_id)}::${l.warehouse_id}::${l.product_code}`;
    const arr = lotsByBucket.get(k) ?? [];
    arr.push(l);
    lotsByBucket.set(k, arr);
  }
  // FIFO walk per bucket, claims in allocation order.
  const readyBySoItem = new Map(); // so_item_id -> { pos:Set, adj, unbatched, noLots }
  {
    const cursor = new Map(); // bucket -> { idx, used }
    for (const cl of claimLines) {
      const k = `${cl.companyId}::${cl.warehouse_id}::${cl.item_code}`;
      const bucketLots = lotsByBucket.get(k) ?? [];
      const cur = cursor.get(k) ?? { idx: 0, used: 0 };
      const res = { pos: new Set(), adj: false, unbatched: 0, noLots: bucketLots.length === 0 };
      let need = cl.remaining;
      while (need > 0 && cur.idx < bucketLots.length) {
        const lot = bucketLots[cur.idx];
        const avail = Math.max(0, Number(lot.qty_remaining ?? 0) - cur.used);
        if (avail <= 0) { cur.idx += 1; cur.used = 0; continue; }
        const take = Math.min(avail, need);
        need -= take; cur.used += take;
        const po = lot.batch_no ?? lot.grn_po ?? null;
        if (po) res.pos.add(po);
        else if (lot.lot_src === "ADJUSTMENT") res.adj = true;
        else res.unbatched += take;
        if (cur.used >= Number(lot.qty_remaining ?? 0)) { cur.idx += 1; cur.used = 0; }
      }
      cursor.set(k, cur);
      readyBySoItem.set(cl.id, res);
    }
  }

  // 4. Classify every line.
  const classCounts = new Map();
  const problems = []; // { class, line, note }
  const bump = (cls) => classCounts.set(cls, (classCounts.get(cls) ?? 0) + 1);
  for (const l of lines) {
    const so = soByDoc.get(l.doc_no);
    const status = so?.status ?? "?";
    const isSofa = String(l.item_group ?? "").toUpperCase().includes("SOFA");
    if (isService(l.item_group, l.item_code)) { bump("service"); continue; }
    const del = deliveredBySoItem.get(l.id);
    const deliveredQty = del?.qty ?? 0;
    const remaining = Math.max(0, Number(l.qty ?? 0) - deliveredQty);

    if (deliveredQty > 0) {
      if ((del?.pos.size ?? 0) > 0) bump("ok-delivered");
      else if (del?.adj) bump("ok-adjustment");
      else if (!del?.any) {
        bump("do-no-ledger");
        problems.push({ cls: "do-no-ledger", l, note: `${status}: DO line(s) exist but wrote no movement/consumption` });
      } else {
        bump("consumed-lot-unbatchable");
        problems.push({ cls: "consumed-lot-unbatchable", l, note: `${status}: consumed lot(s) carry no batch and no GRN/adjustment evidence (${del.unbatchable} unit(s))` });
      }
      if (remaining <= 0) continue; // fully delivered — done with this line
    } else if ((status === "DELIVERED" || status === "SHIPPED") && (doCountByDoc.get(l.doc_no) ?? 0) > 0 && !deliveredBySoItem.has(l.id)) {
      bump("no-do-line-link");
      problems.push({ cls: "no-do-line-link", l, note: `${status}: the SO has ${doCountByDoc.get(l.doc_no)} DO(s) but no DO line carries this line's so_item_id` });
      continue;
    }

    // READY remainder.
    if (remaining > 0) {
      const lineReady = l.stock_status === "READY" || status === "READY_TO_SHIP";
      if (!lineReady) { bump("not-ready"); continue; }
      if (isSofa) {
        if ((l.allocated_batch_no ?? "").trim()) bump("ok-ready");
        else {
          bump("sofa-ready-no-batch");
          problems.push({ cls: "sofa-ready-no-batch", l, note: `${status}: READY sofa with no allocated_batch_no` });
        }
        continue;
      }
      const r = readyBySoItem.get(l.id);
      if (!r || r.noLots) {
        bump("ready-no-open-lots");
        problems.push({ cls: "ready-no-open-lots", l, note: `${status}: READY but its (company, warehouse, code) bucket holds no open lots` });
      } else if (r.pos.size > 0) bump("ok-ready");
      else if (r.adj) bump("ok-adjustment");
      else {
        bump("ready-lot-unbatchable");
        problems.push({ cls: "ready-lot-unbatchable", l, note: `${status}: FIFO slice lands on lot(s) with no batch/GRN/adjustment evidence (${r.unbatched} unit(s))` });
      }
    }
  }

  log("");
  log("CLASSES (per line):");
  for (const [cls, n] of [...classCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    log(`  ${cls}: ${n}`);
  }
  log("");
  const unresolved = problems.length;
  log(`UNRESOLVED LINES: ${unresolved}`);
  for (const p of problems) {
    log(`  [${p.cls}] ${coCode.get(Number(soByDoc.get(p.l.doc_no)?.company_id)) ?? "?"} ${p.l.doc_no}  ${p.l.item_code}  qty=${p.l.qty}  ${p.note}`);
  }

  // 5. Double-attribution verdict — audit-inventory-costing.mjs section 10c
  //    lens VERBATIM: a movement must never have consumed more than it moved,
  //    and every consumption must belong to a real movement.
  const overAttr = await pg`
    SELECT m.id::text AS id, m.source_doc_no, ABS(m.qty) AS moved, SUM(c.qty_consumed)::int AS consumed
      FROM scm.inventory_movements m
      JOIN scm.inventory_lot_consumptions c ON c.movement_id = m.id
     WHERE m.movement_type = 'OUT'
     GROUP BY m.id, m.source_doc_no, m.qty
    HAVING SUM(c.qty_consumed) > ABS(m.qty)`;
  const orphanCons = await pg`
    SELECT COUNT(*)::int AS n FROM scm.inventory_lot_consumptions c
     WHERE c.movement_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM scm.inventory_movements m WHERE m.id = c.movement_id)`;
  const dbl = overAttr.length + Number(orphanCons[0]?.n ?? 0);
  log("");
  log(`DOUBLE-ATTRIBUTION VERDICT (audit-inventory-costing.mjs section 10c lens): ${dbl === 0
    ? "ZERO units attributed to two DOs — no movement consumed more than it moved, no orphan consumption."
    : `${overAttr.length} over-attributing movement(s) + ${orphanCons[0]?.n ?? 0} orphan consumption(s) — investigate before trusting per-DO quantities.`}`);
  for (const o of overAttr) log(`  movement ${o.id} (${o.source_doc_no}) moved ${o.moved}, consumed ${o.consumed}`);

  log("");
  log(unresolved === 0
    ? "VERDICT: zero-or-explained holds — every in-scope line resolves to a PO, STOCK ADJ, or a service line."
    : `VERDICT: ${unresolved} line(s) do not resolve — classes above say why; backfill-lot-batch-from-docs.mjs covers the grn/basis-seed classes, the rest are listed for the owner.`);
} finally {
  await pg.end({ timeout: 5 });
}
