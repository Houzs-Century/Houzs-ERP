#!/usr/bin/env node
// Read-only: for one stock take, which PO(s) hold the stock on each line?
//
// Sim (2026-10-26) wants the PO beside each sofa / bedframe line on the count
// sheet. This lists every line of TAKE_NO with the open lots (qty_remaining > 0)
// of its (item_code, variant_key) at the take's warehouse, and each lot's PO:
// batch_no, else the GRN's purchase order, else its source type. Then a census:
// how many lines are fully / partly / not traceable to a PO, per category.
//
// Strictly SELECTs inside a read-only transaction. Exits 0 for every answer.
//
// Env: DATABASE_URL (required); TAKE_NO (default HC-STK-2610-007); SHOW (default 60 lines printed).
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const TAKE_NO = String(process.env.TAKE_NO || 'HC-STK-2610-007').trim();
const SHOW = Number(process.env.SHOW) > 0 ? Number(process.env.SHOW) : 60;
const log = (m = '') => console.log(m);

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

async function main() {
  log(`diag-stock-take-source-po — ${TAKE_NO}, read-only`);
  await sql.begin('read only', async (t) => {
    const [take] = await t`SELECT id, take_no, status::text AS status, company_id, warehouse_id FROM scm.stock_takes WHERE take_no = ${TAKE_NO}`;
    if (!take) { log('take not found'); return; }
    log(`take ${take.take_no} status=${take.status} company=${take.company_id}`);
    const lines = await t`
      SELECT l.id, l.item_code, coalesce(l.variant_key, '') AS vk, l.variant_label, l.system_qty, l.counted_qty,
             coalesce(p.category::text, '?') AS category
        FROM scm.stock_take_lines l
        LEFT JOIN scm.mfg_products p ON p.code = l.item_code AND p.company_id = ${take.company_id}
       WHERE l.stock_take_id = ${take.id}
       ORDER BY l.item_code, l.variant_key, l.id`;
    const lots = await t`
      SELECT lo.item_code, coalesce(lo.variant_key, '') AS vk, lo.qty_remaining, lo.batch_no,
             lo.source_doc_type, lo.received_at, po.po_number AS grn_po, po.status::text AS po_status
        FROM scm.inventory_lots lo
        LEFT JOIN scm.grns g ON upper(coalesce(lo.source_doc_type, '')) = 'GRN' AND g.id::text = lo.source_doc_id::text
        LEFT JOIN scm.purchase_orders po ON po.id = g.purchase_order_id
       WHERE lo.company_id = ${take.company_id} AND lo.warehouse_id = ${take.warehouse_id}
         AND lo.qty_remaining > 0
         AND lo.item_code IN (SELECT item_code FROM scm.stock_take_lines WHERE stock_take_id = ${take.id})
       ORDER BY lo.received_at, lo.id`;
    const byKey = new Map();
    for (const lo of lots) {
      const k = `${lo.item_code} ${lo.vk}`;
      (byKey.get(k) ?? byKey.set(k, []).get(k)).push(lo);
    }
    const census = new Map();
    let shown = 0;
    let multiPo = 0;
    let batchVsGrnDiffer = 0;
    for (const l of lines) {
      const ls = byKey.get(`${l.item_code} ${l.vk}`) ?? [];
      const perPo = new Map();
      let noPoQty = 0;
      const kinds = new Set();
      for (const lo of ls) {
        const po = lo.batch_no || lo.grn_po || null;
        if (lo.batch_no && lo.grn_po && lo.batch_no !== lo.grn_po) batchVsGrnDiffer += 1;
        if (po) perPo.set(po, (perPo.get(po) ?? 0) + Number(lo.qty_remaining));
        else { noPoQty += Number(lo.qty_remaining); kinds.add(String(lo.source_doc_type || 'null')); }
      }
      if (perPo.size > 1) multiPo += 1;
      const lotQty = ls.reduce((s, x) => s + Number(x.qty_remaining), 0);
      const cls = ls.length === 0 ? 'no_open_lots' : perPo.size === 0 ? 'no_po' : noPoQty > 0 ? 'part_po' : 'all_po';
      const c = census.get(l.category) ?? {};
      c[cls] = (c[cls] ?? 0) + 1;
      c.lines = (c.lines ?? 0) + 1;
      census.set(l.category, c);
      if (shown < SHOW) {
        shown += 1;
        const pos = [...perPo.entries()].map(([p, q]) => `${p}x${q}`).join(', ') || '-';
        log(`${l.category.padEnd(18)} ${l.item_code.padEnd(18)} sys=${l.system_qty ?? '-'} lots=${lotQty} | ${pos}${noPoQty ? ` | noPO=${noPoQty} (${[...kinds].join('/')})` : ''} | ${l.variant_label ?? l.vk}`);
      }
    }
    log('');
    log(`lines=${lines.length} open_lots=${lots.length} lines_with_2+_POs=${multiPo} batch_no!=grn_po lots=${batchVsGrnDiffer}`);
    for (const [cat, c] of census) log(`census ${cat}: ${JSON.stringify(c)}`);
    // Company-wide census for sofa / bedframe lots: how often is the PO known?
    const wide = await t`
      SELECT coalesce(p.category::text, '?') AS category,
             count(*) AS lots,
             count(*) FILTER (WHERE lo.batch_no IS NOT NULL) AS with_batch,
             count(*) FILTER (WHERE lo.batch_no IS NULL AND g.purchase_order_id IS NOT NULL) AS grn_only,
             count(*) FILTER (WHERE lo.batch_no IS NULL AND g.purchase_order_id IS NULL) AS no_po
        FROM scm.inventory_lots lo
        LEFT JOIN scm.mfg_products p ON p.code = lo.item_code AND p.company_id = lo.company_id
        LEFT JOIN scm.grns g ON upper(coalesce(lo.source_doc_type, '')) = 'GRN' AND g.id::text = lo.source_doc_id::text
       WHERE lo.company_id = ${take.company_id} AND lo.qty_remaining > 0
       GROUP BY 1 ORDER BY 2 DESC`;
    for (const w of wide) log(`open lots company-wide ${w.category}: lots=${w.lots} batch=${w.with_batch} grn_only=${w.grn_only} no_po=${w.no_po}`);
    const noPoSrc = await t`
      SELECT coalesce(p.category::text, '?') AS category, coalesce(lo.source_doc_type, 'null') AS src, count(*) AS n, sum(lo.qty_remaining) AS qty
        FROM scm.inventory_lots lo
        LEFT JOIN scm.mfg_products p ON p.code = lo.item_code AND p.company_id = lo.company_id
        LEFT JOIN scm.grns g ON upper(coalesce(lo.source_doc_type, '')) = 'GRN' AND g.id::text = lo.source_doc_id::text
       WHERE lo.company_id = ${take.company_id} AND lo.qty_remaining > 0 AND lo.batch_no IS NULL AND g.purchase_order_id IS NULL
       GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 20`;
    for (const r of noPoSrc) log(`no-PO open lots ${r.category} src=${r.src}: lots=${r.n} qty=${r.qty}`);
  });
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => sql.end());
