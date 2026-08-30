#!/usr/bin/env node
/* delete-hc-test-docs.mjs — delete ONLY the ERP-minted TEST documents in Houzs
   Century (HC), keeping every RE-IMPORTED real AutoCount document. NEVER touches
   2990.
   ===========================================================================

   WHY THIS EXISTS (老板版):
   Houzs Century 里现在有两种单:
     • 真实的:从 AutoCount 重新导入的历史,单号是 AutoCount 原生的 6 位数
       (HC-SO-013403 / HC-PO-010093 / HC-DO-011444 …)。有 2,770 张 SO 等等,
       全部要保留。
     • 测试的:之前做 AutoCount 写回测试时 ERP 自己开的单,单号是 YYMM 格式
       (HC-SO-2608-001 / HC-DO-2608-006 / HC-SI-2608-005 …)。这些是垃圾,要删。
   这支工具只删「测试的」那种,靠单号格式区分,绝不碰真实导入的数据,也绝不碰
   2990。默认只做「预演(plan)」:只列出会删什么、一个字都不写。要真的删,必须
   MODE=apply 且输入确认句。

   ── HOW IT DISTINGUISHES TEST FROM REAL ─────────────────────────────────────
   The ONLY selector is the document-number FORMAT, per document type. The
   number column DIFFERS per header (verified against the live schema; the real
   name is auto-detected from candidates):
     SO   mfg_sales_orders.doc_no          LIKE 'HC-SO-2608-%'   (real: HC-SO-013403)
     PO   purchase_orders.po_number        LIKE 'HC-PO-2608-%'   (real: HC-PO-010093)
     DO   delivery_orders.do_number        LIKE 'HC-DO-2608-%'   (real: HC-DO-011444)
     GRN  grns.grn_number                  LIKE 'HC-GR-2608-%'   (real: HC-GR-005320)
     PI   purchase_invoices.invoice_number LIKE 'HC-PI-2608-%'   (real: HC-PI-007931)
     SI   sales_invoices.invoice_number    LIKE 'HC-SI-2608-%'   (real: HC-I-2608-… — HC-I- not HC-SI-)
   The `-2608-` minted format is what the ERP hands out for a NEW document it
   creates itself; the re-import carries AutoCount's own numbers, which never take
   that shape.

   ── WHY IT CANNOT DELETE A REAL DOCUMENT (two independent guards) ────────────
   1. SELECTION BY REACHABILITY. Every deleted row is reachable, through the live
      pg_constraint FK graph, from a HEADER whose number matches a test pattern.
      A real (6-digit) document is never a seed, so nothing of it enters scope.
      Selection is a nested-subquery PREDICATE built from the ACTUAL FK columns
      (conkey -> confkey), so it is correct whether a table is keyed by a uuid
      `id` or by a text `doc_no` (mfg_sales_orders is keyed by doc_no).
   2. VERIFICATION. After the delete, on a FRESH connection, it asserts the count
      of REAL HC docs (company_id=HC AND number NOT LIKE the test pattern) in
      every header table is UNCHANGED, and 2990's row counts are unchanged. The
      same assertion also runs IN-TRANSACTION so a drift rolls back before commit.

   ── SAFETY MODEL ────────────────────────────────────────────────────────────
   Service-role client (RLS bypassed) — the predicate is the only isolation.
   Apply runs in ONE transaction: any FK surprise or a real-count/2990 drift rolls
   the WHOLE thing back — never a partial delete. An INCOMPLETE scope fails SAFE:
   an un-mapped child with a NO ACTION FK blocks its parent, the transaction rolls
   back, and the error names the table — it can never over-delete. Before deleting,
   apply DUMPS every row it will delete to a backup dir (uploaded as a workflow
   artifact), so it is fully recoverable.

   ── MODES ───────────────────────────────────────────────────────────────────
   MODE=plan (DEFAULT): read-only. Lists every test header (number/status/date),
     the rows-per-table it would delete, and the REAL-doc counts that must stay
     unchanged. WRITES NOTHING.
   MODE=apply: requires CONFIRM="DELETE HC TEST DOCS". Backs up, deletes children
     -> parents, then re-reads on a FRESH connection and asserts test headers gone,
     REAL HC counts unchanged, 2990 unchanged.

   RE-RUN: idempotent. A second apply finds no test headers and is a no-op that
     still passes every assertion and exits 0.
   =========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }

const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'DELETE HC TEST DOCS';
const HC_CODE = 'HOUZS';
const MIRRORED_CODE = '2990';
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(process.cwd(), 'hc-test-docs-backup');

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);
const ident = /^[a-z_][a-z0-9_]*$/;
const qi = (s) => { if (!ident.test(s)) throw new Error(`unsafe identifier: ${s}`); return s; };

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

/* Header families + the test-number pattern + candidate number columns (the real
   one is auto-detected against the live schema). */
const HEADER_FAMILIES = [
  ['scm', 'sales_invoices',    'SI',  'HC-SI-2608-%', ['invoice_number', 'doc_no']],
  ['scm', 'purchase_invoices', 'PI',  'HC-PI-2608-%', ['invoice_number', 'doc_no']],
  ['scm', 'grns',              'GRN', 'HC-GR-2608-%', ['grn_number', 'doc_no']],
  ['scm', 'delivery_orders',   'DO',  'HC-DO-2608-%', ['do_number', 'doc_no']],
  ['scm', 'purchase_orders',   'PO',  'HC-PO-2608-%', ['po_number', 'doc_no']],
  ['scm', 'mfg_sales_orders',  'SO',  'HC-SO-2608-%', ['doc_no']],
];

// Stock + integration rows carry the document NUMBER (not an FK), so they are
// seeded by the set of test doc-numbers directly.
const DOCNO_SEEDS = [
  ['scm', 'inventory_movements', 'source_doc_no'],
  ['scm', 'inventory_lots', 'source_doc_no'],
];

function topoDeleteOrder(nodes, edges) {
  const nodeSet = new Set(nodes);
  const out = new Map(nodes.map((n) => [n, []]));
  const indeg = new Map(nodes.map((n) => [n, 0]));
  const seen = new Set();
  for (const [child, parent] of edges) {
    if (child === parent || !nodeSet.has(child) || !nodeSet.has(parent)) continue;
    const ek = `${child}|${parent}`;
    if (seen.has(ek)) continue;
    seen.add(ek);
    out.get(child).push(parent);
    indeg.set(parent, indeg.get(parent) + 1);
  }
  const order = [];
  const queue = nodes.filter((n) => indeg.get(n) === 0);
  while (queue.length) {
    const n = queue.shift();
    order.push(n);
    for (const parent of out.get(n)) { indeg.set(parent, indeg.get(parent) - 1); if (indeg.get(parent) === 0) queue.push(parent); }
  }
  const placed = new Set(order);
  return { order, remaining: nodes.filter((n) => !placed.has(n)) };
}

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (read-only, nothing is written)'}`);
  const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

  // 1. Resolve HC + 2990, assert distinct.
  const companies = await sql`SELECT id::text AS id, code, name FROM public.companies ORDER BY id`;
  const hc = companies.filter((r) => String(r.code).trim().toUpperCase() === HC_CODE);
  const other = companies.filter((r) => String(r.code).trim().toUpperCase() === MIRRORED_CODE);
  if (hc.length !== 1) { bad(`expected ONE company '${HC_CODE}', found ${hc.length}`); await sql.end({ timeout: 5 }); process.exit(2); }
  const HC_ID = Number(hc[0].id);
  const OTHER_ID = other.length === 1 ? Number(other[0].id) : null;
  if (!Number.isInteger(HC_ID) || HC_ID <= 0) { bad(`HC id not positive int`); await sql.end({ timeout: 5 }); process.exit(2); }
  if (OTHER_ID !== null && HC_ID === OTHER_ID) { bad(`HC id equals 2990 id`); await sql.end({ timeout: 5 }); process.exit(2); }
  note(`\n=== TARGET ===`);
  note(`  HC (test docs only): id=${HC_ID} name=${hc[0].name}`);
  note(`  2990 (NEVER touch):  ${OTHER_ID !== null ? `id=${OTHER_ID}` : 'not present'}`);

  // 2. Live schema + single-column FK graph (child col -> parent col).
  const cols = await sql`SELECT table_schema AS s, table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema IN ('scm','public')`;
  const colsByTable = new Map();
  for (const r of cols) { const k = `${r.s}.${r.t}`; if (!colsByTable.has(k)) colsByTable.set(k, new Set()); colsByTable.get(k).add(r.c); }
  const liveTables = await sql`SELECT table_schema AS s, table_name AS t FROM information_schema.tables WHERE table_schema IN ('scm','public') AND table_type='BASE TABLE'`;
  const liveSet = new Set(liveTables.map((r) => `${r.s}.${r.t}`));
  const hasCol = (key, c) => (colsByTable.get(key) || new Set()).has(c);
  const firstCol = (key, cands) => cands.find((c) => hasCol(key, c)) || null;

  const fkRows = await sql`
    SELECT ns.nspname AS cs, cl.relname AS ct, cattr.attname AS ccol,
           fns.nspname AS ps, fcl.relname AS pt, fattr.attname AS pcol
      FROM pg_constraint con
      JOIN pg_class cl ON cl.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = cl.relnamespace
      JOIN pg_class fcl ON fcl.oid = con.confrelid
      JOIN pg_namespace fns ON fns.oid = fcl.relnamespace
      JOIN unnest(con.conkey)  WITH ORDINALITY AS ck(attnum, ord) ON true
      JOIN unnest(con.confkey) WITH ORDINALITY AS fk(attnum, ord) ON fk.ord = ck.ord
      JOIN pg_attribute cattr ON cattr.attrelid = con.conrelid  AND cattr.attnum = ck.attnum
      JOIN pg_attribute fattr ON fattr.attrelid = con.confrelid AND fattr.attnum = fk.attnum
     WHERE con.contype = 'f' AND ns.nspname IN ('scm','public') AND array_length(con.conkey,1) = 1`;
  // parentKey -> [{ childKey, childCol, parentCol }]
  const childrenOf = new Map();
  for (const r of fkRows) {
    const parent = `${r.ps}.${r.pt}`, child = `${r.cs}.${r.ct}`;
    if (child === parent) continue;
    if (!childrenOf.has(parent)) childrenOf.set(parent, []);
    childrenOf.get(parent).push({ childKey: child, childCol: r.ccol, parentCol: r.pcol });
  }

  // 3. Resolve header seeds: docCol per family + the actual test doc-numbers.
  note(`\n=== TEST HEADERS (ERP-minted -2608- documents in HC) ===`);
  const seedPreds = new Map(); // tableKey -> array of postgres fragments (OR'd)
  const headerInfo = [];       // { key, label, docCol, pattern, docNos }
  const testDocNos = [];
  for (const [schema, table, label, pattern, cands] of HEADER_FAMILIES) {
    const key = `${schema}.${table}`;
    if (!liveSet.has(key)) { note(`  ${label}: ${key} absent — skipped`); continue; }
    const docCol = firstCol(key, cands);
    if (!docCol) { note(`  ${label}: ${key} has no number column (${cands.join('/')}) — skipped`); continue; }
    if (!hasCol(key, 'company_id')) { note(`  ${label}: ${key} has no company_id — skipped`); continue; }
    const rows = await sql`
      SELECT ${sql(qi(docCol))} AS num,
             ${hasCol(key, 'status') ? sql`status` : sql`NULL AS status`},
             ${hasCol(key, 'created_at') ? sql`created_at` : sql`NULL AS created_at`}
        FROM ${sql(qi(schema))}.${sql(qi(table))}
       WHERE company_id = ${HC_ID} AND ${sql(qi(docCol))} LIKE ${pattern}
       ORDER BY ${sql(qi(docCol))}`;
    if (!rows.length) { note(`  ${label}: none`); continue; }
    const docNos = rows.map((r) => r.num);
    testDocNos.push(...docNos);
    headerInfo.push({ key, label, docCol, pattern, docNos });
    const frag = sql`(company_id = ${HC_ID} AND ${sql(qi(docCol))} LIKE ${pattern})`;
    if (!seedPreds.has(key)) seedPreds.set(key, []);
    seedPreds.get(key).push(frag);
    note(`  ${label} (${rows.length}):`);
    for (const r of rows) note(`      ${r.num}   status=${r.status ?? '-'}   ${r.created_at ? String(r.created_at).slice(0, 19) : ''}`);
  }
  // 3b. Export-log (outbox) entries for the test docs. The earlier go-live wipes
  //     DELETE a test document's source row but KEEP its outbox row, so after a
  //     wipe the sync page still shows the test doc even though no header remains.
  //     Match the SAME per-type test patterns (never a blanket %-2608-% — that
  //     would catch real HC-I-2608 sales-invoice sends).
  note(`\n=== EXPORT-LOG (outbox) rows for the test docs ===`);
  const outKey = `scm.autocount_outbox`;
  const outboxDocNos = [];
  if (liveSet.has(outKey) && hasCol(outKey, 'doc_no') && hasCol(outKey, 'company_id')) {
    const patterns = HEADER_FAMILIES.map((f) => f[3]);
    let orFrag = null;
    for (const p of patterns) { const f = sql`doc_no LIKE ${p}`; orFrag = orFrag === null ? f : sql`${orFrag} OR ${f}`; }
    const rows = await sql`
      SELECT doc_no,
             ${hasCol(outKey, 'status') ? sql`status` : sql`NULL AS status`},
             ${hasCol(outKey, 'op') ? sql`op` : sql`NULL AS op`}
        FROM ${sql(qi('scm'))}.${sql(qi('autocount_outbox'))}
       WHERE company_id = ${HC_ID} AND (${orFrag})
       ORDER BY doc_no`;
    for (const r of rows) { outboxDocNos.push(r.doc_no); note(`      ${r.doc_no}   status=${r.status ?? '-'}   op=${r.op ?? '-'}`); }
    if (!rows.length) note(`  none`);
    if (outboxDocNos.length) {
      for (const d of outboxDocNos) if (!testDocNos.includes(d)) testDocNos.push(d);
      if (!seedPreds.has(outKey)) seedPreds.set(outKey, []);
      seedPreds.get(outKey).push(sql`(company_id = ${HC_ID} AND (${orFrag}))`);
    }
  } else { note(`  outbox table/columns absent — skipped`); }

  if (!headerInfo.length && !outboxDocNos.length) { note(`\n=== NO TEST DOCUMENTS FOUND — nothing to do. ===`); await sql.end({ timeout: 5 }); return; }

  // 4. Doc-number seeds (stock) — carry the number, not an FK.
  for (const [schema, table, col] of DOCNO_SEEDS) {
    const key = `${schema}.${table}`;
    if (!liveSet.has(key) || !hasCol(key, col)) continue;
    const frag = hasCol(key, 'company_id')
      ? sql`(company_id = ${HC_ID} AND ${sql(qi(col))} = ANY(${testDocNos}))`
      : sql`(${sql(qi(col))} = ANY(${testDocNos}))`;
    if (!seedPreds.has(key)) seedPreds.set(key, []);
    seedPreds.get(key).push(frag);
  }

  // 5. Reachable table set: seeds + everything that transitively references a seed.
  const inScope = new Set(seedPreds.keys());
  {
    const queue = [...inScope];
    while (queue.length) {
      const parent = queue.shift();
      for (const { childKey } of (childrenOf.get(parent) || [])) {
        if (!liveSet.has(childKey) || inScope.has(childKey)) continue;
        inScope.add(childKey); queue.push(childKey);
      }
    }
  }

  // 6. Build each scoped table's selection predicate (memoized; acyclic scope).
  //    predicate(T) = OR( seed fragments of T , for each FK T.ccol->P.pcol with P
  //    in scope: T.ccol IN (SELECT P.pcol FROM P WHERE predicate(P)) ).
  const predCache = new Map();
  const building = new Set();
  function predicate(key) {
    if (predCache.has(key)) return predCache.get(key);
    if (building.has(key)) return null; // cycle guard (should not happen)
    building.add(key);
    const parts = [...(seedPreds.get(key) || [])];
    for (const r of fkRows) {
      const child = `${r.cs}.${r.ct}`, parent = `${r.ps}.${r.pt}`;
      if (child !== key || parent === key || !inScope.has(parent)) continue;
      const pp = predicate(parent);
      if (!pp) continue;
      const [ps, pt] = parent.split('.');
      parts.push(sql`${sql(qi(r.ccol))} IN (SELECT ${sql(qi(r.pcol))} FROM ${sql(qi(ps))}.${sql(qi(pt))} WHERE ${pp})`);
    }
    building.delete(key);
    let frag = null;
    for (const p of parts) frag = frag === null ? p : sql`${frag} OR ${p}`;
    predCache.set(key, frag);
    return frag;
  }

  // 7. Count per scoped table (read-only).
  note(`\n=== SCOPE — rows that WOULD be deleted (reachable from test headers) ===`);
  const counts = [];
  for (const key of inScope) {
    const pred = predicate(key);
    if (!pred) continue;
    const [s, t] = key.split('.');
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM ${sql(qi(s))}.${sql(qi(t))} WHERE ${pred}`;
    if (n > 0) counts.push([key, n]);
  }
  counts.sort((a, b) => b[1] - a[1]);
  let scopeTotal = 0;
  for (const [key, n] of counts) { note(`  ${String(n).padStart(7)}  ${key}`); scopeTotal += n; }
  note(`  ${'-'.repeat(48)}`);
  note(`  ${String(scopeTotal).padStart(7)}  TOTAL across ${counts.length} tables`);

  // 8. REAL-doc invariant baseline (must never change).
  note(`\n=== REAL DOCUMENTS — counts that MUST stay UNCHANGED ===`);
  const realBefore = new Map();
  for (const h of headerInfo) {
    const [s, t] = h.key.split('.');
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM ${sql(qi(s))}.${sql(qi(t))} WHERE company_id = ${HC_ID} AND ${sql(qi(h.docCol))} NOT LIKE ${h.pattern}`;
    realBefore.set(h.key, n);
    note(`  ${h.label.padEnd(4)} ${h.key.padEnd(26)} real HC docs = ${n}  (must stay ${n})`);
  }

  // 9. 2990 baseline for every touched table that carries company_id.
  const otherBefore = new Map();
  if (OTHER_ID !== null) {
    for (const [key] of counts) {
      if (!hasCol(key, 'company_id')) { otherBefore.set(key, null); continue; }
      const [s, t] = key.split('.');
      const [{ n }] = await sql`SELECT count(*)::int AS n FROM ${sql(qi(s))}.${sql(qi(t))} WHERE company_id = ${OTHER_ID}`;
      otherBefore.set(key, n);
    }
  }

  // 10. Delete order: children before parents, topological over scoped subgraph.
  const scopeKeys = counts.map(([k]) => k);
  const scopeKeySet = new Set(scopeKeys);
  const edges = [];
  for (const r of fkRows) {
    const child = `${r.cs}.${r.ct}`, parent = `${r.ps}.${r.pt}`;
    if (child !== parent && scopeKeySet.has(child) && scopeKeySet.has(parent)) edges.push([child, parent]);
  }
  const { order: topoOrder, remaining: cycle } = topoDeleteOrder(scopeKeys, edges);
  const deleteOrder = [...topoOrder, ...cycle];

  if (!APPLY) {
    note(`\n=== PLAN COMPLETE — nothing was written. ===`);
    note(`  Would delete ${scopeTotal} rows for ${testDocNos.length} test documents.`);
    note(`  To execute:  MODE=apply CONFIRM="${CONFIRM_PHRASE}"`);
    await sql.end({ timeout: 5 });
    return;
  }

  // 11. APPLY: backup every row to be deleted, then delete children->parents.
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const manifest = { company: { id: HC_ID }, when: new Date().toISOString(), testDocNos, tables: {} };
  for (const [key] of counts) {
    const pred = predicate(key);
    const [s, t] = key.split('.');
    const rows = await sql`SELECT * FROM ${sql(qi(s))}.${sql(qi(t))} WHERE ${pred}`;
    fs.writeFileSync(path.join(BACKUP_DIR, `${key}.json`), JSON.stringify(rows, null, 0));
    manifest.tables[key] = rows.length;
  }
  fs.writeFileSync(path.join(BACKUP_DIR, '_manifest.json'), JSON.stringify(manifest, null, 2));
  note(`\n=== BACKUP written to ${BACKUP_DIR} (${counts.length} table dumps) ===`);

  let deletedTotal = 0;
  await sql.begin(async (tx) => {
    for (const key of deleteOrder) {
      const pred = predicate(key);
      const [s, t] = key.split('.');
      const del = await tx`DELETE FROM ${tx(qi(s))}.${tx(qi(t))} WHERE ${pred}`;
      deletedTotal += del.count;
    }
    note(`  deleted ${deletedTotal} rows in transaction`);
    // In-transaction guards.
    if (OTHER_ID !== null) {
      for (const [key, was] of otherBefore) {
        if (was === null) continue;
        const [s, t] = key.split('.');
        const [{ n }] = await tx`SELECT count(*)::int AS n FROM ${tx(qi(s))}.${tx(qi(t))} WHERE company_id = ${OTHER_ID}`;
        if (n !== was) throw new Error(`2990 count MOVED on ${key} (was ${was}, now ${n}) — rolling back`);
      }
    }
    for (const h of headerInfo) {
      const [s, t] = h.key.split('.');
      const [{ n }] = await tx`SELECT count(*)::int AS n FROM ${tx(qi(s))}.${tx(qi(t))} WHERE company_id = ${HC_ID} AND ${tx(qi(h.docCol))} NOT LIKE ${h.pattern}`;
      if (n !== realBefore.get(h.key)) throw new Error(`REAL ${h.key} MOVED (was ${realBefore.get(h.key)}, now ${n}) — rolling back`);
    }
    note(`  in-transaction guards passed: real HC docs intact, 2990 unchanged.`);
  });

  // 12. VERIFY on a FRESH connection.
  await sql.end({ timeout: 5 });
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    const problems = [];
    for (const h of headerInfo) {
      const [s, t] = h.key.split('.');
      const [{ n }] = await check`SELECT count(*)::int AS n FROM ${check(qi(s))}.${check(qi(t))} WHERE company_id = ${HC_ID} AND ${check(qi(h.docCol))} = ANY(${h.docNos})`;
      if (n !== 0) problems.push(`${h.label} ${h.key}: ${n} test header(s) still present`);
    }
    if (outboxDocNos.length) {
      const [{ n }] = await check`SELECT count(*)::int AS n FROM ${check(qi('scm'))}.${check(qi('autocount_outbox'))} WHERE company_id = ${HC_ID} AND doc_no = ANY(${outboxDocNos})`;
      note(`  export-log test rows remaining: ${n} (want 0)`);
      if (n !== 0) problems.push(`autocount_outbox: ${n} test export-log row(s) still present`);
    }
    for (const h of headerInfo) {
      const [s, t] = h.key.split('.');
      const [{ n }] = await check`SELECT count(*)::int AS n FROM ${check(qi(s))}.${check(qi(t))} WHERE company_id = ${HC_ID} AND ${check(qi(h.docCol))} NOT LIKE ${h.pattern}`;
      const was = realBefore.get(h.key);
      note(`  ${h.label.padEnd(4)} real HC docs: ${n} (want ${was})`);
      if (n !== was) problems.push(`REAL ${h.key} CHANGED: was ${was}, now ${n}`);
    }
    if (OTHER_ID !== null) {
      let drift = 0;
      for (const [key, was] of otherBefore) {
        if (was === null) continue;
        const [s, t] = key.split('.');
        const [{ n }] = await check`SELECT count(*)::int AS n FROM ${check(qi(s))}.${check(qi(t))} WHERE company_id = ${OTHER_ID}`;
        if (n !== was) { problems.push(`2990 CHANGED on ${key}: was ${was}, now ${n}`); drift++; }
      }
      note(`  2990 touched-tables changed: ${drift} (want 0)`);
    }
    if (problems.length) { bad(`VERIFICATION FAILED:\n${problems.map((p) => `    - ${p}`).join('\n')}`); process.exit(1); }
    note(`\n  ALL ASSERTIONS PASSED: test documents gone, every REAL HC document intact, 2990 unchanged.`);
    note(`  Backup in ${BACKUP_DIR} (uploaded as a workflow artifact).`);
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch((e) => { bad(e.message); process.exit(1); });
