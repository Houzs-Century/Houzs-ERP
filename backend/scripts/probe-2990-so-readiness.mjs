#!/usr/bin/env node
/* What the SO list's "Stock Status" column and the header status ACTUALLY are,
   for one company, computed from the STORED per-line stock_status. Read-only.

   Two questions the owner asked from two screenshots of the 2990 SO list:

     (a) every MAIN line READY, one ACCESSORY line still PENDING — what is the
         header status? The code's rule is summariseReadiness.isShipReady
         (lib/so-readiness.ts:123) = "mainCount > 0 ? isMainReady :
         isFullyReady", so an accessory must NOT block READY_TO_SHIP. This
         prints every SO in that exact shape with its real header status.

     (b) an order whose expanded lines all read READY, whose Stock Status column
         says "BEDFRAME". That column renders `stock_remark` =
         summariseReadiness().stockRemark, which is derived ONLY from the stored
         stock_status. The drill's pill is soLineStockPill
         (frontend/src/components/SoSourceChips.tsx:57) — `stock_state ===
         'stock' || stock_status === 'READY'` — where stock_state is the LIVE
         MRP verdict. So the two can disagree. This prints, per line, the stored
         flag so the disagreement is visible as data.

   The readiness port below is a faithful transcription of summariseReadiness +
   normCategory (scm/lib/so-readiness.ts) and isServiceLine
   (scm/shared/service-sku.ts). It SELF-TESTS at startup and refuses to report
   from a broken port, per CLAUDE.md ("a checker that cannot match reports a
   clean run").

   COMPANY=2 [DEBTOR="james"] [DOCNO="2990-SO-..."] node scripts/probe-2990-so-readiness.mjs
   Read-only: SELECT only, no DDL, no writes, no transaction. */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY || 2);
const DEBTOR = (process.env.DEBTOR || '').trim();
const DOCNO = (process.env.DOCNO || '').trim();

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

/* ── port of scm/shared/service-sku.ts (the two signals so-readiness passes) ── */
const norm = (v) => (v ?? '').trim().toUpperCase();
const isServiceLine = (l) =>
  norm(l.item_group).includes('SERVICE') ||
  (norm(l.item_code).length > 4 && norm(l.item_code).startsWith('SVC-'));

/* ── port of scm/lib/so-readiness.ts normCategory + summariseReadiness ── */
const MAIN_CATEGORIES = new Set(['SOFA', 'BEDFRAME', 'MATTRESS']);
function normCategory(raw) {
  const g = norm(raw);
  if (g.includes('BEDFRAME')) return 'BEDFRAME';
  if (g.includes('SOFA')) return 'SOFA';
  if (g.includes('MATTRESS')) return 'MATTRESS';
  if (g.includes('ACCESSOR')) return 'ACCESSORY';
  if (g.includes('SERVICE')) return 'SERVICE';
  return 'OTHERS';
}
function summariseReadiness(lines) {
  const live = lines.filter((l) => !l.cancelled);
  let mainCount = 0, mainReady = 0, accCount = 0, accReady = 0;
  const mainByCat = new Map();
  const pendingMainCats = new Set();
  let anyAccPending = false;
  for (const l of live) {
    if (isServiceLine(l)) continue;
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
  const isShipReady = mainCount > 0 ? isMainReady : isFullyReady;
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
  return { mainCount, mainReady, accCount, accReady, isMainReady, isFullyReady, isShipReady, stockRemark, pendingCategories: pc };
}

/* ── self-test: a port that cannot classify must not report ── */
function selfTest() {
  const L = (g, s, c = false, code = null) => ({ item_group: g, item_code: code, stock_status: s, cancelled: c });
  const cases = [
    { name: 'all ready', lines: [L('MATTRESS', 'READY'), L('ACCESSORIES', 'READY')], remark: 'READY', ship: true },
    { name: 'main ready + acc pending', lines: [L('MATTRESS', 'READY'), L('ACCESSORIES', 'PENDING')], remark: 'READY (PARTIAL)', ship: true },
    { name: 'bedframe ready, mattress pending', lines: [L('BEDFRAME', 'READY'), L('MATTRESS', 'PENDING')], remark: 'BEDFRAME', ship: false },
    { name: 'no lines', lines: [], remark: '', ship: false },
    { name: 'service only', lines: [L('SERVICE', 'PENDING', false, 'SVC-DELIVERY')], remark: '', ship: false },
    { name: 'acc only, all ready', lines: [L('ACCESSORIES', 'READY')], remark: 'READY', ship: true },
    { name: 'main PARTIAL is not ready', lines: [L('MATTRESS', 'PARTIAL')], remark: '', ship: false },
  ];
  const bad = [];
  for (const c of cases) {
    const r = summariseReadiness(c.lines);
    if (r.stockRemark !== c.remark || r.isShipReady !== c.ship) {
      bad.push(`${c.name}: got remark=${JSON.stringify(r.stockRemark)} ship=${r.isShipReady}, want remark=${JSON.stringify(c.remark)} ship=${c.ship}`);
    }
  }
  return bad;
}

const pad = (s, n) => String(s ?? '').padEnd(n);

async function main() {
  const bad = selfTest();
  if (bad.length) {
    console.error('readiness port SELF-TEST FAILED — refusing to report:');
    for (const b of bad) console.error(`  ${b}`);
    process.exit(3);
  }
  note(`readiness port self-test: 7/7 OK. company_id=${CO}`);

  /* Every non-cancelled SO in this company that is still in the pipeline the
     auto-advance/regress arms govern, plus the two neighbours so a wrong answer
     is visible rather than filtered out. */
  const headers = await sql`
    SELECT doc_no, status, branding, debtor_name, local_total_sen,
           proceeded_at::text AS proceeded_at, processing_date::text AS processing_date,
           customer_delivery_date::text AS customer_delivery_date, so_date::text AS so_date
      FROM scm.mfg_sales_orders
     WHERE company_id = ${CO}::bigint
       AND upper(coalesce(status::text,'')) NOT IN ('CANCELLED','CLOSED','INVOICED')
     ORDER BY so_date DESC NULLS LAST, doc_no DESC`;
  note(`live-ish SO headers (status not CANCELLED/CLOSED/INVOICED): ${headers.length}`);

  const lines = await sql`
    SELECT i.doc_no, i.id::text AS id, i.item_code, i.item_group, i.qty,
           i.stock_status, i.cancelled
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no AND s.company_id = i.company_id
     WHERE i.company_id = ${CO}::bigint
       AND upper(coalesce(s.status::text,'')) NOT IN ('CANCELLED','CLOSED','INVOICED')
     ORDER BY i.doc_no, i.id`;
  note(`lines on those orders (incl. cancelled lines): ${lines.length}`);

  const byDoc = new Map();
  for (const l of lines) {
    const arr = byDoc.get(l.doc_no) ?? [];
    arr.push(l);
    byDoc.set(l.doc_no, arr);
  }

  /* ── 1. cross-tab: computed stock_remark × header status ────────────────── */
  const tab = new Map();
  const shapeA = [];   // main>0, all main READY, >=1 acc PENDING
  const catOnly = [];  // remark is a bare ready-category list (e.g. "BEDFRAME")
  const fullyReady = [];
  for (const h of headers) {
    const ls = byDoc.get(h.doc_no) ?? [];
    const r = summariseReadiness(ls);
    const key = `${r.stockRemark === '' ? '(blank)' : r.stockRemark} :: ${h.status}`;
    tab.set(key, (tab.get(key) ?? 0) + 1);
    if (r.mainCount > 0 && r.mainReady === r.mainCount && r.accCount > r.accReady) shapeA.push({ h, r, ls });
    if (r.stockRemark !== '' && r.stockRemark !== 'READY' && r.stockRemark !== 'READY (PARTIAL)') catOnly.push({ h, r, ls });
    if (r.stockRemark === 'READY') fullyReady.push({ h, r });
  }

  note(`\n${'='.repeat(78)}\n=== 1. computed stock_remark  ×  header status (company ${CO}) ===`);
  note(`${pad('stock_remark', 20)} ${pad('header status', 16)} count`);
  for (const [k, n] of [...tab].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const [remark, status] = k.split(' :: ');
    note(`${pad(remark, 20)} ${pad(status, 16)} ${n}`);
  }

  /* ── 2. QUESTION 1's exact shape ─────────────────────────────────────────── */
  note(`\n${'='.repeat(78)}\n=== 2. EVERY MAIN line READY + at least one ACCESSORY line still PENDING ===`);
  note(`matching orders: ${shapeA.length}`);
  const shapeAByStatus = new Map();
  for (const s of shapeA) shapeAByStatus.set(s.h.status, (shapeAByStatus.get(s.h.status) ?? 0) + 1);
  for (const [st, n] of [...shapeAByStatus].sort((a, b) => b[1] - a[1])) note(`  header status ${pad(st, 16)} ${n}`);
  for (const s of shapeA.slice(0, 40)) {
    note(`  ${pad(s.h.doc_no, 20)} ${pad(s.h.status, 16)} remark=${pad(s.r.stockRemark, 16)} main ${s.r.mainReady}/${s.r.mainCount} acc ${s.r.accReady}/${s.r.accCount} proceeded_at=${s.h.proceeded_at ?? 'NULL'} processing_date=${s.h.processing_date ?? 'NULL'} ${s.h.debtor_name ?? ''}`);
  }

  /* ── 3. remark is a bare category list — the "BEDFRAME" screenshot ──────── */
  note(`\n${'='.repeat(78)}\n=== 3. orders whose stock_remark is a READY-CATEGORY list (not READY / READY (PARTIAL)) ===`);
  note(`matching orders: ${catOnly.length}`);
  const catByRemark = new Map();
  for (const s of catOnly) {
    const k = `${s.r.stockRemark === '' ? '(blank)' : s.r.stockRemark} :: ${s.h.status}`;
    catByRemark.set(k, (catByRemark.get(k) ?? 0) + 1);
  }
  for (const [k, n] of [...catByRemark].sort((a, b) => b[1] - a[1])) {
    const [remark, status] = k.split(' :: ');
    note(`  remark=${pad(remark, 18)} status=${pad(status, 16)} ${n}`);
  }
  const bedframe = catOnly.filter((s) => s.r.stockRemark === 'BEDFRAME');
  note(`\n  --- remark exactly "BEDFRAME": ${bedframe.length} ---`);
  for (const s of bedframe.slice(0, 25)) {
    note(`  ${pad(s.h.doc_no, 20)} ${pad(s.h.status, 16)} branding=${pad(s.h.branding, 18)} RM ${(Number(s.h.local_total_sen ?? 0) / 100).toFixed(2)}  main ${s.r.mainReady}/${s.r.mainCount} acc ${s.r.accReady}/${s.r.accCount} proceeded_at=${s.h.proceeded_at ?? 'NULL'}  ${s.h.debtor_name ?? ''}`);
    for (const l of s.ls) {
      note(`        ${pad(l.item_code, 26)} group=${pad(l.item_group, 14)} qty=${pad(l.qty, 5)} stock_status=${pad(l.stock_status, 9)} cancelled=${l.cancelled} cat=${normCategory(l.item_group)}${isServiceLine(l) ? ' (SERVICE — skipped)' : ''}`);
    }
  }

  /* ── 4. named order drill (DEBTOR= substring, case-insensitive) ─────────── */
  if (DEBTOR) {
    note(`\n${'='.repeat(78)}\n=== 4. orders whose debtor_name matches ${JSON.stringify(DEBTOR)} ===`);
    const hits = headers.filter((h) => (h.debtor_name ?? '').toUpperCase().includes(DEBTOR.toUpperCase()));
    note(`matches: ${hits.length}`);
    for (const h of hits) {
      const ls = byDoc.get(h.doc_no) ?? [];
      const r = summariseReadiness(ls);
      note(`\n  ${h.doc_no}  status=${h.status}  branding=${h.branding}  RM ${(Number(h.local_total_sen ?? 0) / 100).toFixed(2)}  debtor=${h.debtor_name}`);
      note(`    so_date=${h.so_date} processing_date=${h.processing_date ?? 'NULL'} proceeded_at=${h.proceeded_at ?? 'NULL'} customer_delivery_date=${h.customer_delivery_date ?? 'NULL'}`);
      note(`    computed: stock_remark=${JSON.stringify(r.stockRemark)} isShipReady=${r.isShipReady} isMainReady=${r.isMainReady} isFullyReady=${r.isFullyReady} main ${r.mainReady}/${r.mainCount} acc ${r.accReady}/${r.accCount} pending=[${r.pendingCategories.join(',')}]`);
      for (const l of ls) {
        note(`      ${pad(l.item_code, 26)} group=${pad(l.item_group, 14)} qty=${pad(l.qty, 5)} stock_status=${pad(l.stock_status, 9)} cancelled=${l.cancelled} cat=${normCategory(l.item_group)}${isServiceLine(l) ? ' (SERVICE — skipped)' : ''}`);
      }
    }
  }

  /* ── 5. the two disagreement counts that matter ─────────────────────────── */
  note(`\n${'='.repeat(78)}\n=== 5. header status vs the ship gate the code implements ===`);
  let shipReadyButNotRts = 0, rtsButNotShipReady = 0;
  const shipReadyNotRtsRows = [], rtsNotShipReadyRows = [];
  for (const h of headers) {
    const st = String(h.status ?? '').toUpperCase();
    const r = summariseReadiness(byDoc.get(h.doc_no) ?? []);
    if (r.isShipReady && (st === 'CONFIRMED' || st === 'IN_PRODUCTION')) {
      shipReadyButNotRts += 1;
      shipReadyNotRtsRows.push({ h, r, st });
    }
    if (!r.isShipReady && st === 'READY_TO_SHIP') {
      rtsButNotShipReady += 1;
      rtsNotShipReadyRows.push({ h, r, st });
    }
  }
  note(`isShipReady but header still CONFIRMED/IN_PRODUCTION (auto-advance owes them): ${shipReadyButNotRts}`);
  for (const s of shipReadyNotRtsRows.slice(0, 25)) {
    note(`  ${pad(s.h.doc_no, 20)} ${pad(s.st, 16)} remark=${pad(s.r.stockRemark, 18)} main ${s.r.mainReady}/${s.r.mainCount} acc ${s.r.accReady}/${s.r.accCount} proceeded_at=${s.h.proceeded_at ?? 'NULL'}`);
  }
  note(`READY_TO_SHIP but NOT isShipReady (auto-regress owes them): ${rtsButNotShipReady}`);
  for (const s of rtsNotShipReadyRows.slice(0, 25)) {
    note(`  ${pad(s.h.doc_no, 20)} ${pad(s.st, 16)} remark=${pad(s.r.stockRemark, 18)} main ${s.r.mainReady}/${s.r.mainCount} acc ${s.r.accReady}/${s.r.accCount} proceeded_at=${s.h.proceeded_at ?? 'NULL'}`);
  }

  /* ── 6. does the LIST's company-blind line read change the answer? ───────
     GET /mfg-sales-orders reads the lines it derives stock_remark from with
     `.in('doc_no', docNos).eq('cancelled', false)` and NO company predicate
     (routes/mfg-sales-orders.ts:1490-1499). If a doc_no exists in both
     companies, the other company's lines fold into this SO's remark. Refutable:
     if no doc_no is shared, this prints 0 and the theory is dead. */
  note(`\n${'='.repeat(78)}\n=== 6. doc_no collisions across companies (the list's line read carries no company predicate) ===`);
  const collide = await sql`
    SELECT doc_no, count(DISTINCT company_id) AS companies,
           string_agg(DISTINCT company_id::text, ',' ORDER BY company_id::text) AS company_ids
      FROM scm.mfg_sales_orders
     GROUP BY doc_no
    HAVING count(DISTINCT company_id) > 1
     ORDER BY doc_no
     LIMIT 50`;
  note(`doc_no values held by more than one company: ${collide.length}${collide.length === 50 ? ' (capped at 50)' : ''}`);
  for (const r of collide) note(`  ${pad(r.doc_no, 24)} companies=${r.company_ids}`);

  const bleed = await sql`
    SELECT s.doc_no, count(*) AS foreign_lines
      FROM scm.mfg_sales_orders s
      JOIN scm.mfg_sales_order_items i
        ON i.doc_no = s.doc_no AND i.company_id <> s.company_id AND i.cancelled = false
     WHERE s.company_id = ${CO}::bigint
     GROUP BY s.doc_no
     ORDER BY count(*) DESC
     LIMIT 25`;
  note(`company-${CO} orders whose doc_no also carries lines stamped to ANOTHER company: ${bleed.length}`);
  for (const r of bleed) note(`  ${pad(r.doc_no, 24)} foreign live lines=${r.foreign_lines}`);

  /* ── 7. how the stored flags are distributed (is PARTIAL in play at all?) ── */
  note(`\n${'='.repeat(78)}\n=== 7. stored stock_status distribution on company-${CO} live lines ===`);
  const dist = new Map();
  for (const l of lines) {
    if (l.cancelled) continue;
    const k = `${l.stock_status ?? '(null)'} :: ${normCategory(l.item_group)}${isServiceLine(l) ? '/SERVICE' : ''}`;
    dist.set(k, (dist.get(k) ?? 0) + 1);
  }
  for (const [k, n] of [...dist].sort((a, b) => b[1] - a[1])) {
    const [st, cat] = k.split(' :: ');
    note(`  ${pad(st, 12)} ${pad(cat, 20)} ${n}`);
  }

  /* ── 8. why the DRILL can read READY on a stored-PENDING line ─────────────
     The drill's pill is `stock_state === 'stock' || stock_status === 'READY'`
     (frontend/src/components/SoSourceChips.tsx:57). For a non-sofa line
     stock_state is `cov?.source` — the LIVE MRP verdict
     (routes/mfg-sales-orders.ts:2861-2865) — so 'stock' (on-hand exists in the
     line's bucket) renders READY even though the stored flag says PENDING,
     while 'po' renders PENDING plus an incoming-PO chip. MRP's inputs are
     on-hand `inventory_balances` and open `purchase_order_items`; print both,
     per stored-not-READY line of DOCNO, so which of the two it is stops being a
     guess. This does NOT re-run computeMrp — it prints the raw supply MRP reads. */
  if (DOCNO) {
    note(`\n${'='.repeat(78)}\n=== 8. live supply behind ${DOCNO}'s stored-not-READY lines ===`);
    const dl = await sql`
      SELECT id::text AS id, line_no, item_code, item_group, qty, stock_status,
             stock_qty_ready, cancelled, warehouse_id::text AS warehouse_id,
             variants::text AS variants
        FROM scm.mfg_sales_order_items
       WHERE company_id = ${CO}::bigint AND doc_no = ${DOCNO}
       ORDER BY line_no NULLS LAST, created_at`;
    note(`lines on ${DOCNO}: ${dl.length}`);
    for (const l of dl) {
      if (l.cancelled || l.stock_status === 'READY' || isServiceLine(l)) continue;
      note(`\n  line #${l.line_no ?? '?'} ${l.item_code}  group=${l.item_group}  qty=${l.qty}  stored=${l.stock_status}  qty_ready=${l.stock_qty_ready ?? '-'}  wh=${(l.warehouse_id ?? 'NULL').slice(0, 8)}`);
      note(`    variants=${l.variants}`);
      const bal = await sql`
        SELECT b.warehouse_id::text AS warehouse_id, w.name AS warehouse,
               coalesce(b.variant_key,'') AS variant_key, b.qty
          FROM scm.inventory_balances b
          LEFT JOIN scm.warehouses w ON w.id = b.warehouse_id
         WHERE b.company_id = ${CO}::bigint AND b.product_code = ${l.item_code} AND b.qty <> 0
         ORDER BY w.name, b.variant_key`;
      note(`    on-hand rows: ${bal.length}${bal.length === 0 ? '  -> no stock anywhere, so MRP cannot answer "stock"' : ''}`);
      for (const b of bal) {
        note(`      ${pad(b.warehouse ?? '?', 26)} qty=${String(b.qty).padStart(4)} key=${JSON.stringify(b.variant_key)}${b.warehouse_id === l.warehouse_id ? '  <-- SAME WAREHOUSE AS THE LINE' : ''}`);
      }
      const po = await sql`
        SELECT p.po_number, p.status::text AS status, i.qty,
               coalesce(i.received_qty,0) AS received_qty,
               i.warehouse_id::text AS warehouse_id, i.so_item_id::text AS so_item_id
          FROM scm.purchase_order_items i
          JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
         WHERE i.company_id = ${CO}::bigint AND i.material_code = ${l.item_code}
           AND upper(p.status::text) NOT IN ('CANCELLED','CLOSED','DRAFT')
         ORDER BY p.po_number`;
      note(`    open PO lines: ${po.length}`);
      for (const r of po) {
        note(`      ${pad(r.po_number, 18)} ${pad(r.status, 12)} qty=${r.qty} received=${r.received_qty} wh=${(r.warehouse_id ?? '').slice(0, 8)} so_item=${r.so_item_id ? r.so_item_id.slice(0, 8) : '(unbound)'}`);
      }
    }
  }

  await sql.end({ timeout: 5 });
}

main().catch(async (e) => { console.error(e); try { await sql.end({ timeout: 5 }); } catch { /* closed */ } process.exit(1); });
