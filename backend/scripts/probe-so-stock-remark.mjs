#!/usr/bin/env node
/* What the SO list's "Stock Status" column actually reads. Read-only.
 *
 * The column (MfgSalesOrdersListV2.tsx:1672-1682, ConsignmentOrders.tsx:1294)
 * binds to `stock_remark`, which is NOT a stored column — it is computed per
 * request in routes/mfg-sales-orders.ts:1651-1662 by summariseReadiness()
 * (lib/so-readiness.ts) over the SO's stored per-line stock_status.
 *
 * Three things to establish against production:
 *   A. scm.mfg_sales_orders carries NO stock-ish column (so nothing stale can
 *      be stored on the header).
 *   B. For ONE named order: every line's item_group + stock_status, plus the
 *      remark summariseReadiness would emit, plus the on-hand / open-PO
 *      evidence that decides what the DRILL-DOWN shows for the same lines.
 *   C. Fleet counts per company: how many live orders currently carry a
 *      bare-category remark ("BEDFRAME", "MATTRESS/ACC", …) rather than
 *      READY / READY (PARTIAL) / blank, and how many live orders are held
 *      PENDING by the proceeded_at allocation gate
 *      (so-stock-allocation.ts:146-150).
 *
 * DEBTOR="James Pak" COMPANY=2 node scripts/probe-so-stock-remark.mjs
 */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY || 2);
const DEBTOR = (process.env.DEBTOR || 'James Pak').trim();
const TOTAL_SEN = process.env.TOTAL_SEN ? Number(process.env.TOTAL_SEN) : null;

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

/* ---- verbatim port of lib/so-readiness.ts (do not "improve") -------------- */
const MAIN_CATEGORIES = new Set(['SOFA', 'BEDFRAME', 'MATTRESS']);
function normCategory(raw) {
  const g = (raw ?? '').trim().toUpperCase();
  if (g.includes('BEDFRAME')) return 'BEDFRAME';
  if (g.includes('SOFA')) return 'SOFA';
  if (g.includes('MATTRESS')) return 'MATTRESS';
  if (g.includes('ACCESSOR')) return 'ACCESSORY';
  if (g.includes('SERVICE')) return 'SERVICE';
  return 'OTHERS';
}
/* shared/isServiceLine: SERVICE group or SVC- code. */
function isServiceLine(itemGroup, itemCode) {
  const g = (itemGroup ?? '').trim().toUpperCase();
  const c = (itemCode ?? '').trim().toUpperCase();
  return g.includes('SERVICE') || c.startsWith('SVC-');
}
function summariseReadiness(lines) {
  const live = lines.filter((l) => !l.cancelled);
  let mainCount = 0, mainReady = 0, accCount = 0, accReady = 0;
  const mainByCat = new Map();
  const pendingMainCats = new Set();
  let anyAccPending = false;
  for (const l of live) {
    if (isServiceLine(l.item_group, l.item_code)) continue;
    const cat = normCategory(l.item_group);
    const isMain = MAIN_CATEGORIES.has(cat);
    const isReady = l.stock_status === 'READY';
    if (isMain) {
      mainCount += 1;
      const cell = mainByCat.get(cat) ?? { total: 0, ready: 0 };
      cell.total += 1;
      if (isReady) { mainReady += 1; cell.ready += 1; } else pendingMainCats.add(cat);
      mainByCat.set(cat, cell);
    } else {
      accCount += 1;
      if (isReady) accReady += 1; else anyAccPending = true;
    }
  }
  const isMainReady = mainCount > 0 ? mainReady === mainCount : true;
  const isFullyReady = (mainCount + accCount) > 0 && mainReady === mainCount && accReady === accCount;
  let stockRemark = '';
  if (mainCount + accCount === 0) stockRemark = '';
  else if (isFullyReady) stockRemark = 'READY';
  else if (isMainReady) stockRemark = 'READY (PARTIAL)';
  else {
    const readyCats = [];
    for (const cat of ['BEDFRAME', 'SOFA', 'MATTRESS']) {
      const cell = mainByCat.get(cat);
      if (cell && cell.total > 0 && cell.ready === cell.total) readyCats.push(cat);
    }
    if (accCount > 0 && accReady === accCount) readyCats.push('ACC');
    stockRemark = readyCats.join('/');
  }
  const pc = [...pendingMainCats].sort();
  if (anyAccPending) pc.push('ACC');
  return { mainCount, mainReady, accCount, accReady, isMainReady, isFullyReady, stockRemark, pendingCategories: pc };
}
/* -------------------------------------------------------------------------- */

/* shared/so-terminal-states.ts verbatim — the set the allocator excludes. */
const TERMINAL = ['CANCELLED', 'CLOSED', 'SHIPPED', 'DELIVERED', 'INVOICED', 'DRAFT'];

async function main() {
  note(`\n${'='.repeat(78)}\nA. Does scm.mfg_sales_orders store ANY stock-ish column?`);
  const cols = await sql`
    SELECT column_name, data_type
      FROM information_schema.columns
     WHERE table_schema = 'scm' AND table_name = 'mfg_sales_orders'
       AND (column_name ILIKE '%stock%' OR column_name ILIKE '%remark%'
            OR column_name ILIKE '%ready%' OR column_name ILIKE '%proceed%')
     ORDER BY column_name`;
  note(`  matching columns: ${cols.length}`);
  for (const c of cols) note(`    ${c.column_name.padEnd(30)} ${c.data_type}`);

  const itemCols = await sql`
    SELECT column_name, data_type
      FROM information_schema.columns
     WHERE table_schema = 'scm' AND table_name = 'mfg_sales_order_items'
       AND (column_name ILIKE '%stock%' OR column_name ILIKE '%ready%' OR column_name ILIKE '%batch%')
     ORDER BY column_name`;
  note(`  mfg_sales_order_items stock-ish columns: ${itemCols.length}`);
  for (const c of itemCols) note(`    ${c.column_name.padEnd(30)} ${c.data_type}`);

  note(`\n${'='.repeat(78)}\nB. The named order — company ${CO}, debtor ILIKE '%${DEBTOR}%'`);
  const heads = await sql`
    SELECT doc_no, status, branding, debtor_name, local_total_sen, balance_sen,
           so_date::text AS so_date,
           processing_date::text AS processing_date,
           proceeded_at::text AS proceeded_at,
           customer_delivery_date::text AS customer_delivery_date,
           remark2, remark3, remark4, line_count,
           created_at::text AS created_at, updated_at::text AS updated_at
      FROM scm.mfg_sales_orders
     WHERE company_id = ${CO}::bigint
       AND debtor_name ILIKE ${'%' + DEBTOR + '%'}
       ${TOTAL_SEN == null ? sql`` : sql`AND local_total_sen = ${TOTAL_SEN}::bigint`}
     ORDER BY so_date DESC NULLS LAST, doc_no`;
  note(`  header matches: ${heads.length}`);

  for (const h of heads) {
    note(`\n  ${'-'.repeat(72)}`);
    note(`  ${h.doc_no}  status=${h.status}  branding=${h.branding ?? '(null)'}`);
    note(`    total_sen=${h.local_total_sen}  (= RM ${(Number(h.local_total_sen) / 100).toFixed(2)})  balance_sen=${h.balance_sen}`);
    note(`    so_date=${h.so_date}  processing_date=${h.processing_date ?? '(null)'}  proceeded_at=${h.proceeded_at ?? '(NULL → ALLOC-GATED)'}`);
    note(`    customer_delivery_date=${h.customer_delivery_date ?? '(null)'}  line_count=${h.line_count}`);
    note(`    remark2=${JSON.stringify(h.remark2)}  remark3=${JSON.stringify(h.remark3)}  remark4=${JSON.stringify(h.remark4)}`);
    note(`    updated_at=${h.updated_at}`);

    const lines = await sql`
      SELECT id::text AS id, line_no, item_code, item_group, description, qty,
             stock_status, stock_qty_ready, cancelled,
             warehouse_id::text AS warehouse_id,
             allocated_batch_no,
             variants::text AS variants,
             created_at::text AS created_at
        FROM scm.mfg_sales_order_items
       WHERE company_id = ${CO}::bigint AND doc_no = ${h.doc_no}
       ORDER BY line_no NULLS LAST, created_at`;
    note(`\n    --- lines: ${lines.length} ---`);
    for (const l of lines) {
      note(`    #${String(l.line_no ?? '?').padStart(2)} ${String(l.item_code).padEnd(22)} group=${String(l.item_group ?? '(null)').padEnd(12)} qty=${String(l.qty).padStart(3)} stock_status=${String(l.stock_status ?? '(null)').padEnd(8)} qty_ready=${l.stock_qty_ready ?? '-'} cancelled=${l.cancelled} batch=${l.allocated_batch_no ?? '-'}`);
      note(`        norm_cat=${normCategory(l.item_group)}  service=${isServiceLine(l.item_group, l.item_code)}  wh=${(l.warehouse_id ?? 'NULL').slice(0, 8)}  desc=${String(l.description ?? '').slice(0, 48)}`);
      note(`        variants=${l.variants}`);
    }

    /* What the LIST column computes — the list feeds only cancelled=false rows
       (mfg-sales-orders.ts:1474-1483), so mirror that. */
    const live = lines.filter((l) => l.cancelled === false);
    const r = summariseReadiness(live.map((l) => ({
      item_group: l.item_group, item_code: l.item_code,
      stock_status: l.stock_status, cancelled: false,
    })));
    note(`\n    >>> summariseReadiness over ${live.length} live line(s):`);
    note(`        stockRemark        = ${JSON.stringify(r.stockRemark)}   <-- THIS is the "Stock Status" cell`);
    note(`        main ${r.mainReady}/${r.mainCount}   acc ${r.accReady}/${r.accCount}   isMainReady=${r.isMainReady}  isFullyReady=${r.isFullyReady}`);
    note(`        pendingCategories  = ${JSON.stringify(r.pendingCategories)}`);

    /* Why the DRILL-DOWN may still say READY for a stored-PENDING line: the
       pill is `stock_state === 'stock' || stock_status === 'READY'`
       (SoSourceChips.tsx:57) and stock_state comes from live MRP coverage.
       Print the raw coverage evidence per non-READY line. */
    const pending = live.filter((l) => l.stock_status !== 'READY' && !isServiceLine(l.item_group, l.item_code));
    note(`\n    --- live coverage evidence for the ${pending.length} stored-not-READY line(s) ---`);
    for (const l of pending) {
      note(`\n      line #${l.line_no} ${l.item_code} (wh=${(l.warehouse_id ?? 'NULL').slice(0, 8)})`);
      const bal = await sql`
        SELECT b.warehouse_id::text AS warehouse_id, w.name AS warehouse,
               coalesce(b.variant_key,'') AS variant_key, b.qty
          FROM scm.inventory_balances b
          LEFT JOIN scm.warehouses w ON w.id = b.warehouse_id
         WHERE b.company_id = ${CO}::bigint AND b.product_code = ${l.item_code} AND b.qty <> 0
         ORDER BY w.name, b.variant_key`;
      note(`        on-hand rows for ${l.item_code}: ${bal.length}`);
      for (const b of bal) {
        const same = b.warehouse_id === l.warehouse_id ? ' <-- SAME WAREHOUSE AS THE LINE' : '';
        note(`          ${String(b.warehouse ?? '?').padEnd(26)} qty=${String(b.qty).padStart(4)}  key=${JSON.stringify(b.variant_key)}${same}`);
      }
      const po = await sql`
        SELECT p.po_number, p.status, i.qty, coalesce(i.received_qty,0) AS received_qty,
               i.warehouse_id::text AS warehouse_id, i.so_item_id::text AS so_item_id,
               coalesce(i.delivery_date::text, p.expected_at::text, '') AS eta
          FROM scm.purchase_order_items i
          JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
         WHERE i.company_id = ${CO}::bigint AND i.material_code = ${l.item_code}
           AND upper(p.status::text) NOT IN ('CANCELLED','CLOSED','DRAFT')
         ORDER BY p.po_number`;
      note(`        open PO lines for ${l.item_code}: ${po.length}`);
      for (const q of po) {
        note(`          ${q.po_number}  ${String(q.status).padEnd(12)} qty=${q.qty} recv=${q.received_qty} eta=${q.eta || '-'} so_item=${q.so_item_id ? q.so_item_id.slice(0, 8) : '(unbound)'}`);
      }

      /* WHO ELSE WANTS THIS UNIT. Both the allocator and MRP walk demand in
         delivery-date then doc_no order, so an earlier-dated live line takes
         the on-hand unit first and this line is CORRECTLY pending. */
      const rivals = await sql`
        SELECT i.doc_no, s.status, i.qty, i.stock_status,
               i.warehouse_id::text AS warehouse_id,
               coalesce(i.line_delivery_date::text, s.customer_delivery_date::text) AS eff_date
          FROM scm.mfg_sales_order_items i
          JOIN scm.mfg_sales_orders s
            ON s.doc_no = i.doc_no AND s.company_id = i.company_id
         WHERE i.company_id = ${CO}::bigint AND i.item_code = ${l.item_code}
           AND i.cancelled = false
           AND upper(s.status::text) NOT IN ${sql(TERMINAL)}
         ORDER BY eff_date NULLS LAST, i.doc_no`;
      note(`        competing LIVE demand for ${l.item_code}: ${rivals.length} line(s) (allocation order)`);
      for (const q of rivals) {
        const mine = q.doc_no === h.doc_no ? '  <-- THIS ORDER' : '';
        note(`          ${String(q.eff_date ?? '(no date)').padEnd(12)} ${String(q.doc_no).padEnd(22)} qty=${q.qty} stored=${String(q.stock_status).padEnd(8)} status=${q.status} wh=${(q.warehouse_id ?? 'NULL').slice(0, 8)}${mine}`);
      }

      /* WHEN did the unit land, vs when this line was last projected. If the
         movement predates the last allocation trigger the stored PENDING is
         stale, not correct. */
      const mv = await sql`
        SELECT movement_type::text AS movement_type, qty, coalesce(variant_key,'') AS variant_key,
               source_doc_type, source_doc_no, created_at::text AS created_at
          FROM scm.inventory_movements
         WHERE company_id = ${CO}::bigint AND product_code = ${l.item_code}
         ORDER BY created_at DESC
         LIMIT 10`;
      note(`        last ${mv.length} inventory movement(s) for ${l.item_code}:`);
      for (const q of mv) {
        note(`          ${q.created_at}  ${String(q.movement_type).padEnd(4)} qty=${String(q.qty).padStart(4)} key=${JSON.stringify(q.variant_key)} src=${q.source_doc_type ?? '-'} ${q.source_doc_no ?? ''}`);
      }
    }

    /* Any inventory lot whose batch_no is one of the order's POs — the chips
       the drill renders come from these. */
    const codes = [...new Set(live.map((x) => x.item_code).filter(Boolean))];
    const lots = codes.length === 0 ? [] : await sql`
      SELECT l.batch_no, l.product_code, coalesce(l.variant_key,'') AS variant_key,
             l.qty_remaining, l.source_doc_type, w.name AS warehouse,
             l.received_at::text AS received_at
        FROM scm.inventory_lots l
        LEFT JOIN scm.warehouses w ON w.id = l.warehouse_id
       WHERE l.company_id = ${CO}::bigint
         AND l.qty_remaining > 0
         AND l.product_code IN ${sql(codes)}
       ORDER BY l.product_code, l.received_at`;
    note(`\n    --- open inventory lots for this order's codes: ${lots.length} ---`);
    for (const t of lots) {
      note(`      ${String(t.product_code).padEnd(22)} batch=${String(t.batch_no ?? '(null)').padEnd(20)} left=${String(t.qty_remaining).padStart(4)} src=${t.source_doc_type ?? '-'} wh=${t.warehouse ?? '?'} recv=${t.received_at ?? '-'}`);
    }
  }

  note(`\n${'='.repeat(78)}\nC. Fleet counts — how many LIVE orders show which remark, per company`);
  for (const co of [1, 2]) {
    const rows = await sql`
      SELECT s.doc_no, s.status, s.proceeded_at IS NULL AS alloc_gated,
             s.processing_date IS NOT NULL AS has_processing_date,
             i.item_group, i.item_code, i.stock_status
        FROM scm.mfg_sales_orders s
        JOIN scm.mfg_sales_order_items i
          ON i.doc_no = s.doc_no AND i.company_id = s.company_id AND i.cancelled = false
       WHERE s.company_id = ${co}::bigint
         AND upper(s.status::text) NOT IN ${sql(TERMINAL)}`;
    const byDoc = new Map();
    for (const r of rows) {
      const cur = byDoc.get(r.doc_no) ?? { lines: [], gated: r.alloc_gated, hasPd: r.has_processing_date, status: r.status };
      cur.lines.push({ item_group: r.item_group, item_code: r.item_code, stock_status: r.stock_status, cancelled: false });
      byDoc.set(r.doc_no, cur);
    }
    const buckets = new Map();
    let gatedWithPd = 0, gatedTotal = 0;
    const barecat = [];
    for (const [docNo, v] of byDoc) {
      const rr = summariseReadiness(v.lines);
      const label = rr.stockRemark === '' ? '(blank)' : rr.stockRemark;
      buckets.set(label, (buckets.get(label) ?? 0) + 1);
      if (v.gated) { gatedTotal += 1; if (v.hasPd) gatedWithPd += 1; }
      if (rr.stockRemark && rr.stockRemark !== 'READY' && rr.stockRemark !== 'READY (PARTIAL)') {
        barecat.push({ docNo, remark: rr.stockRemark, status: v.status, gated: v.gated, pending: rr.pendingCategories.join('/') });
      }
    }
    note(`\n  company ${co}: ${byDoc.size} live order(s) with at least one live line`);
    for (const [label, n] of [...buckets].sort((a, b) => b[1] - a[1])) {
      note(`    ${String(n).padStart(5)}  ${label}`);
    }
    note(`    alloc-gated (proceeded_at IS NULL): ${gatedTotal}   of which processing_date IS set: ${gatedWithPd}`);
    note(`    bare-category remarks (the "BEDFRAME"-style cells on screen): ${barecat.length}`);
    for (const b of barecat.slice(0, 40)) {
      note(`      ${String(b.docNo).padEnd(22)} shows="${b.remark}"  pending="${b.pending}"  status=${b.status}  gated=${b.gated}`);
    }
    if (barecat.length > 40) note(`      … ${barecat.length - 40} more`);
  }

  note(`\n${'='.repeat(78)}\nD. Is the allocation projection itself healthy?`);
  try {
    const lock = await sql`SELECT * FROM scm.stock_allocation_recompute_lock`;
    for (const r of lock) note(`  lock: ${JSON.stringify(r)}`);
  } catch (e) { note(`  lock read failed: ${e.message}`); }
  try {
    const q = await sql`SELECT * FROM scm.stock_allocation_recompute_queue`;
    note(`  queue rows: ${q.length}`);
    for (const r of q) note(`    ${JSON.stringify(r)}`);
  } catch (e) { note(`  queue read failed: ${e.message}`); }

  await sql.end({ timeout: 5 });
}

main().catch(async (e) => { console.error(e); try { await sql.end({ timeout: 5 }); } catch { /* closed */ } process.exit(1); });
