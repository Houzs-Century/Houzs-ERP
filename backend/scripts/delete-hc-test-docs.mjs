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
     • 测试的:之前做 AutoCount 写回测试时,ERP 自己开的单,单号是 YYMM 格式
       (HC-SO-2608-001 / HC-DO-2608-006 / HC-SI-2608-005 …)。这些是垃圾,要删。
   这支工具只删「测试的」那种,靠单号格式区分,绝不碰真实导入的数据,也绝不碰
   2990。默认只做「预演(plan)」:只列出会删什么、一个字都不写。要真的删,必须
   MODE=apply 且输入确认句。

   ── HOW IT DISTINGUISHES TEST FROM REAL ─────────────────────────────────────
   The ONLY selector is the document-number FORMAT, per document type:
     SO   HC-SO-2608-%     (real: HC-SO-013403, 6-digit AutoCount-native)
     PO   HC-PO-2608-%     (real: HC-PO-010093)
     DO   HC-DO-2608-%     (real: HC-DO-011444)
     GRN  HC-GR-2608-%     (real: HC-GR-005320)
     PI   HC-PI-2608-%     (real: HC-PI-007931)
     SI   HC-SI-2608-%     (real: HC-I-2608-…  — DIFFERENT PREFIX, HC-I- not HC-SI-)
   The `-2608-` minted format is what the ERP hands out for a NEW document it
   creates itself; the re-import carries AutoCount's own numbers, which never take
   that shape. The SI case is the one trap: real sales invoices are `HC-I-2608-…`
   and test ones are `HC-SI-2608-…`, so the pattern uses the exact `HC-SI-` prefix,
   never a blanket `%-2608-%`.

   ── WHY IT CANNOT DELETE A REAL DOCUMENT ────────────────────────────────────
   Two independent guards, either of which alone is sufficient:
     1. SELECTION. Every row deleted is reachable, through the live foreign-key
        graph, from a HEADER whose doc_no matches a test pattern above. A real
        document (6-digit number) is never a seed, so nothing of it enters scope.
     2. VERIFICATION. After the delete, on a FRESH connection, the script asserts
        that the count of REAL HC documents (company_id = HC AND doc_no NOT LIKE
        the test pattern) in every touched header table is UNCHANGED from before,
        and that 2990's row counts are unchanged. If either moved, it screams.

   ── SCOPE BY REACHABILITY (not by a hand-written table list) ────────────────
   Seeds = the test HEADER rows (+ their stock movements/lots by source_doc_no,
   + their autocount_outbox rows by doc_no). Scope is expanded to a FIXPOINT over
   pg_constraint's FK graph: a child row enters scope only when its FK column
   points at a row already in scope. So scope is exactly "the test documents and
   everything that belongs to them", computed from the live schema — a new child
   table added by a future migration is picked up automatically.

   ── SAFETY MODEL ────────────────────────────────────────────────────────────
   Service-role client (RLS bypassed), so the predicate is the only isolation:
   every delete is `WHERE id = ANY(<scoped ids>)`, and the scoped ids came only
   from test-reachable rows. Apply runs in ONE transaction: any FK surprise or a
   real-count/2990 drift rolls the WHOLE thing back — never a partial delete. An
   INCOMPLETE scope fails SAFE: an un-mapped child with a NO ACTION FK blocks its
   parent's delete, the transaction rolls back, and the error names the table to
   add — it can never over-delete. Before deleting, apply DUMPS every scoped row to
   a backup dir (uploaded as a workflow artifact), so it is fully recoverable.

   ── MODES ───────────────────────────────────────────────────────────────────
   MODE=plan (DEFAULT): read-only. Lists every test header (number/date/party/
     amount/status/linked_ac_docno), the total scoped rows per table, the stock +
     outbox footprint, and the REAL-doc counts that must stay unchanged. WRITES
     NOTHING.
   MODE=apply: requires CONFIRM="DELETE HC TEST DOCS". Backs up, deletes children
     -> parents (topological over the induced FK subgraph), then re-reads on a
     FRESH connection and asserts: every test header gone; REAL HC header counts
     unchanged; 2990 unchanged.

   RE-RUN: idempotent. A second plan re-lists (fewer, or none, after an apply). A
     second apply finds no test headers and is a no-op that still passes every
     assertion and exits 0.
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

/* The document families that can carry an ERP-minted test number, and the EXACT
   test-number pattern for each. `doc_no` is the human number column on every one
   of these headers (verified against the live schema below; a header missing it
   is skipped with a note). The pattern is deliberately per-type and anchored on
   the full `HC-<TYPE>-2608-` prefix so the SI HC-I-/HC-SI- distinction holds. */
const HEADER_FAMILIES = [
  ['scm', 'sales_invoices',    'SI',  'HC-SI-2608-%'],
  ['scm', 'purchase_invoices', 'PI',  'HC-PI-2608-%'],
  ['scm', 'grns',              'GRN', 'HC-GR-2608-%'],
  ['scm', 'delivery_orders',   'DO',  'HC-DO-2608-%'],
  ['scm', 'purchase_orders',   'PO',  'HC-PO-2608-%'],
  ['scm', 'mfg_sales_orders',  'SO',  'HC-SO-2608-%'],
];

// Stock + integration rows are seeded by the test doc_nos directly (they carry a
// doc-number reference column rather than an FK to the header).
const STOCK_BY_DOCNO = [
  ['scm', 'inventory_movements', 'source_doc_no'],
  ['scm', 'inventory_lots', 'source_doc_no'],
];
const OUTBOX = ['scm', 'autocount_outbox', 'doc_no'];

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
    for (const parent of out.get(n)) {
      indeg.set(parent, indeg.get(parent) - 1);
      if (indeg.get(parent) === 0) queue.push(parent);
    }
  }
  const placed = new Set(order);
  return { order, remaining: nodes.filter((n) => !placed.has(n)) };
}

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (read-only, nothing is written)'}`);
  const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

  // ── 1. Resolve HC + 2990, assert distinct ─────────────────────────────────
  const companies = await sql`SELECT id::text AS id, code, name FROM public.companies ORDER BY id`;
  const hc = companies.filter((r) => String(r.code).trim().toUpperCase() === HC_CODE);
  const other = companies.filter((r) => String(r.code).trim().toUpperCase() === MIRRORED_CODE);
  if (hc.length !== 1) { bad(`expected exactly ONE company code '${HC_CODE}', found ${hc.length}`); await sql.end({ timeout: 5 }); process.exit(2); }
  const HC_ID = Number(hc[0].id);
  const OTHER_ID = other.length === 1 ? Number(other[0].id) : null;
  if (!Number.isInteger(HC_ID) || HC_ID <= 0) { bad(`HC id not a positive integer (${hc[0].id})`); await sql.end({ timeout: 5 }); process.exit(2); }
  if (OTHER_ID !== null && HC_ID === OTHER_ID) { bad(`HC id equals 2990 id (${HC_ID}) — refusing`); await sql.end({ timeout: 5 }); process.exit(2); }
  note(`\n=== TARGET ===`);
  note(`  HC (test docs only): id=${HC_ID} code=${hc[0].code} name=${hc[0].name}`);
  note(`  2990 (NEVER touch):  ${OTHER_ID !== null ? `id=${OTHER_ID}` : 'not present'}`);

  // ── 2. Live schema ────────────────────────────────────────────────────────
  const cols = await sql`SELECT table_schema AS s, table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema IN ('scm','public')`;
  const colsByTable = new Map();
  for (const r of cols) { const k = `${r.s}.${r.t}`; if (!colsByTable.has(k)) colsByTable.set(k, new Set()); colsByTable.get(k).add(r.c); }
  const liveTables = await sql`SELECT table_schema AS s, table_name AS t FROM information_schema.tables WHERE table_schema IN ('scm','public') AND table_type='BASE TABLE'`;
  const liveSet = new Set(liveTables.map((r) => `${r.s}.${r.t}`));
  const hasCol = (key, c) => (colsByTable.get(key) || new Set()).has(c);

  const fkRows = await sql`
    SELECT ns.nspname AS cs, cl.relname AS ct, att.attname AS ccol, fns.nspname AS ps, fcl.relname AS pt
      FROM pg_constraint con
      JOIN pg_class cl ON cl.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = cl.relnamespace
      JOIN pg_class fcl ON fcl.oid = con.confrelid
      JOIN pg_namespace fns ON fns.oid = fcl.relnamespace
      JOIN unnest(con.conkey) WITH ORDINALITY AS ck(attnum, ord) ON true
      JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ck.attnum
     WHERE con.contype = 'f' AND ns.nspname IN ('scm','public') AND array_length(con.conkey,1) = 1`;
  // parentKey -> [{ childKey, childCol }]
  const childrenOf = new Map();
  for (const r of fkRows) {
    const parent = `${r.ps}.${r.pt}`;
    const child = `${r.cs}.${r.ct}`;
    if (child === parent) continue;
    if (!childrenOf.has(parent)) childrenOf.set(parent, []);
    childrenOf.get(parent).push({ childKey: child, childCol: r.ccol });
  }

  // ── 3. Seed scope: the test HEADERS ───────────────────────────────────────
  note(`\n=== TEST HEADERS (ERP-minted -2608- documents in HC) ===`);
  const scopeIds = new Map();   // "s.t" -> Set(id)
  const headerInfo = [];        // { key, label, docNos:[], rows:[...] }
  const allTestDocNos = [];
  for (const [schema, table, label, pattern] of HEADER_FAMILIES) {
    const key = `${schema}.${table}`;
    if (!liveSet.has(key)) { note(`  ${label}: table ${key} absent — skipped`); continue; }
    if (!hasCol(key, 'doc_no')) { note(`  ${label}: ${key} has no doc_no column — skipped`); continue; }
    if (!hasCol(key, 'id')) { note(`  ${label}: ${key} has no id column — cannot scope, skipped`); continue; }
    if (!hasCol(key, 'company_id')) { note(`  ${label}: ${key} has no company_id — skipped`); continue; }
    const rows = await sql`
      SELECT id::text AS id, doc_no,
             ${hasCol(key, 'status') ? sql`status` : sql`NULL AS status`},
             ${hasCol(key, 'linked_ac_docno') ? sql`linked_ac_docno` : sql`NULL AS linked_ac_docno`},
             ${hasCol(key, 'created_at') ? sql`created_at` : sql`NULL AS created_at`}
        FROM ${sql(qi(schema))}.${sql(qi(table))}
       WHERE company_id = ${HC_ID} AND doc_no LIKE ${pattern}
       ORDER BY doc_no`;
    if (!rows.length) { note(`  ${label}: none`); continue; }
    const ids = new Set(rows.map((r) => r.id));
    scopeIds.set(key, ids);
    const docNos = rows.map((r) => r.doc_no);
    allTestDocNos.push(...docNos);
    headerInfo.push({ key, label, docNos, rows });
    note(`  ${label}  (${rows.length}):`);
    for (const r of rows) note(`      ${r.doc_no}   status=${r.status ?? '-'}   ac=${r.linked_ac_docno ?? '-'}   ${r.created_at ? String(r.created_at).slice(0, 19) : ''}`);
  }
  if (!headerInfo.length) {
    note(`\n=== NO TEST DOCUMENTS FOUND — nothing to do. ===`);
    await sql.end({ timeout: 5 });
    return;
  }

  // ── 4. Expand scope to a fixpoint over the FK graph (children of scope) ────
  let changed = true;
  while (changed) {
    changed = false;
    for (const [parentKey, ids] of [...scopeIds.entries()]) {
      if (!ids.size) continue;
      const kids = childrenOf.get(parentKey) || [];
      const parentIdArr = [...ids];
      for (const { childKey, childCol } of kids) {
        if (!liveSet.has(childKey) || !hasCol(childKey, 'id')) continue; // no-id link tables handled at delete time
        const [cs, ct] = childKey.split('.');
        const found = await sql`
          SELECT id::text AS id FROM ${sql(qi(cs))}.${sql(qi(ct))}
           WHERE ${sql(qi(childCol))} = ANY(${parentIdArr})`;
        if (!found.length) continue;
        if (!scopeIds.has(childKey)) scopeIds.set(childKey, new Set());
        const set = scopeIds.get(childKey);
        let added = 0;
        for (const r of found) if (!set.has(r.id)) { set.add(r.id); added++; }
        if (added) changed = true;
      }
    }
  }

  // ── 5. Stock + outbox seeds by doc_no reference ───────────────────────────
  const docNoSeeds = [];
  for (const [schema, table, col] of STOCK_BY_DOCNO) {
    const key = `${schema}.${table}`;
    if (!liveSet.has(key) || !hasCol(key, col) || !hasCol(key, 'id')) continue;
    const rows = await sql`SELECT id::text AS id FROM ${sql(qi(schema))}.${sql(qi(table))} WHERE ${sql(qi(col))} = ANY(${allTestDocNos})${hasCol(key, 'company_id') ? sql` AND company_id = ${HC_ID}` : sql``}`;
    if (rows.length) {
      if (!scopeIds.has(key)) scopeIds.set(key, new Set());
      for (const r of rows) scopeIds.get(key).add(r.id);
      docNoSeeds.push([key, rows.length]);
    }
  }
  // Re-expand fixpoint to pull children of the stock rows (e.g. lot consumptions).
  changed = true;
  while (changed) {
    changed = false;
    for (const [parentKey, ids] of [...scopeIds.entries()]) {
      if (!ids.size) continue;
      const kids = childrenOf.get(parentKey) || [];
      const parentIdArr = [...ids];
      for (const { childKey, childCol } of kids) {
        if (!liveSet.has(childKey) || !hasCol(childKey, 'id')) continue;
        const [cs, ct] = childKey.split('.');
        const found = await sql`SELECT id::text AS id FROM ${sql(qi(cs))}.${sql(qi(ct))} WHERE ${sql(qi(childCol))} = ANY(${parentIdArr})`;
        if (!found.length) continue;
        if (!scopeIds.has(childKey)) scopeIds.set(childKey, new Set());
        const set = scopeIds.get(childKey);
        let added = 0;
        for (const r of found) if (!set.has(r.id)) { set.add(r.id); added++; }
        if (added) changed = true;
      }
    }
  }
  // Outbox rows for the test docs (deleted so the sync page stops flagging them).
  const outKey = `${OUTBOX[0]}.${OUTBOX[1]}`;
  let outboxCount = 0;
  if (liveSet.has(outKey) && hasCol(outKey, OUTBOX[2]) && hasCol(outKey, 'doc_no')) {
    const rows = await sql`SELECT doc_no FROM ${sql(qi(OUTBOX[0]))}.${sql(qi(OUTBOX[1]))} WHERE ${sql(qi(OUTBOX[2]))} = ANY(${allTestDocNos})${hasCol(outKey, 'company_id') ? sql` AND company_id = ${HC_ID}` : sql``}`;
    outboxCount = rows.length;
  }

  // ── 6. Report the full scope ──────────────────────────────────────────────
  note(`\n=== FULL SCOPE — rows that WOULD be deleted (reachable from test headers) ===`);
  let scopeTotal = 0;
  const scopeSorted = [...scopeIds.entries()].filter(([, s]) => s.size).sort((a, b) => b[1].size - a[1].size);
  for (const [key, s] of scopeSorted) { note(`  ${String(s.size).padStart(7)}  ${key}`); scopeTotal += s.size; }
  note(`  ${'-'.repeat(50)}`);
  note(`  ${String(scopeTotal).padStart(7)}  TOTAL rows across ${scopeSorted.length} tables`);
  if (docNoSeeds.length) { note(`  stock rows seeded by source_doc_no:`); for (const [k, n] of docNoSeeds) note(`      ${n}  ${k}`); }
  note(`  autocount_outbox rows for these docs (will be DELETED): ${outboxCount}`);

  // ── 7. REAL-doc invariant baseline: counts that MUST NOT change ───────────
  note(`\n=== REAL DOCUMENTS — counts that MUST stay UNCHANGED ===`);
  const realBefore = new Map();
  for (const [schema, table, label, pattern] of HEADER_FAMILIES) {
    const key = `${schema}.${table}`;
    if (!liveSet.has(key) || !hasCol(key, 'doc_no') || !hasCol(key, 'company_id')) continue;
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM ${sql(qi(schema))}.${sql(qi(table))} WHERE company_id = ${HC_ID} AND doc_no NOT LIKE ${pattern}`;
    realBefore.set(key, n);
    note(`  ${label.padEnd(4)} ${key.padEnd(28)} real HC docs = ${n}  (must stay ${n})`);
  }

  // ── 8. 2990 baseline for every touched table ──────────────────────────────
  const otherBefore = new Map();
  if (OTHER_ID !== null) {
    for (const [key] of scopeSorted) {
      if (!hasCol(key, 'company_id')) { otherBefore.set(key, null); continue; }
      const [s, t] = key.split('.');
      const [{ n }] = await sql`SELECT count(*)::int AS n FROM ${sql(qi(s))}.${sql(qi(t))} WHERE company_id = ${OTHER_ID}`;
      otherBefore.set(key, n);
    }
  }

  // ── 9. Delete order: topological over the induced FK subgraph ──────────────
  const scopeKeys = scopeSorted.map(([k]) => k);
  const scopeKeySet = new Set(scopeKeys);
  const intraEdges = [];
  for (const r of fkRows) {
    const child = `${r.cs}.${r.ct}`;
    const parent = `${r.ps}.${r.pt}`;
    if (child !== parent && scopeKeySet.has(child) && scopeKeySet.has(parent)) intraEdges.push([child, parent]);
  }
  const { order: topoOrder, remaining: cycle } = topoDeleteOrder(scopeKeys, intraEdges);
  if (cycle.length) note(`\n  ⚠ FK cycle among scoped tables: ${cycle.join(', ')} — apply appends them and relies on rollback if it truly blocks.`);

  if (!APPLY) {
    note(`\n=== PLAN COMPLETE — nothing was written. ===`);
    note(`  Would delete ${scopeTotal} rows (+ ${outboxCount} outbox) for ${allTestDocNos.length} test documents.`);
    note(`  To execute:  MODE=apply CONFIRM="${CONFIRM_PHRASE}"`);
    await sql.end({ timeout: 5 });
    return;
  }

  // ── 10. APPLY: backup, then delete children->parents in ONE transaction ────
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const manifest = { company: { id: HC_ID }, when: new Date().toISOString(), testDocNos: allTestDocNos, tables: {} };
  for (const [key, s] of scopeSorted) {
    const [schema, table] = key.split('.');
    const rows = await sql`SELECT * FROM ${sql(qi(schema))}.${sql(qi(table))} WHERE id = ANY(${[...s]})`;
    fs.writeFileSync(path.join(BACKUP_DIR, `${key}.json`), JSON.stringify(rows, null, 0));
    manifest.tables[key] = rows.length;
  }
  if (outboxCount) {
    const rows = await sql`SELECT * FROM ${sql(qi(OUTBOX[0]))}.${sql(qi(OUTBOX[1]))} WHERE ${sql(qi(OUTBOX[2]))} = ANY(${allTestDocNos})`;
    fs.writeFileSync(path.join(BACKUP_DIR, `${outKey}.json`), JSON.stringify(rows, null, 0));
    manifest.tables[`${outKey} (by doc_no)`] = rows.length;
  }
  fs.writeFileSync(path.join(BACKUP_DIR, '_manifest.json'), JSON.stringify(manifest, null, 2));
  note(`\n=== BACKUP written to ${BACKUP_DIR} (${Object.keys(manifest.tables).length} table dumps) ===`);

  const deleteOrder = [...topoOrder, ...cycle];
  let deletedTotal = 0;
  await sql.begin(async (tx) => {
    for (const key of deleteOrder) {
      const s = scopeIds.get(key);
      if (!s || !s.size) continue;
      const [schema, table] = key.split('.');
      const del = await tx`DELETE FROM ${tx(qi(schema))}.${tx(qi(table))} WHERE id = ANY(${[...s]})`;
      deletedTotal += del.count;
    }
    // Outbox by doc_no (no id-scope needed; these rows ARE the test docs' sends).
    if (outboxCount) {
      const del = await tx`DELETE FROM ${tx(qi(OUTBOX[0]))}.${tx(qi(OUTBOX[1]))} WHERE ${tx(qi(OUTBOX[2]))} = ANY(${allTestDocNos})${hasCol(outKey, 'company_id') ? tx` AND company_id = ${HC_ID}` : tx``}`;
      deletedTotal += del.count;
      note(`  outbox: deleted ${del.count} row(s) for the test docs`);
    }
    note(`  deleted ${deletedTotal} rows in transaction`);

    // In-transaction 2990 guard: no touched table's 2990 count may move.
    if (OTHER_ID !== null) {
      for (const [key, was] of otherBefore) {
        if (was === null) continue;
        const [s, t] = key.split('.');
        const [{ n }] = await tx`SELECT count(*)::int AS n FROM ${tx(qi(s))}.${tx(qi(t))} WHERE company_id = ${OTHER_ID}`;
        if (n !== was) throw new Error(`2990 count MOVED on ${key} (was ${was}, now ${n}) — rolling back`);
      }
    }
    // In-transaction REAL-doc guard: no real HC document may be gone.
    for (const [schema, table, , pattern] of HEADER_FAMILIES) {
      const key = `${schema}.${table}`;
      if (!realBefore.has(key)) continue;
      const [{ n }] = await tx`SELECT count(*)::int AS n FROM ${tx(qi(schema))}.${tx(qi(table))} WHERE company_id = ${HC_ID} AND doc_no NOT LIKE ${pattern}`;
      if (n !== realBefore.get(key)) throw new Error(`REAL ${key} count MOVED (was ${realBefore.get(key)}, now ${n}) — rolling back`);
    }
    note(`  in-transaction guards passed: real HC docs intact, 2990 unchanged.`);
  });

  // ── 11. VERIFY on a FRESH connection ──────────────────────────────────────
  await sql.end({ timeout: 5 });
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    const problems = [];
    for (const { key, label, docNos } of headerInfo.map((h) => ({ key: h.key, label: h.label, docNos: h.docNos }))) {
      const [schema, table] = key.split('.');
      const [{ n }] = await check`SELECT count(*)::int AS n FROM ${check(qi(schema))}.${check(qi(table))} WHERE company_id = ${HC_ID} AND doc_no = ANY(${docNos})`;
      if (n !== 0) problems.push(`${label} ${key}: ${n} test header(s) still present`);
    }
    for (const [schema, table, label, pattern] of HEADER_FAMILIES) {
      const key = `${schema}.${table}`;
      if (!realBefore.has(key)) continue;
      const [{ n }] = await check`SELECT count(*)::int AS n FROM ${check(qi(schema))}.${check(qi(table))} WHERE company_id = ${HC_ID} AND doc_no NOT LIKE ${pattern}`;
      const was = realBefore.get(key);
      note(`  ${label.padEnd(4)} real HC docs: ${n} (want ${was})`);
      if (n !== was) problems.push(`REAL ${key} CHANGED: was ${was}, now ${n}`);
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
