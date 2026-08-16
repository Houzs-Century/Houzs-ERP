#!/usr/bin/env node
/* REFUTATION probe for the "Stock Status column shows BEDFRAME" answer.
 * Read-only. Independent re-derivation, plus the three gaps the prior probe
 * (backend/scripts/probe-so-stock-remark.mjs) explicitly left unproven:
 *
 *   1. IDENTITY — is the order really debtor "James Pak"? Print the name.
 *   2. CROSS-COMPANY contention — the allocator reads inventory_balances with
 *      NO company filter (so-stock-allocation.ts:401-405) and walks needs from
 *      BOTH companies in one pass. The prior probe scoped on-hand and competing
 *      demand to company 2 only. Redo it unscoped.
 *   3. DENOMINATOR — of every live order whose computed remark is a bare
 *      category ("BEDFRAME", "MATTRESS/ACC", ...), how many are STALE (their
 *      pending MAIN lines are already covered by uncontended on-hand) versus
 *      genuinely part-ready? The prior probe counted the cells but never split
 *      them, then reported "1 in 2990 / 164 in HOUZS" as if the 2990 one were
 *      special.
 *
 * Also: does the projection's own bucket agree with what the allocator would
 * do, for the named order specifically.
 *
 * DEBTOR="James Pak" COMPANY=2 node scripts/probe-remark-staleness.mjs
 */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY || 2);
const DEBTOR = (process.env.DEBTOR || 'James Pak').trim();

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

/* ---- verbatim ports (do not "improve") ----------------------------------- */
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

/* shared/variant-key.ts verbatim */
const ATTRS_BY_GROUP = {
  sofa: ['fabricCode', 'seatHeight', 'legHeight'],
  bedframe: ['fabricCode', 'gap', 'divanHeight', 'legHeight', 'totalHeight'],
  mattress: [], accessory: [], others: [], service: [],
};
const norm = (v) => (v == null ? '' : String(v).trim().toLowerCase());
const normSpecials = (specials) => {
  if (!Array.isArray(specials) || specials.length === 0) return '';
  return specials.map((s) => (typeof s === 'string' ? s : (s?.code ?? s?.label ?? '')))
    .map(norm).filter(Boolean).sort().join(',');
};
function computeVariantKey(itemGroup, attrs) {
  const group = norm(itemGroup);
  const a = attrs ?? {};
  const parts = [];
  for (const k of ATTRS_BY_GROUP[group] ?? []) {
    const raw = k === 'fabricCode' ? (a.fabricCode ?? a.colorCode ?? a.colourCode ?? a.fabricColor)
      : k === 'seatHeight' ? (a.seatHeight ?? a.depth)
      : k === 'legHeight' ? (a.legHeight ?? a.sofaLegHeight)
      : a[k];
    const val = norm(raw);
    if (val) parts.push(`${k.toLowerCase()}=${val}`);
  }
  const sp = normSpecials(a.specials);
  if (sp) parts.push(`special=${sp}`);
  return parts.join('|');
}
const WH_NONE = 'NOWH';
const BOUND_GROUPS = new Set(['bedframe', 'sofa']);
const TERMINAL = ['CANCELLED', 'CLOSED', 'SHIPPED', 'DELIVERED', 'INVOICED', 'DRAFT'];
/* -------------------------------------------------------------------------- */

async function main() {
  note(`\n${'='.repeat(78)}\n1. IDENTITY — does an order matching the screenshot exist, and is it "James Pak"?`);
  const heads = await sql`
    SELECT doc_no, company_id, status::text AS status, branding, debtor_name,
           local_total_centi, so_date::text AS so_date,
           processing_date::text AS processing_date,
           proceeded_at::text AS proceeded_at,
           updated_at::text AS updated_at, line_count
      FROM scm.mfg_sales_orders
     WHERE company_id = ${CO}::bigint
       AND debtor_name ILIKE ${'%' + DEBTOR + '%'}
     ORDER BY so_date DESC NULLS LAST, doc_no`;
  note(`  orders in company ${CO} with debtor_name ILIKE '%${DEBTOR}%': ${heads.length}`);
  for (const h of heads) {
    note(`    ${h.doc_no}  debtor_name=${JSON.stringify(h.debtor_name)}  status=${h.status}  branding=${JSON.stringify(h.branding)}`);
    note(`        RM ${(Number(h.local_total_centi) / 100).toFixed(2)}  so_date=${h.so_date}  processing_date=${h.processing_date ?? '(null)'}`);
    note(`        proceeded_at=${h.proceeded_at ?? '(NULL → ALLOC-GATED)'}  updated_at=${h.updated_at}  line_count=${h.line_count}`);
  }
  /* Also: is RM 3,220.00 unique in company 2? A same-total decoy would mean the
     prior probe may have identified the wrong document. */
  const sameTotal = await sql`
    SELECT doc_no, debtor_name, status::text AS status
      FROM scm.mfg_sales_orders
     WHERE company_id = ${CO}::bigint AND local_total_centi = ${322000}::bigint
     ORDER BY doc_no`;
  note(`  company ${CO} orders with local_total_centi = 322000 (RM 3,220.00): ${sameTotal.length}`);
  for (const s of sameTotal) note(`    ${s.doc_no}  ${JSON.stringify(s.debtor_name)}  ${s.status}`);

  const target = heads[0];
  if (!target) { note('  NO MATCH — cannot continue section 2.'); }

  if (target) {
    note(`\n${'='.repeat(78)}\n2. The named order's lines, and the CROSS-COMPANY contention for its codes`);
    /* line updated_at is THE decisive field. If a mattress line was written
       AFTER the 2026-08-15 mattress GRN and is still PENDING, the allocator
       ran and deliberately left it PENDING — that is NOT staleness and the
       cause is elsewhere. If it was last written before the GRN, the
       projection never saw the new stock. */
    const lines = await sql`
      SELECT id::text AS id, line_no, item_code, item_group, qty,
             stock_status, stock_qty_ready, cancelled,
             warehouse_id::text AS warehouse_id, allocated_batch_no,
             variants::text AS variants,
             created_at::text AS created_at
        FROM scm.mfg_sales_order_items
       WHERE company_id = ${CO}::bigint AND doc_no = ${target.doc_no}
       ORDER BY line_no NULLS LAST, created_at`;
    const live = lines.filter((l) => l.cancelled === false);
    for (const l of live) {
      const vk = computeVariantKey(l.item_group, l.variants ? JSON.parse(l.variants) : null);
      note(`    #${String(l.line_no ?? '?').padStart(2)} ${String(l.item_code).padEnd(24)} group=${String(l.item_group ?? '-').padEnd(10)} qty=${l.qty} stored=${String(l.stock_status).padEnd(8)} ready=${l.stock_qty_ready ?? '-'} batch=${l.allocated_batch_no ?? '-'}`);
      note(`        wh=${(l.warehouse_id ?? 'NULL').slice(0, 8)}  variant_key=${JSON.stringify(vk)}  bucket=${(l.warehouse_id ?? WH_NONE)}::${l.item_code}::${vk}`);
      note(`        line created_at=${l.created_at}   (mfg_sales_order_items has NO updated_at column)`);
    }
    /* No per-line updated_at exists, so the audit log is the only record of
       WHEN a stock_status last moved. If it holds nothing for these lines,
       staleness cannot be dated from the database at all. */
    try {
      const au = await sql`
        SELECT id::text AS id, action, field, old_value, new_value,
               actor_email, created_at::text AS created_at
          FROM scm.mfg_so_audit_log
         WHERE doc_no = ${target.doc_no}
         ORDER BY created_at DESC
         LIMIT 40`;
      note(`\n    --- mfg_so_audit_log rows for ${target.doc_no}: ${au.length} ---`);
      for (const a of au) note(`      ${a.created_at}  ${a.action ?? '-'} ${a.field ?? '-'}  ${JSON.stringify(a.old_value)} -> ${JSON.stringify(a.new_value)}  by ${a.actor_email ?? '-'}`);
    } catch (e) {
      note(`    (audit log unavailable: ${e.message})`);
      const cols = await sql`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema='scm' AND table_name='mfg_so_audit_log' ORDER BY ordinal_position`;
      note(`    mfg_so_audit_log columns: ${cols.map((c) => c.column_name).join(', ')}`);
    }
    /* Every stock movement for this order's codes, so the line updated_at can
       be read against the moment the goods actually landed. */
    const codesAll = [...new Set(live.map((x) => x.item_code).filter(Boolean))];
    if (codesAll.length) {
      const mv = await sql`
        SELECT product_code, movement_type, qty, coalesce(variant_key,'') AS variant_key,
               source_doc_type, source_doc_no, warehouse_id::text AS warehouse_id,
               created_at::text AS created_at
          FROM scm.inventory_movements
         WHERE product_code IN ${sql(codesAll)}
         ORDER BY created_at DESC
         LIMIT 40`;
      note(`\n    --- last ${mv.length} stock movement(s) for this order's codes (ALL companies) ---`);
      for (const m of mv) {
        note(`      ${m.created_at}  ${String(m.movement_type).padEnd(4)} ${String(m.product_code).padEnd(24)} qty=${String(m.qty).padStart(4)} key=${JSON.stringify(m.variant_key)} src=${m.source_doc_type ?? '-'} ${m.source_doc_no ?? ''}`);
      }
    }
    const r = summariseReadiness(live.map((l) => ({ item_group: l.item_group, item_code: l.item_code, stock_status: l.stock_status, cancelled: false })));
    note(`    >>> computed stockRemark = ${JSON.stringify(r.stockRemark)}   pendingCategories=${JSON.stringify(r.pendingCategories)}`);

    const notReady = live.filter((l) => l.stock_status !== 'READY' && !isServiceLine(l.item_group, l.item_code));
    for (const l of notReady) {
      note(`\n    --- ${l.item_code}: on-hand ACROSS ALL COMPANIES (allocator reads unscoped) ---`);
      const bal = await sql`
        SELECT b.company_id, b.warehouse_id::text AS warehouse_id, w.name AS warehouse,
               coalesce(b.variant_key,'') AS variant_key, b.qty
          FROM scm.inventory_balances b
          LEFT JOIN scm.warehouses w ON w.id = b.warehouse_id
         WHERE b.product_code = ${l.item_code} AND b.qty <> 0
         ORDER BY b.company_id, w.name`;
      for (const b of bal) {
        const same = b.warehouse_id === l.warehouse_id ? '  <-- LINE WAREHOUSE' : '';
        note(`        co=${b.company_id} ${String(b.warehouse ?? '?').padEnd(24)} qty=${String(b.qty).padStart(4)} key=${JSON.stringify(b.variant_key)}${same}`);
      }
      note(`    --- ${l.item_code}: EVERY live SO line demanding it, ALL companies ---`);
      const dem = await sql`
        SELECT i.company_id, i.doc_no, i.line_no, i.qty, i.stock_status,
               i.warehouse_id::text AS warehouse_id, i.item_group,
               i.variants::text AS variants,
               s.status::text AS so_status, s.proceeded_at IS NULL AS alloc_gated,
               s.so_date::text AS so_date, s.created_at::text AS so_created
          FROM scm.mfg_sales_order_items i
          JOIN scm.mfg_sales_orders s
            ON s.doc_no = i.doc_no AND s.company_id = i.company_id
         WHERE i.item_code = ${l.item_code}
           AND i.cancelled = false
           AND upper(s.status::text) NOT IN ${sql(TERMINAL)}
         ORDER BY i.company_id, i.doc_no`;
      note(`        competing live lines: ${dem.length}`);
      for (const d of dem) {
        const vk = computeVariantKey(d.item_group, d.variants ? JSON.parse(d.variants) : null);
        const mine = d.doc_no === target.doc_no ? '  <-- THIS ORDER' : '';
        note(`          co=${d.company_id} ${String(d.doc_no).padEnd(22)} #${d.line_no} qty=${d.qty} stored=${String(d.stock_status).padEnd(8)} gated=${d.alloc_gated} wh=${(d.warehouse_id ?? 'NULL').slice(0, 8)} key=${JSON.stringify(vk)}${mine}`);
      }
    }
  }

  note(`\n${'='.repeat(78)}\n3. DENOMINATOR — of the bare-category cells, how many are STALE?`);
  /* Pull every live line for both companies once. */
  const allRows = await sql`
    SELECT s.company_id, s.doc_no, s.status::text AS status,
           s.proceeded_at IS NULL AS alloc_gated,
           i.id::text AS id, i.line_no, i.item_code, i.item_group, i.qty,
           i.stock_status, i.warehouse_id::text AS warehouse_id,
           i.variants::text AS variants
      FROM scm.mfg_sales_orders s
      JOIN scm.mfg_sales_order_items i
        ON i.doc_no = s.doc_no AND i.company_id = s.company_id AND i.cancelled = false
     WHERE s.company_id IN (1, 2)
       AND upper(s.status::text) NOT IN ${sql(TERMINAL)}`;
  note(`  live SO lines pulled (co 1+2): ${allRows.length}`);

  const byDoc = new Map();
  for (const r of allRows) {
    const k = `${r.company_id}|${r.doc_no}`;
    const cur = byDoc.get(k) ?? { company_id: r.company_id, doc_no: r.doc_no, status: r.status, gated: r.alloc_gated, lines: [] };
    cur.lines.push(r);
    byDoc.set(k, cur);
  }

  /* Demand per bucket, counting ONLY non-gated orders (gated lines are forced
     PENDING at so-stock-allocation.ts:486-488 and never consume a bucket). */
  const demandByBucket = new Map();
  for (const v of byDoc.values()) {
    if (v.gated) continue;
    for (const l of v.lines) {
      if (isServiceLine(l.item_group, l.item_code)) continue;
      const vk = computeVariantKey(l.item_group, l.variants ? JSON.parse(l.variants) : null);
      const bucket = `${l.warehouse_id ?? WH_NONE}::${l.item_code}::${vk}`;
      demandByBucket.set(bucket, (demandByBucket.get(bucket) ?? 0) + Number(l.qty ?? 0));
    }
  }
  const codes = [...new Set(allRows.map((r) => r.item_code).filter(Boolean))];
  note(`  distinct item_codes on live lines: ${codes.length}; distinct buckets with demand: ${demandByBucket.size}`);

  const onHand = new Map();
  const CHUNK = 400;
  for (let i = 0; i < codes.length; i += CHUNK) {
    const batch = codes.slice(i, i + CHUNK);
    const bal = await sql`
      SELECT warehouse_id::text AS warehouse_id, product_code,
             coalesce(variant_key,'') AS variant_key, sum(qty) AS qty
        FROM scm.inventory_balances
       WHERE product_code IN ${sql(batch)}
       GROUP BY 1,2,3`;
    for (const b of bal) {
      const k = `${b.warehouse_id}::${b.product_code}::${b.variant_key}`;
      onHand.set(k, (onHand.get(k) ?? 0) + Number(b.qty ?? 0));
    }
  }
  note(`  buckets with any on-hand row: ${onHand.size}`);

  for (const co of [1, 2]) {
    const docs = [...byDoc.values()].filter((v) => v.company_id === co);
    let bare = 0, staleUncontended = 0, staleAnyStock = 0, genuinelyShort = 0;
    const bareList = [];
    for (const v of docs) {
      const rr = summariseReadiness(v.lines.map((l) => ({ item_group: l.item_group, item_code: l.item_code, stock_status: l.stock_status, cancelled: false })));
      if (!rr.stockRemark || rr.stockRemark === 'READY' || rr.stockRemark === 'READY (PARTIAL)') continue;
      bare += 1;
      /* The MAIN lines that are keeping this cell from saying READY. */
      const blockers = v.lines.filter((l) => !isServiceLine(l.item_group, l.item_code)
        && MAIN_CATEGORIES.has(normCategory(l.item_group))
        && l.stock_status !== 'READY');
      let allCoveredUncontended = true, allSomeStock = true;
      const detail = [];
      for (const l of blockers) {
        const vk = computeVariantKey(l.item_group, l.variants ? JSON.parse(l.variants) : null);
        const bucket = `${l.warehouse_id ?? WH_NONE}::${l.item_code}::${vk}`;
        const have = onHand.get(bucket) ?? 0;
        const want = demandByBucket.get(bucket) ?? 0;
        const need = Number(l.qty ?? 0);
        if (!(have >= want)) allCoveredUncontended = false;   // enough for EVERYONE in the bucket
        if (!(have >= need)) allSomeStock = false;            // enough for THIS line alone
        detail.push(`${l.item_code}[${normCategory(l.item_group)}] need=${need} have=${have} bucketDemand=${want}`);
      }
      const gatedNote = v.gated ? ' GATED' : '';
      if (blockers.length > 0 && allCoveredUncontended && !v.gated) staleUncontended += 1;
      else if (blockers.length > 0 && allSomeStock && !v.gated) staleAnyStock += 1;
      else genuinelyShort += 1;
      bareList.push({ doc: v.doc_no, remark: rr.stockRemark, gated: v.gated, allCoveredUncontended, allSomeStock, detail, gatedNote });
    }
    note(`\n  company ${co}: live orders=${docs.length}  bare-category cells=${bare}`);
    note(`    STALE (every blocking MAIN line's bucket has on-hand >= TOTAL live demand, order not gated): ${staleUncontended}`);
    note(`    stale-ish (on-hand >= this line's own need but bucket is contended): ${staleAnyStock}`);
    note(`    genuinely short / gated / no blockers: ${genuinelyShort}`);
    const show = bareList.filter((b) => b.allCoveredUncontended && !b.gated).slice(0, 25);
    note(`    -- first ${show.length} STALE order(s) --`);
    for (const b of show) note(`      ${String(b.doc).padEnd(24)} remark=${JSON.stringify(b.remark)}  ${b.detail.join(' ; ')}`);
    const shortShow = bareList.filter((b) => !b.allCoveredUncontended).slice(0, 10);
    note(`    -- first ${shortShow.length} NON-stale bare-category order(s) (for contrast) --`);
    for (const b of shortShow) note(`      ${String(b.doc).padEnd(24)} remark=${JSON.stringify(b.remark)}${b.gatedNote}  ${b.detail.join(' ; ')}`);
  }

  note(`\n${'='.repeat(78)}\n4. Is anything queued / running that would fix it?`);
  const q = await sql`SELECT job_key, state, attempts, deferrals, requested_at::text AS requested_at, next_attempt_at::text AS next_attempt_at, last_error FROM scm.stock_allocation_recompute_queue`;
  note(`  stock_allocation_recompute_queue rows: ${q.length}`);
  for (const x of q) note(`    ${JSON.stringify(x)}`);
  const lk = await sql`SELECT * FROM scm.stock_allocation_recompute_lock`;
  note(`  stock_allocation_recompute_lock: ${JSON.stringify(lk)}`);

  await sql.end();
}
main().catch(async (e) => { console.error(e); try { await sql.end(); } catch {} process.exit(1); });
