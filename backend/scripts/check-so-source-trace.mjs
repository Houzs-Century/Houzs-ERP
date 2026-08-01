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
//                        so_item_id (the ON DELETE SET NULL trap / import).
//                        Fix tool: part=do-line-link on Repair 2990 doc
//                        references (stamps the determined link).
//   do-no-ledger         DO lines exist but wrote no movement/consumption
//   consumed-lot-unbatchable   consumption found, lot has no batch AND no
//                        GRN/adjustment evidence (backfill-lot-batch-from-docs
//                        cannot stamp it either — pre-import receipt)
//   sofa-ready-no-batch  READY sofa without allocated_batch_no
//   ready-no-open-lots   READY line but its bucket holds no open lots — a
//                        STALE allocation flag (the allocator only runs as a
//                        post-ship/post-receipt side effect, so nothing ever
//                        re-evaluated it after the stock left). Fix tool:
//                        Recompute SO stock allocation workflow (the
//                        canonical recomputeSoStockAllocation, dispatchable).
//   ready-lot-unbatchable   ACCEPTED-EXPLAINED, not a defect: the FIFO slice
//                        lands on pre-0120 / no-evidence lots (received
//                        before lots carried batch/GRN identity). READY
//                        cannot show a source PO until DO time consumes the
//                        lot; counted apart from the unresolved verdict.
//   not-ready            line on a READY_TO_SHIP order that is itself not
//                        READY and not delivered (status/stock mismatch, FYI)
//
// Plus the owner's one-line verdict: whether ANY unit is attributed to two
// DOs — the audit-inventory-costing.mjs section 10c lens verbatim (per
// movement: SUM(qty_consumed) <= |qty|; every consumption has a movement).
//
// SINCE 2026-08-02 this check also holds the ONE-TRUTH invariants the owner
// mandated after the 2990-DO-2607-017 phantom-chip and 2990-PO-2606-023
// re-claim incidents:
//
//   SECTION 6  DO HEADER vs LINE-UNION — per non-cancelled DO, the raw ledger
//              rollup (every (code,variant) bucket keyed to the DO) compared
//              against the union of ITS OWN lines' buckets. Orphan buckets
//              (ledger rows no physical line owns — re-pointed consumptions,
//              drifted variant keys, edited lines) are what the OLD header
//              cell surfaced as phantom chips; the app now derives header
//              cells as the line union BY CONSTRUCTION, so orphans can no
//              longer reach the UI — this section keeps counting them as DATA
//              anomalies (trend to 0 as ledger repairs land). DOS env names
//              DOs to print in full detail.
//   SECTION 7  J1 — SO line served by >1 distinct PO (delivered chain).
//              SOFA multi-batch = HARD DEFECT (one set ships one batch);
//              non-sofa with an OLDER still-open lot in the bucket =
//              fifo-suspect (a newer receipt was consumed while an older one
//              still sits open — eyeball); else boundary-split-legit (qty
//              genuinely spans two receipts), listed for the owner.
//   SECTION 8  J2 — PO line assigned to >1 SO. Allocation splits summing <=
//              line qty are the owner-approved consolidated model (LEGIT);
//              CONFLICTS: allocations exceeding line qty, allocation rows
//              naming an SO line the delivered chain proves served by ANOTHER
//              PO (the 023 class), stored so_item_id disagreeing with the
//              PO's own delivered chain.
//   SECTION 9  J3 — SO line CLAIMED by >1 PO's stored links/allocations —
//              THE 023/024 defect class exactly. Expected 0 after
//              part=fifo-attribute-repair.
//   CLOSING    the one-truth verdict: J3 = 0 AND J1 has no HARD/suspect rows
//              AND J2 has no CONFLICT rows. Re-runs prove the invariant.
//
// Read-only (SELECTs only), exit 0 for every legitimate answer.
//   DATABASE_URL  required (env, or .dev.vars for local use)
//   DOS           section-6 detail DOs (default 2990-DO-2607-016,2990-DO-2607-017)
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { variantKeyMirror } from "./lib/ledger-repair-core.mjs";

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
    SELECT doc_no, UPPER(status::text) AS status, company_id, customer_delivery_date
      FROM scm.mfg_sales_orders
     WHERE UPPER(status::text) IN ('READY_TO_SHIP','SHIPPED','DELIVERED')`;
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
           i.cancelled, UPPER(COALESCE(i.stock_status::text,'')) AS stock_status,
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
               UPPER(COALESCE(d.status::text,'')) AS do_status, d.do_number
          FROM scm.delivery_order_items di
          JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
         WHERE di.so_item_id::text = ANY(${soItemIds})
           AND UPPER(COALESCE(d.status::text,'')) <> 'CANCELLED'`
    : [];
  const doIds = [...new Set(doLines.map((r) => r.delivery_order_id))];

  // Also DOC-LEVEL delivery signal (a DO on the SO whose lines lost their link).
  const docDos = await pg`
    SELECT so_doc_no, COUNT(*)::int AS n FROM scm.delivery_orders
     WHERE so_doc_no = ANY(${docNos}) AND UPPER(COALESCE(status::text,'')) <> 'CANCELLED'
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
               l.source_doc_id::text AS lot_src_id, l.id::text AS lot_id,
               l.received_at, l.warehouse_id::text AS lot_wh, l.company_id AS lot_company,
               p.po_number AS grn_po
          FROM scm.inventory_lot_consumptions c
          JOIN scm.inventory_lots l ON l.id = c.lot_id
          LEFT JOIN scm.grns g ON UPPER(COALESCE(l.source_doc_type,'')) = 'GRN' AND g.id = l.source_doc_id
          LEFT JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
         WHERE c.source_doc_type = 'DO' AND c.source_doc_id::text = ANY(${doIds})`
    : [];
  // (do::code::vk) -> { pos:Set, adj:boolean, any:boolean, movPos:Set, lots:[] }
  const ledger = new Map();
  const led = (k) => {
    let v = ledger.get(k);
    if (!v) { v = { pos: new Set(), adj: false, any: false, unbatchable: 0, movPos: new Set(), lots: [] }; ledger.set(k, v); }
    return v;
  };
  for (const m of movs) {
    const v = led(`${m.do_id}::${m.product_code}::${m.vk}`);
    v.pos.add(m.batch_no); v.any = true; v.movPos.add(m.batch_no);
  }
  for (const r of cons) {
    const v = led(`${r.do_id}::${r.product_code}::${r.vk}`);
    v.any = true;
    const po = r.batch_no ?? r.grn_po ?? null;
    if (po) v.pos.add(po);
    else if (r.lot_src === "ADJUSTMENT") v.adj = true;
    else v.unbatchable += Math.abs(Number(r.qty_consumed ?? 0));
    v.lots.push({ lotId: r.lot_id, po, receivedAt: r.received_at, wh: r.lot_wh, company: r.lot_company, qty: Math.abs(Number(r.qty_consumed ?? 0)) });
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
  const deliveredBySoItem = new Map(); // so_item_id -> { qty, pos:Set, adj, any, unbatchable, lots:[] }
  for (const dl of doLines) {
    const cur = deliveredBySoItem.get(dl.so_item_id) ?? { qty: 0, pos: new Set(), adj: false, any: false, unbatchable: 0, lots: [] };
    cur.qty += Number(dl.qty ?? 0);
    const buckets = ledgerByDoCode.get(`${dl.delivery_order_id}::${dl.item_code}`) ?? [];
    for (const b of buckets) {
      cur.any = cur.any || b.any;
      cur.adj = cur.adj || b.adj;
      cur.unbatchable += b.unbatchable;
      for (const po of b.pos) cur.pos.add(po);
      for (const lot of b.lots) cur.lots.push(lot);
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
      problems.push({ cls: "no-do-line-link", l, note: `${status}: the SO has ${doCountByDoc.get(l.doc_no)} DO(s) but no DO line carries this line's so_item_id — fix: part=do-line-link on Repair 2990 doc references` });
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
        problems.push({ cls: "ready-no-open-lots", l, note: `${status}: READY but its (company, warehouse, code) bucket holds no open lots — a STALE allocation flag; fix: Recompute SO stock allocation workflow` });
      } else if (r.pos.size > 0) bump("ok-ready");
      else if (r.adj) bump("ok-adjustment");
      else {
        bump("ready-lot-unbatchable");
        problems.push({ cls: "ready-lot-unbatchable", l, note: `${status}: ACCEPTED-EXPLAINED — FIFO slice lands on pre-0120/no-evidence lot(s) (${r.unbatched} unit(s), received before lots carried batch/GRN identity); READY cannot show a source PO until DO time consumes the lot. Not a defect.` });
      }
    }
  }

  log("");
  log("CLASSES (per line):");
  for (const [cls, n] of [...classCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    log(`  ${cls}: ${n}`);
  }
  log("");
  // ready-lot-unbatchable is ACCEPTED-EXPLAINED (pre-0120/no-evidence lots —
  // READY has no PO to show until DO time), so it prints apart from the
  // unresolved verdict instead of masquerading as a defect.
  const ACCEPTED = new Set(["ready-lot-unbatchable"]);
  const accepted = problems.filter((p) => ACCEPTED.has(p.cls));
  const open = problems.filter((p) => !ACCEPTED.has(p.cls));
  const unresolved = open.length;
  log(`UNRESOLVED LINES: ${unresolved}  (accepted-explained, listed separately: ${accepted.length})`);
  for (const p of open) {
    log(`  [${p.cls}] ${coCode.get(Number(soByDoc.get(p.l.doc_no)?.company_id)) ?? "?"} ${p.l.doc_no}  ${p.l.item_code}  qty=${p.l.qty}  ${p.note}`);
  }
  if (accepted.length) {
    log("");
    log(`ACCEPTED-EXPLAINED LINES: ${accepted.length}  (pre-0120/no-evidence lots — not defects)`);
    for (const p of accepted) {
      log(`  [${p.cls}] ${coCode.get(Number(soByDoc.get(p.l.doc_no)?.company_id)) ?? "?"} ${p.l.doc_no}  ${p.l.item_code}  qty=${p.l.qty}  ${p.note}`);
    }
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
    ? `VERDICT (trace): zero-or-explained holds — every in-scope line resolves to a PO, STOCK ADJ, a service line, or an accepted-explained pre-0120 lot${accepted.length ? ` (${accepted.length} of those)` : ""}.`
    : `VERDICT (trace): ${unresolved} line(s) do not resolve — classes above name their fix tools (ready-no-open-lots -> Recompute SO stock allocation; no-do-line-link -> part=do-line-link; the grn/basis-seed classes -> backfill-lot-batch-from-docs.mjs); the rest are listed for the owner.`);

  // ── 6. DO HEADER vs LINE-UNION (the 2990-DO-2607-017 phantom-chip lens) ───
  const DETAIL_DOS = (process.env.DOS || "2990-DO-2607-016,2990-DO-2607-017")
    .split(",").map((s) => s.trim()).filter(Boolean);
  log("");
  log("SECTION 6 — DO header-vs-line-union (orphan ledger buckets):");
  const allDos = await pg`
    SELECT d.id::text AS id, d.do_number, d.company_id
      FROM scm.delivery_orders d
     WHERE UPPER(COALESCE(d.status::text,'')) <> 'CANCELLED'`;
  const allDoIds = allDos.map((d) => d.id);
  const allDoItems = allDoIds.length ? await pg`
    SELECT delivery_order_id::text AS do_id, item_code, item_group, variants
      FROM scm.delivery_order_items WHERE delivery_order_id::text = ANY(${allDoIds})` : [];
  const allMovs = allDoIds.length ? await pg`
    SELECT source_doc_id::text AS do_id, product_code, COALESCE(variant_key,'') AS vk, batch_no
      FROM scm.inventory_movements
     WHERE source_doc_type = 'DO' AND movement_type = 'OUT'
       AND source_doc_id::text = ANY(${allDoIds}) AND batch_no IS NOT NULL` : [];
  const allCons = allDoIds.length ? await pg`
    SELECT c.source_doc_id::text AS do_id, c.product_code, COALESCE(c.variant_key,'') AS vk,
           COALESCE(l.batch_no, p.po_number) AS po, UPPER(COALESCE(l.source_doc_type,'')) AS lot_src
      FROM scm.inventory_lot_consumptions c
      JOIN scm.inventory_lots l ON l.id = c.lot_id
      LEFT JOIN scm.grns g ON UPPER(COALESCE(l.source_doc_type,'')) = 'GRN' AND g.id = l.source_doc_id
      LEFT JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
     WHERE c.source_doc_type = 'DO' AND c.source_doc_id::text = ANY(${allDoIds})` : [];
  const SERVICE_LINE_RE = /^(DELIVERY|DISPOSE|LIFT)/i;
  const isSvc = (group, code) => SERVICE_RE.test(String(group ?? "")) || SERVICE_LINE_RE.test(String(code ?? ""));
  // Per DO: line buckets (code::computed vk, services excluded) + line codes.
  const lineBucketsByDo = new Map();
  const lineCodesByDo = new Map();
  for (const it of allDoItems) {
    if (isSvc(it.item_group, it.item_code)) continue;
    const vk = variantKeyMirror(it.item_group, it.variants ?? null);
    const bset = lineBucketsByDo.get(it.do_id) ?? new Set();
    bset.add(`${it.item_code}::${vk}`);
    lineBucketsByDo.set(it.do_id, bset);
    const cset = lineCodesByDo.get(it.do_id) ?? new Set();
    cset.add(String(it.item_code ?? ""));
    lineCodesByDo.set(it.do_id, cset);
  }
  // Per DO: ledger buckets with their POs + which side wrote them.
  const ledgerBucketsByDo = new Map();
  const bucketAdd = (doId, code, vk, po, side) => {
    if (!po) return;
    const m = ledgerBucketsByDo.get(doId) ?? new Map();
    const k = `${code}::${vk}`;
    const cur = m.get(k) ?? { pos: new Set(), sides: new Set() };
    cur.pos.add(po);
    cur.sides.add(side);
    m.set(k, cur);
    ledgerBucketsByDo.set(doId, m);
  };
  for (const m of allMovs) bucketAdd(m.do_id, m.product_code, m.vk, m.batch_no, "movement");
  for (const r of allCons) bucketAdd(r.do_id, r.product_code, r.vk, r.po, "consumption");
  const doNoById2 = new Map(allDos.map((d) => [d.id, d.do_number]));
  const detailWanted = new Set(DETAIL_DOS);
  let orphanDoCount = 0;
  let orphanBucketCount = 0;
  const orphanSamples = [];
  for (const [doId, buckets] of ledgerBucketsByDo.entries()) {
    const lineBuckets = lineBucketsByDo.get(doId) ?? new Set();
    const lineCodes = lineCodesByDo.get(doId) ?? new Set();
    const orphans = [];
    for (const [bk, v] of buckets.entries()) {
      if (lineBuckets.has(bk)) continue;
      const code = bk.split("::")[0];
      orphans.push({
        bucket: bk,
        pos: [...v.pos].sort(),
        sides: [...v.sides].sort().join("+"),
        kind: lineCodes.has(code) ? "vk-drift (same code, different variant key)" : "no-line (no physical line carries this code)",
      });
    }
    if (orphans.length === 0) continue;
    orphanDoCount += 1;
    orphanBucketCount += orphans.length;
    if (orphanSamples.length < 25 || detailWanted.has(doNoById2.get(doId) ?? "")) {
      orphanSamples.push({ doNo: doNoById2.get(doId) ?? doId, orphans });
    }
  }
  log(`  app-level header-vs-drill mismatch: 0 BY CONSTRUCTION since 2026-08-02 — header cells derive from the line union (resolveDoHeaderSources), the raw byDo rollup no longer reaches any UI cell.`);
  log(`  ORPHAN ledger buckets (data anomalies the old header surfaced as phantom chips): ${orphanBucketCount} bucket(s) across ${orphanDoCount} DO(s). These trend to 0 as ledger repairs (doc-relabel / repoints) land; they are invisible to the UI either way.`);
  for (const s of orphanSamples) {
    for (const o of s.orphans) {
      log(`    ${s.doNo}: orphan bucket [${o.bucket}] pos={${o.pos.join(", ")}} via ${o.sides} — ${o.kind}`);
    }
  }
  for (const want of DETAIL_DOS) {
    const row = allDos.find((d) => d.do_number === want);
    if (!row) { log(`  DETAIL ${want}: not found / cancelled.`); continue; }
    const lineBuckets = [...(lineBucketsByDo.get(row.id) ?? new Set())].sort();
    const buckets = ledgerBucketsByDo.get(row.id) ?? new Map();
    const union = new Set();
    for (const bk of lineBuckets) for (const po of buckets.get(bk)?.pos ?? []) union.add(po);
    const raw = new Set();
    for (const v of buckets.values()) for (const po of v.pos) raw.add(po);
    log(`  DETAIL ${want}: header (line-union) = {${[...union].sort().join(", ")}}; raw ledger rollup = {${[...raw].sort().join(", ")}}${raw.size !== union.size ? "  << the difference is the phantom the old cell showed" : "  (identical — no orphans)"}`);
    for (const [bk, v] of buckets.entries()) {
      log(`      ledger bucket [${bk}] pos={${[...v.pos].sort().join(", ")}} via ${[...v.sides].join("+")}${lineBucketsByDo.get(row.id)?.has(bk) ? "" : "  << ORPHAN"}`);
    }
  }

  // ── 7. J1 — SO line served by >1 distinct PO (delivered chain) ────────────
  log("");
  log("SECTION 7 — J1: SO lines served by >1 PO (delivered chain):");
  const lineById = new Map(lines.map((l) => [l.id, l]));
  let j1Hard = 0, j1Suspect = 0, j1Legit = 0;
  for (const [soItemId, del] of deliveredBySoItem.entries()) {
    if ((del.pos?.size ?? 0) <= 1) continue;
    const l = lineById.get(soItemId);
    if (!l) continue;
    const isSofa = String(l.item_group ?? "").toUpperCase().includes("SOFA");
    const posList = [...del.pos].sort().join(" + ");
    const qtyByPo = new Map();
    for (const lot of del.lots ?? []) {
      if (lot.po) qtyByPo.set(lot.po, (qtyByPo.get(lot.po) ?? 0) + lot.qty);
    }
    const split = [...qtyByPo.entries()].map(([po, q]) => `${po} x${q}`).join(", ");
    if (isSofa) {
      j1Hard += 1;
      log(`  [HARD DEFECT — sofa multi-batch] ${coCode.get(Number(soByDoc.get(l.doc_no)?.company_id)) ?? "?"} ${l.doc_no} ${l.item_code} qty=${l.qty}: served by ${posList} (${split}) — one sofa set must ship one batch (9d expects 0).`);
      continue;
    }
    // fifo-suspect: an OLDER lot for the same (company, code) still open while
    // a NEWER receipt was consumed for this line.
    const newestConsumed = (del.lots ?? []).map((x) => x.receivedAt).filter(Boolean).sort().pop() ?? null;
    let suspect = false;
    if (newestConsumed) {
      const older = await pg`
        SELECT COUNT(*)::int AS n FROM scm.inventory_lots
         WHERE product_code = ${l.item_code} AND qty_remaining > 0
           AND received_at < ${newestConsumed}
           AND company_id = ${Number(soByDoc.get(l.doc_no)?.company_id ?? 0)}`;
      suspect = Number(older[0]?.n ?? 0) > 0;
    }
    if (suspect) {
      j1Suspect += 1;
      log(`  [fifo-suspect] ${coCode.get(Number(soByDoc.get(l.doc_no)?.company_id)) ?? "?"} ${l.doc_no} ${l.item_code} qty=${l.qty}: served by ${posList} (${split}) while an OLDER lot still sits open in the bucket — eyeball (9c expects strict FIFO).`);
    } else {
      j1Legit += 1;
      log(`  [boundary-split-legit] ${coCode.get(Number(soByDoc.get(l.doc_no)?.company_id)) ?? "?"} ${l.doc_no} ${l.item_code} qty=${l.qty}: ${split} — qty genuinely spans two receipts; listed for the owner's eyes.`);
    }
  }
  log(`  J1 totals: hard-defect(sofa)=${j1Hard}, fifo-suspect=${j1Suspect}, boundary-split-legit=${j1Legit}.`);

  // ── 8. J2 — PO line assigned to >1 SO ─────────────────────────────────────
  log("");
  log("SECTION 8 — J2: PO lines assigned to >1 SO:");
  const allocLines = await pg`
    SELECT i.id::text AS line_id, i.qty AS line_qty, i.material_code,
           i.so_item_id::text AS stored_so_item, p.po_number, p.company_id,
           COALESCE(SUM(a.qty), 0)::int AS alloc_qty,
           COUNT(a.id)::int AS alloc_n,
           COUNT(DISTINCT a.so_item_id)::int AS alloc_so_n,
           array_agg(DISTINCT a.so_item_id::text) FILTER (WHERE a.so_item_id IS NOT NULL) AS alloc_so_items
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
      LEFT JOIN scm.purchase_order_item_allocations a ON a.purchase_order_item_id = i.id
     WHERE UPPER(COALESCE(p.status::text,'')) <> 'CANCELLED'
     GROUP BY i.id, i.qty, i.material_code, i.so_item_id, p.po_number, p.company_id
    HAVING COUNT(a.id) > 0`;
  // SO docs + served state for every allocation-named SO line.
  const allocSoIds = [...new Set(allocLines.flatMap((r) => r.alloc_so_items ?? []).filter(Boolean))];
  const allocSoRows = allocSoIds.length ? await pg`
    SELECT id::text AS id, doc_no, qty FROM scm.mfg_sales_order_items WHERE id::text = ANY(${allocSoIds})` : [];
  const allocSoDoc = new Map(allocSoRows.map((r) => [r.id, r.doc_no]));
  const allocSoQty = new Map(allocSoRows.map((r) => [r.id, Number(r.qty ?? 0)]));
  // Delivered service for those SO lines (which POs actually served them).
  const servedRows = allocSoIds.length ? await pg`
    SELECT di.so_item_id::text AS so_item_id, di.qty,
           COALESCE(l.batch_no, gp.po_number) AS po
      FROM scm.delivery_order_items di
      JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
      JOIN scm.inventory_lot_consumptions c
        ON c.source_doc_type = 'DO' AND c.source_doc_id = di.delivery_order_id
       AND c.product_code = di.item_code
      JOIN scm.inventory_lots l ON l.id = c.lot_id
      LEFT JOIN scm.grns g ON UPPER(COALESCE(l.source_doc_type,'')) = 'GRN' AND g.id = l.source_doc_id
      LEFT JOIN scm.purchase_orders gp ON gp.id = g.purchase_order_id
     WHERE di.so_item_id::text = ANY(${allocSoIds})
       AND UPPER(COALESCE(d.status::text,'')) <> 'CANCELLED'` : [];
  const servedBySo = new Map(); // so_item_id -> { pos:Set, qty }
  for (const r of servedRows) {
    if (!r.po) continue;
    const cur = servedBySo.get(r.so_item_id) ?? { pos: new Set(), qty: 0 };
    cur.pos.add(r.po);
    servedBySo.set(r.so_item_id, cur);
  }
  // Delivered qty per SO line (documented DO-line qty where the bucket resolves).
  const servedQtyRows = allocSoIds.length ? await pg`
    SELECT di.so_item_id::text AS so_item_id, SUM(di.qty)::int AS qty
      FROM scm.delivery_order_items di
      JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
     WHERE di.so_item_id::text = ANY(${allocSoIds})
       AND UPPER(COALESCE(d.status::text,'')) <> 'CANCELLED'
       AND EXISTS (SELECT 1 FROM scm.inventory_lot_consumptions c
                    WHERE c.source_doc_type = 'DO' AND c.source_doc_id = di.delivery_order_id
                      AND c.product_code = di.item_code)
     GROUP BY di.so_item_id` : [];
  const servedQtyBySo = new Map(servedQtyRows.map((r) => [r.so_item_id, Number(r.qty ?? 0)]));
  let j2Legit = 0, j2Conflict = 0;
  for (const r of allocLines) {
    const conflicts = [];
    if (Number(r.alloc_qty) > Number(r.line_qty)) {
      conflicts.push(`allocations sum ${r.alloc_qty} EXCEEDS line qty ${r.line_qty}`);
    }
    for (const soId of r.alloc_so_items ?? []) {
      const served = servedBySo.get(soId);
      if (!served || served.pos.size === 0) continue;
      const servedQ = servedQtyBySo.get(soId) ?? 0;
      const fullyServed = servedQ >= (allocSoQty.get(soId) ?? Number.POSITIVE_INFINITY);
      if (fullyServed && !served.pos.has(r.po_number)) {
        conflicts.push(`allocation names ${allocSoDoc.get(soId) ?? soId} whose demand the delivered chain proves served by ${[...served.pos].sort().join("+")} (the 023 class)`);
      }
    }
    if (conflicts.length > 0) {
      j2Conflict += 1;
      log(`  [CONFLICT] ${coCode.get(Number(r.company_id)) ?? "?"} ${r.po_number} line ${r.line_id} ${r.material_code}: ${conflicts.join("; ")} — fix: part=fifo-attribute-repair.`);
    } else if (Number(r.alloc_so_n) > 1) {
      j2Legit += 1; // consolidated split — the owner-approved model; counted, not printed
    }
  }
  // Stored so_item_id vs the PO's own delivered chain (PO-level lens).
  const storedVsDelivered = await pg`
    SELECT p.po_number, p.company_id, i.id::text AS line_id, i.material_code, si.doc_no AS stored_doc
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
      JOIN scm.mfg_sales_order_items si ON si.id = i.so_item_id
     WHERE i.so_item_id IS NOT NULL AND UPPER(COALESCE(p.status::text,'')) <> 'CANCELLED'`;
  const svdPoNos = [...new Set(storedVsDelivered.map((r) => r.po_number).filter(Boolean))];
  const poServedDocs = new Map(); // po_number -> Set(so doc)
  if (svdPoNos.length) {
    const rows2 = await pg`
      SELECT l.batch_no AS po_number, so_items.doc_no
        FROM scm.inventory_lots l
        JOIN scm.inventory_lot_consumptions c ON c.lot_id = l.id AND c.source_doc_type = 'DO'
        JOIN scm.delivery_order_items di
          ON di.delivery_order_id = c.source_doc_id AND di.item_code = c.product_code
        JOIN scm.mfg_sales_order_items so_items ON so_items.id = di.so_item_id
       WHERE l.batch_no = ANY(${svdPoNos})`;
    for (const r of rows2) {
      const set = poServedDocs.get(r.po_number) ?? new Set();
      set.add(r.doc_no);
      poServedDocs.set(r.po_number, set);
    }
  }
  for (const r of storedVsDelivered) {
    const servedDocs = poServedDocs.get(r.po_number);
    if (!servedDocs || servedDocs.size === 0) continue; // nothing delivered — nothing to disagree with
    if (!servedDocs.has(r.stored_doc)) {
      j2Conflict += 1;
      log(`  [CONFLICT] ${coCode.get(Number(r.company_id)) ?? "?"} ${r.po_number} line ${r.line_id} ${r.material_code}: stored link says ${r.stored_doc} but the PO's delivered chain served {${[...servedDocs].sort().join(", ")}} — stored-vs-delivered disagreement (needs eyes).`);
    }
  }
  log(`  J2 totals: consolidated multi-SO splits (LEGIT, allocation model): ${j2Legit}; CONFLICTS: ${j2Conflict}.`);

  // ── 9. J3 — SO line claimed by >1 PO (stored links ∪ allocations) ─────────
  log("");
  log("SECTION 9 — J3: SO lines claimed by >1 PO (the 023/024 defect class):");
  const j3 = await pg`
    WITH claims AS (
      SELECT i.so_item_id, i.purchase_order_id AS po_id
        FROM scm.purchase_order_items i
        JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
       WHERE i.so_item_id IS NOT NULL AND UPPER(COALESCE(p.status::text,'')) <> 'CANCELLED'
      UNION
      SELECT a.so_item_id, i.purchase_order_id
        FROM scm.purchase_order_item_allocations a
        JOIN scm.purchase_order_items i ON i.id = a.purchase_order_item_id
        JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
       WHERE a.so_item_id IS NOT NULL AND UPPER(COALESCE(p.status::text,'')) <> 'CANCELLED'
    )
    SELECT c.so_item_id::text AS so_item_id, si.doc_no, si.item_code,
           array_agg(DISTINCT p.po_number ORDER BY p.po_number) AS pos
      FROM claims c
      JOIN scm.purchase_orders p ON p.id = c.po_id
      LEFT JOIN scm.mfg_sales_order_items si ON si.id = c.so_item_id
     GROUP BY c.so_item_id, si.doc_no, si.item_code
    HAVING COUNT(DISTINCT c.po_id) > 1`;
  for (const r of j3) {
    log(`  [DOUBLE-CLAIM] SO line ${r.so_item_id} (${r.doc_no ?? "?"} ${r.item_code ?? "?"}) claimed by: ${(r.pos ?? []).join(", ")} — fix: part=fifo-attribute-repair.`);
  }
  log(`  J3 total: ${j3.length} SO line(s) claimed by more than one PO. Expected 0.`);

  // ── CLOSING one-truth verdict ─────────────────────────────────────────────
  log("");
  const oneTruthHolds = j3.length === 0 && j1Hard === 0 && j1Suspect === 0 && j2Conflict === 0;
  log(oneTruthHolds
    ? `ONE-TRUTH VERDICT: HOLDS — J3 double-claims = 0, J1 has no hard/suspect rows (${j1Legit} legitimate boundary split(s) listed), J2 has no conflicts (${j2Legit} legitimate consolidated split(s)), and header cells are the line union by construction.`
    : `ONE-TRUTH VERDICT: VIOLATED — J3 double-claims: ${j3.length} (expect 0), J1 hard-defects: ${j1Hard} + fifo-suspects: ${j1Suspect} (expect 0), J2 conflicts: ${j2Conflict} (expect 0). Fix tools: part=fifo-attribute-repair for the claim classes; sofa multi-batch and fifo-suspects go to the owner with the rows above.`);
} finally {
  await pg.end({ timeout: 5 });
}
