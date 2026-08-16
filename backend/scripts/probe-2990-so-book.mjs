#!/usr/bin/env node
/* The 2990 sales-order book, measured. Read-only — writes NOTHING.

   Two things the owner asked about the 2990 SO list are claims about a
   POPULATION, and a screenshot is not a population:

     (a) "every line READY except one accessory line — what should the header
          STATUS be?"   → how many orders are actually in that shape?
     (b) "the STOCK STATUS column says BEDFRAME while every expanded line reads
          READY"        → what drives that column, and how big is the set?

   So this prints, for company 2 and then company 1 as a control:

     1. header status census (all orders, and the LIVE lens the allocator uses)
     2. among live CONFIRMED orders: how many have EVERY considered line READY
     3. among live CONFIRMED orders: every MAIN line READY + >=1 ACCESSORY
        line not READY  (the owner's case (a))
     4. every column on scm.mfg_sales_orders / _items whose name mentions
        stock / status / ready / remark, with its values and counts
     5. the derived stock-remark distribution, cross-checked against
        "every line READY"  (the owner's case (b) population)
     6. the allocation gate: live orders with no processing date

   MAIN vs ACCESSORY is not invented here. It mirrors, line for line,
   backend/src/scm/lib/so-readiness.ts summariseReadiness() + normCategory()
   and backend/src/scm/shared/service-sku.ts isServiceLine():
     · SERVICE lines (item_group ~ SERVICE, or item_code SVC-*) are SKIPPED —
       they are not goods and never gate readiness
     · MAIN  = normCategory in {BEDFRAME, SOFA, MATTRESS}  (checked in that
       order, so 'BEDFRAME MATTRESS' normalises to BEDFRAME)
     · ACC   = everything else that survives (ACCESSORY + OTHERS)
     · ready = stock_status === 'READY' exactly ('PARTIAL' is NOT ready)
   The rollup is done in JS from per-(doc,category) counts so the branch order
   is provably the same as the TypeScript. summarise() below was diffed against
   the real summariseReadiness() over 20,000 randomised line-sets — 0 mismatches
   on mainCount/mainReady/accCount/accReady/isMainReady/isFullyReady/
   isShipReady/stockRemark. The SQL category expression mirrors the same pair of
   predicates (isServiceLine is checked FIRST, exactly as so-readiness.ts:85
   does, then normCategory's BEDFRAME-before-MATTRESS order).

   PUBLIC REPO — workflow logs are public. No customer names, no addresses, no
   free text is printed: free-text columns are reported as vocabulary buckets
   and counts only. Doc numbers and amounts-in-cents are printed.

   COMPANY=2,1 node scripts/probe-2990-so-book.mjs
   optional: DOC=SO-xxxx  or  AMOUNT=322000   (dump one order's lines) */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const COMPANIES = (process.env.COMPANY || '2,1').split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
const DOC = (process.env.DOC || '').trim();
const AMOUNT = (process.env.AMOUNT || '').trim();

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const n = (v) => Number(v ?? 0);
const pad = (v, w) => String(v).padStart(w);
const padR = (v, w) => String(v).padEnd(w);

/* The live lens — verbatim from backend/src/scm/shared/so-terminal-states.ts.
   DRAFT is terminal for allocation: it never creates demand. */
const TERMINAL = ['CANCELLED', 'CLOSED', 'SHIPPED', 'DELIVERED', 'INVOICED', 'DRAFT'];

/* Mirror of so-readiness.ts summariseReadiness(), fed per-category counts.
   catCounts: Map<cat, {total, ready}> over NON-SERVICE, non-cancelled lines. */
function summarise(catCounts) {
  const MAIN = ['BEDFRAME', 'SOFA', 'MATTRESS'];
  let mainCount = 0, mainReady = 0, accCount = 0, accReady = 0;
  for (const [cat, c] of catCounts) {
    if (MAIN.includes(cat)) { mainCount += c.total; mainReady += c.ready; }
    else { accCount += c.total; accReady += c.ready; }
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
    for (const cat of MAIN) {
      const cell = catCounts.get(cat);
      if (cell && cell.total > 0 && cell.ready === cell.total) readyCats.push(cat);
    }
    if (accCount > 0 && accReady === accCount) readyCats.push('ACC');
    stockRemark = readyCats.join('/');
  }
  return { mainCount, mainReady, accCount, accReady, isMainReady, isFullyReady, isShipReady, stockRemark };
}

/* normCategory + isServiceLine, expressed once as SQL so every query agrees. */
const CAT_SQL = `
  CASE
    WHEN upper(coalesce(i.item_group,'')) LIKE '%SERVICE%'
      OR (upper(trim(coalesce(i.item_code,''))) LIKE 'SVC-%' AND length(trim(coalesce(i.item_code,''))) > 4)
      THEN 'SERVICE'
    WHEN upper(coalesce(i.item_group,'')) LIKE '%BEDFRAME%' THEN 'BEDFRAME'
    WHEN upper(coalesce(i.item_group,'')) LIKE '%SOFA%'     THEN 'SOFA'
    WHEN upper(coalesce(i.item_group,'')) LIKE '%MATTRESS%' THEN 'MATTRESS'
    WHEN upper(coalesce(i.item_group,'')) LIKE '%ACCESSOR%' THEN 'ACCESSORY'
    ELSE 'OTHERS'
  END`;

/* Vocabulary the readiness code can emit — used to classify free-text column
   values WITHOUT printing them (public log). */
const VOCAB = new Set(['READY', 'READY (PARTIAL)', 'BEDFRAME', 'SOFA', 'MATTRESS', 'ACC',
  'BEDFRAME/SOFA', 'BEDFRAME/MATTRESS', 'SOFA/MATTRESS', 'BEDFRAME/ACC', 'SOFA/ACC',
  'MATTRESS/ACC', 'BEDFRAME/SOFA/MATTRESS', 'BEDFRAME/SOFA/ACC', 'BEDFRAME/MATTRESS/ACC',
  'SOFA/MATTRESS/ACC', 'BEDFRAME/SOFA/MATTRESS/ACC', 'PENDING', 'PARTIAL']);
const ENUMISH = /^[A-Z0-9 ()/_-]{1,24}$/i;

async function columnCensus(schemaTable, CO) {
  const [schema, table] = schemaTable.split('.');
  const cols = await sql`
    SELECT column_name, data_type
      FROM information_schema.columns
     WHERE table_schema = ${schema} AND table_name = ${table}
       AND (column_name ILIKE '%stock%' OR column_name ILIKE '%status%'
         OR column_name ILIKE '%ready%'  OR column_name ILIKE '%remark%')
     ORDER BY ordinal_position`;
  note(`\n  ${schemaTable} — ${cols.length} column(s) matching stock|status|ready|remark:`);
  if (cols.length === 0) { note('    (none)'); return; }
  for (const c of cols) {
    if (!/^[a-z0-9_]+$/i.test(c.column_name)) continue;
    const q = `SELECT coalesce(nullif(trim(t."${c.column_name}"::text), ''), '(null/empty)') AS v,
                      count(*)::int AS n
                 FROM ${schemaTable} t
                WHERE t.company_id = ${CO}::bigint
                GROUP BY 1 ORDER BY 2 DESC`;
    let rows;
    try { rows = await sql.unsafe(q); } catch (e) { note(`    ${c.column_name} (${c.data_type}) — query failed: ${e.message}`); continue; }
    const total = rows.reduce((s, r) => s + n(r.n), 0);
    const printable = rows.length <= 30 && rows.every((r) => ENUMISH.test(r.v) || r.v === '(null/empty)');
    note(`    ${padR(c.column_name, 22)} ${padR('(' + c.data_type + ')', 20)} ${rows.length} distinct / ${total} rows`);
    if (printable) {
      for (const r of rows.slice(0, 30)) note(`        ${pad(r.n, 7)}  ${JSON.stringify(r.v)}`);
    } else {
      /* Free text — bucket it instead of printing it (public log). */
      let vocab = 0, empty = 0, other = 0;
      const vocabHits = new Map();
      for (const r of rows) {
        if (r.v === '(null/empty)') { empty += n(r.n); continue; }
        if (VOCAB.has(r.v.toUpperCase())) { vocab += n(r.n); vocabHits.set(r.v.toUpperCase(), (vocabHits.get(r.v.toUpperCase()) ?? 0) + n(r.n)); }
        else other += n(r.n);
      }
      note(`        free text — NOT printed. empty=${empty}  readiness-vocabulary=${vocab}  other=${other}`);
      for (const [v, k] of [...vocabHits].sort((a, b) => b[1] - a[1])) note(`          vocab ${pad(k, 6)}  ${JSON.stringify(v)}`);
    }
  }
}

async function forCompany(CO) {
  note(`\n${'='.repeat(78)}\n=== COMPANY ${CO} ===\n${'='.repeat(78)}`);

  // ── 1. header status census ────────────────────────────────────────────────
  const census = await sql`
    SELECT coalesce(s.status,'(null)') AS status, count(*)::int AS n
      FROM scm.mfg_sales_orders s
     WHERE s.company_id = ${CO}::bigint
     GROUP BY 1 ORDER BY 2 DESC`;
  const grand = census.reduce((a, r) => a + n(r.n), 0);
  note(`\n[1] header status census — ALL sales orders, company ${CO}: ${grand}`);
  for (const r of census) {
    const live = TERMINAL.includes(r.status) ? '   ' : ' * ';
    note(`   ${live}${padR(r.status, 18)} ${pad(r.n, 7)}   ${(100 * n(r.n) / (grand || 1)).toFixed(1)}%`);
  }
  const liveTotal = census.filter((r) => !TERMINAL.includes(r.status)).reduce((a, r) => a + n(r.n), 0);
  note(`    ( * = LIVE lens, so-terminal-states.ts: NOT IN ${TERMINAL.join(',')} )  live total = ${liveTotal}`);

  // ── per-(doc, category) rollup over live orders ────────────────────────────
  const rollup = await sql.unsafe(`
    SELECT s.doc_no,
           s.status,
           (s.proceeded_at IS NOT NULL) AS proceeded,
           (s.processing_date IS NOT NULL) AS has_processing_date,
           ${CAT_SQL} AS cat,
           count(i.id)::int AS total,
           (count(i.id) FILTER (WHERE i.stock_status = 'READY'))::int AS ready,
           (count(i.id) FILTER (WHERE i.stock_status = 'PARTIAL'))::int AS partial,
           (count(i.id) FILTER (WHERE i.stock_status IS NULL))::int AS nullst
      FROM scm.mfg_sales_orders s
      LEFT JOIN scm.mfg_sales_order_items i
             ON i.doc_no = s.doc_no AND i.company_id = s.company_id AND i.cancelled = false
     WHERE s.company_id = ${CO}::bigint
       AND s.status NOT IN (${TERMINAL.map((t) => `'${t}'`).join(',')})
     GROUP BY 1,2,3,4,5
     ORDER BY 1`);

  const byDoc = new Map();
  for (const r of rollup) {
    let d = byDoc.get(r.doc_no);
    if (!d) { d = { status: r.status, proceeded: r.proceeded, hasPd: r.has_processing_date, cats: new Map(), svc: 0, partial: 0, nullst: 0 }; byDoc.set(r.doc_no, d); }
    if (n(r.total) === 0) continue;              // LEFT JOIN miss → no lines
    if (r.cat === 'SERVICE') { d.svc += n(r.total); continue; }   // skipped by so-readiness
    d.cats.set(r.cat, { total: n(r.total), ready: n(r.ready) });
    d.partial += n(r.partial); d.nullst += n(r.nullst);
  }
  for (const d of byDoc.values()) d.sum = summarise(d.cats);

  const live = [...byDoc.entries()];
  const confirmed = live.filter(([, d]) => d.status === 'CONFIRMED');
  note(`\n    live orders loaded for the line rollup: ${live.length}   (CONFIRMED: ${confirmed.length})`);

  // ── 2. CONFIRMED with EVERY considered line READY ──────────────────────────
  const noLines = confirmed.filter(([, d]) => d.sum.mainCount + d.sum.accCount === 0);
  const allReady = confirmed.filter(([, d]) => d.sum.isFullyReady);
  note(`\n[2] CONFIRMED orders where EVERY considered line is stock_status='READY'`);
  note(`      (considered = non-cancelled, non-SERVICE — exactly what so-readiness counts)`);
  note(`      ${allReady.length} / ${confirmed.length} CONFIRMED orders  (${(100 * allReady.length / (confirmed.length || 1)).toFixed(1)}%)`);
  note(`      of which ship-gate isShipReady=true: ${allReady.filter(([, d]) => d.sum.isShipReady).length}`);
  note(`      CONFIRMED orders with ZERO considered lines (empty husks, remark ''): ${noLines.length}`);
  for (const [doc, d] of allReady.slice(0, 20)) {
    note(`        ${padR(doc, 22)} main ${d.sum.mainReady}/${d.sum.mainCount}  acc ${d.sum.accReady}/${d.sum.accCount}  proceeded=${d.proceeded}  processing_date=${d.hasPd}`);
  }
  if (allReady.length > 20) note(`        … +${allReady.length - 20} more`);

  // ── 3. every MAIN READY, >=1 ACC not READY — the owner's case (a) ──────────
  const caseA = confirmed.filter(([, d]) => d.sum.mainCount > 0 && d.sum.isMainReady && d.sum.accCount > 0 && d.sum.accReady < d.sum.accCount);
  note(`\n[3] CONFIRMED orders with every MAIN line READY and >=1 ACCESSORY line NOT READY`);
  note(`      (MAIN = BEDFRAME/SOFA/MATTRESS; ACCESSORY = ACCESSORY + OTHERS; SERVICE skipped)`);
  note(`      ${caseA.length} / ${confirmed.length} CONFIRMED orders  (${(100 * caseA.length / (confirmed.length || 1)).toFixed(1)}%)`);
  note(`      every one of these has isShipReady=true → the allocator should have advanced it to READY_TO_SHIP:`);
  note(`        isShipReady true: ${caseA.filter(([, d]) => d.sum.isShipReady).length} / ${caseA.length}`);
  note(`        with a processing date: ${caseA.filter(([, d]) => d.hasPd).length};  proceeded_at set: ${caseA.filter(([, d]) => d.proceeded).length}`);
  for (const [doc, d] of caseA.slice(0, 20)) {
    note(`        ${padR(doc, 22)} main ${d.sum.mainReady}/${d.sum.mainCount}  acc ${d.sum.accReady}/${d.sum.accCount}  remark=${JSON.stringify(d.sum.stockRemark)}  proceeded=${d.proceeded}`);
  }
  if (caseA.length > 20) note(`        … +${caseA.length - 20} more`);

  // the same shape at any live status, so we can see where these orders sit
  const caseAany = live.filter(([, d]) => d.sum.mainCount > 0 && d.sum.isMainReady && d.sum.accCount > 0 && d.sum.accReady < d.sum.accCount);
  const byStatus = new Map();
  for (const [, d] of caseAany) byStatus.set(d.status, (byStatus.get(d.status) ?? 0) + 1);
  note(`      same shape across ALL live statuses: ${caseAany.length} — ${[...byStatus].map(([k, v]) => `${k}=${v}`).join('  ') || '(none)'}`);

  // ── 4. columns that could drive a header STOCK STATUS ──────────────────────
  note(`\n[4] columns on the SO header / lines whose name mentions stock|status|ready|remark`);
  await columnCensus('scm.mfg_sales_orders', CO);
  await columnCensus('scm.mfg_sales_order_items', CO);

  // ── 5. derived stock_remark distribution + the case-(b) population ─────────
  const remarkDist = new Map();
  for (const [, d] of live) {
    const key = `${d.status}|${d.sum.stockRemark}`;
    remarkDist.set(key, (remarkDist.get(key) ?? 0) + 1);
  }
  note(`\n[5] DERIVED stock_remark (so-readiness.summariseReadiness, mirrored) x header status, live orders`);
  note(`      status              remark                      n`);
  for (const [k, v] of [...remarkDist].sort((a, b) => b[1] - a[1])) {
    const [st, rm] = k.split('|');
    note(`      ${padR(st, 19)} ${padR(JSON.stringify(rm), 26)} ${pad(v, 6)}`);
  }
  const chip = live.filter(([, d]) => d.sum.stockRemark !== '' && d.sum.stockRemark !== 'READY' && d.sum.stockRemark !== 'READY (PARTIAL)');
  note(`\n      category-chip remarks (the "BEDFRAME" cell): ${chip.length} / ${live.length} live orders`);
  const chipConfirmed = chip.filter(([, d]) => d.status === 'CONFIRMED');
  note(`        of which CONFIRMED: ${chipConfirmed.length}`);
  note(`        by construction every one has >=1 MAIN line NOT stock_status='READY' —`);
  note(`        that not-READY MAIN line is what the drill-down pill can still paint READY`);
  note(`        (SoSourceChips.tsx soLineStockPill: stock_state==='stock' OR stock_status==='READY').`);
  let chipPending = 0, chipPartial = 0, chipNull = 0, chipNoPd = 0;
  for (const [, d] of chip) {
    chipPartial += d.partial; chipNull += d.nullst;
    chipPending += (d.sum.mainCount - d.sum.mainReady) + (d.sum.accCount - d.sum.accReady);
    if (!d.proceeded) chipNoPd += 1;
  }
  note(`        not-READY lines on those orders: ${chipPending}  (of which stock_status='PARTIAL': ${chipPartial}, NULL: ${chipNull})`);
  note(`        chip-remark orders with proceeded_at NULL (allocation-gated): ${chipNoPd} / ${chip.length}`);
  const contradiction = live.filter(([, d]) => d.sum.isFullyReady && d.sum.stockRemark !== 'READY');
  note(`      sanity: fully-ready orders whose derived remark is NOT 'READY': ${contradiction.length} (must be 0)`);

  // ── 6. the allocation gate ────────────────────────────────────────────────
  const gated = live.filter(([, d]) => !d.proceeded);
  const gatedByStatus = new Map();
  for (const [, d] of gated) gatedByStatus.set(d.status, (gatedByStatus.get(d.status) ?? 0) + 1);
  note(`\n[6] allocation gate (so-stock-allocation.ts:147 — proceeded_at NULL forces every line PENDING)`);
  note(`      live orders with proceeded_at NULL: ${gated.length} / ${live.length}`);
  note(`      ${[...gatedByStatus].map(([k, v]) => `${k}=${v}`).join('  ') || '(none)'}`);
  const pdMismatch = live.filter(([, d]) => d.hasPd !== d.proceeded);
  note(`      live orders where processing_date IS NOT NULL disagrees with proceeded_at IS NOT NULL: ${pdMismatch.length}`);

  return byDoc;
}

async function dumpOrder(CO, byDoc) {
  if (!DOC && !AMOUNT) return;
  const hdr = DOC
    ? await sql`SELECT doc_no, status, company_id, branding, local_total_centi,
                       processing_date::text AS processing_date, proceeded_at::text AS proceeded_at,
                       customer_delivery_date::text AS cdd
                  FROM scm.mfg_sales_orders
                 WHERE company_id = ${CO}::bigint AND doc_no = ${DOC}`
    : await sql`SELECT doc_no, status, company_id, branding, local_total_centi,
                       processing_date::text AS processing_date, proceeded_at::text AS proceeded_at,
                       customer_delivery_date::text AS cdd
                  FROM scm.mfg_sales_orders
                 WHERE company_id = ${CO}::bigint AND local_total_centi = ${Number(AMOUNT)}::bigint
                 ORDER BY doc_no LIMIT 5`;
  note(`\n[7] named-order dump, company ${CO} — ${hdr.length} match(es)  (no customer identity printed)`);
  for (const h of hdr) {
    const d = byDoc.get(h.doc_no);
    note(`\n    ${h.doc_no}  status=${h.status}  branding=${JSON.stringify(h.branding ?? '')}  total_centi=${h.local_total_centi}`);
    note(`      processing_date=${h.processing_date ?? '(null)'}  proceeded_at=${h.proceeded_at ?? '(null)'}  customer_delivery_date=${h.cdd ?? '(null)'}`);
    note(`      DERIVED stock_remark = ${JSON.stringify(d?.sum?.stockRemark ?? '(not in live set)')}`);
    if (d?.sum) note(`      main ${d.sum.mainReady}/${d.sum.mainCount}   acc ${d.sum.accReady}/${d.sum.accCount}   isShipReady=${d.sum.isShipReady}`);
    const lines = await sql.unsafe(`
      SELECT i.item_code, i.item_group, i.qty, i.cancelled, i.stock_status, i.stock_qty_ready,
             ${CAT_SQL} AS cat, (i.warehouse_id IS NULL) AS no_wh
        FROM scm.mfg_sales_order_items i
       WHERE i.company_id = ${CO}::bigint AND i.doc_no = '${h.doc_no.replace(/'/g, "''")}'
       ORDER BY i.line_no NULLS LAST, i.created_at`);
    note(`      ${lines.length} line(s):`);
    note(`        ${padR('item_code', 26)} ${padR('item_group', 16)} ${padR('cat', 10)} ${padR('qty', 5)} ${padR('stock_status', 13)} qty_ready  cancelled  no_wh`);
    for (const l of lines) {
      note(`        ${padR(l.item_code ?? '', 26)} ${padR(l.item_group ?? '', 16)} ${padR(l.cat, 10)} ${padR(l.qty, 5)} ${padR(l.stock_status ?? '(null)', 13)} ${pad(l.stock_qty_ready ?? 0, 9)}  ${padR(l.cancelled, 9)}  ${l.no_wh}`);
    }
  }
}

async function main() {
  /* doc_no collisions across companies — the list route joins lines to headers
     by doc_no ALONE (mfg-sales-orders.ts:1480 `.in('doc_no', docNos)`, no
     company filter), so a shared doc_no would mix two companies' lines into one
     readiness roll-up. Settle whether that can happen at all. */
  const collide = await sql`
    SELECT count(*)::int AS n FROM (
      SELECT doc_no FROM scm.mfg_sales_orders GROUP BY doc_no HAVING count(DISTINCT company_id) > 1
    ) t`;
  note(`[0] doc_no values present in MORE THAN ONE company: ${collide[0].n}`);
  note(`    (the list route joins lines by doc_no with no company filter — mfg-sales-orders.ts:1480)`);

  for (const CO of COMPANIES) {
    const byDoc = await forCompany(CO);
    await dumpOrder(CO, byDoc);
  }
  await sql.end({ timeout: 5 });
}

main().catch(async (e) => { console.error(e); try { await sql.end({ timeout: 5 }); } catch { /* closed */ } process.exit(1); });
