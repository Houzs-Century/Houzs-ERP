#!/usr/bin/env node
/* A supplier bound to the same item twice. Find every such pair, show them,
   delete the NEWER row — and refuse any group where that is a business choice
   rather than a cleanup.

   WHY. scm.supplier_material_bindings has no unique index on (company_id,
   supplier_id, material_kind, item_code), and MRP lists every binding row, so a
   duplicate shows the same supplier twice for one item. PR #5486 stopped the
   routes creating new ones and added the read-only
   check-supplier-binding-duplicates.mjs; its production run 42643486780 found
   one group. The unique index can only be added once the table has none.

   WHAT COUNTS AS A REFERENCE is read from the LIVE catalogue, not from this
   repo: every foreign key whose target is supplier_material_bindings, plus every
   column named binding_id in the scm / public schemas whether or not it carries
   a key (purchase_order_items.binding_id has no CREATE in any migration file
   here). Each is counted per row id.

   A GROUP IS REFUSED, whole, when any row in it:
     - is the main supplier for the item (deleting it changes MRP's default);
     - is referenced by anything found above (a PO line would lose its binding,
       or a FK would null it / block the delete);
     - differs from the others in unit_price_sen, price_matrix or supplier_sku
       (which price is right is the owner's call, not this script's).
   A refused group is printed in full and nothing in it is touched.

   Otherwise only the NEWEST row by created_at (ties broken by id) is deleted;
   the oldest survives. Price history is keyed on (company, supplier, kind,
   item), not on binding id, so it is untouched and still matches the survivor.

   MODE=plan (default) prints every group and writes nothing.
   MODE=apply needs CONFIRM="DELETE NEWER DUPLICATE BINDINGS", deletes one row at
   a time with every refusal condition re-asserted in the DELETE itself, and then
   re-reads on a FRESH connection: each deleted id is gone, each survivor is
   still there with its group now of size 1.

   RE-RUN: inert once a group is down to one row — it no longer matches
   HAVING COUNT(*) > 1. A group of three loses one row per run. */
import "./lib/public-log-guard.mjs";
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'DELETE NEWER DUPLICATE BINDINGS';

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1, connect_timeout: 60 });

const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;

async function referenceColumns(client) {
  const fks = await client`
    SELECT n.nspname AS schema, c.relname AS tbl, a.attname AS col, con.conname AS via
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
     WHERE con.contype = 'f'
       AND con.confrelid = 'scm.supplier_material_bindings'::regclass`;
  const named = await client`
    SELECT c.table_schema AS schema, c.table_name AS tbl, c.column_name AS col
      FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.column_name = 'binding_id'
       AND c.table_schema IN ('scm', 'public')
       AND t.table_type = 'BASE TABLE'`;
  const seen = new Map();
  for (const r of fks) seen.set(`${r.schema}.${r.tbl}.${r.col}`, { ...r, via: `FK ${r.via}` });
  for (const r of named) {
    const k = `${r.schema}.${r.tbl}.${r.col}`;
    if (!seen.has(k)) seen.set(k, { ...r, via: 'column named binding_id, no FK' });
  }
  return [...seen.values()];
}

async function countRefs(client, refCols, id) {
  const out = [];
  for (const r of refCols) {
    const [row] = await client.unsafe(
      `SELECT COUNT(*)::int AS n FROM ${ident(r.schema)}.${ident(r.tbl)} WHERE ${ident(r.col)}::text = $1`, [id]);
    if (row.n) out.push(`${r.schema}.${r.tbl}.${r.col}=${row.n}`);
  }
  return out;
}

const readGroups = (client) => client`
  SELECT b.company_id, b.supplier_id::text AS supplier_id, s.code AS supplier_code,
         b.material_kind::text AS material_kind, b.item_code,
         json_agg(json_build_object(
           'id', b.id::text,
           'created_at', b.created_at,
           'unit_price_sen', b.unit_price_sen,
           'price_matrix', b.price_matrix,
           'supplier_sku', b.supplier_sku,
           'is_main', COALESCE(b.is_main_supplier, false)
         ) ORDER BY b.created_at, b.id) AS rows
    FROM scm.supplier_material_bindings b
    LEFT JOIN scm.suppliers s ON s.id = b.supplier_id
   GROUP BY b.company_id, b.supplier_id, s.code, b.material_kind, b.item_code
  HAVING COUNT(*) > 1
   ORDER BY b.company_id, s.code, b.item_code`;

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'}`);

  const refCols = await referenceColumns(sql);
  note(`\n=== WHAT CAN POINT AT A BINDING ID (live catalogue) ===`);
  for (const r of refCols) note(`  ${r.schema}.${r.tbl}.${r.col}  (${r.via})`);
  if (!refCols.length) note('  none found');

  const groups = await readGroups(sql);
  note(`\n=== DUPLICATE GROUPS: ${groups.length} ===`);
  if (!groups.length) { note('Nothing to repair.'); await sql.end({ timeout: 5 }); return; }

  const plan = [], refused = [];
  for (const g of groups) {
    const label = `co=${g.company_id} supplier=${g.supplier_code ?? g.supplier_id} ${g.material_kind} ${g.item_code}`;
    note(`\n  ${label}  x${g.rows.length}`);
    const why = [];
    for (const r of g.rows) {
      r.refs = await countRefs(sql, refCols, r.id);
      note(`    ${r.id}  created_at=${new Date(r.created_at).toISOString()}  unit_price_sen=${r.unit_price_sen ?? 'null'}  price_matrix=${r.price_matrix == null ? 'null' : JSON.stringify(r.price_matrix)}  supplier_sku=${r.supplier_sku ?? 'null'}  is_main=${r.is_main}  refs=${r.refs.length ? r.refs.join(',') : 'none'}`);
      if (r.is_main) why.push(`${r.id} is the main supplier`);
      if (r.refs.length) why.push(`${r.id} is referenced (${r.refs.join(', ')})`);
    }
    const first = g.rows[0];
    for (const f of ['unit_price_sen', 'price_matrix', 'supplier_sku']) {
      if (g.rows.some((r) => !same(r[f], first[f]))) why.push(`rows differ in ${f}`);
    }
    if (why.length) {
      bad(`    REFUSED — ${why.join('; ')}`);
      refused.push({ label, why });
      continue;
    }
    const newest = g.rows[g.rows.length - 1];
    note(`    WOULD DELETE ${newest.id} (newest); keeps ${first.id}`);
    plan.push({ label, del: newest.id, keep: first.id, g });
  }
  note(`\n  deletable: ${plan.length}   refused: ${refused.length}`);

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  note(`\n=== DELETING ${plan.length} ROW(S) ===`);
  const done = [];
  for (const p of plan) {
    const stillRefd = await countRefs(sql, refCols, p.del);
    if (stillRefd.length) { bad(`  SKIP ${p.del} — now referenced (${stillRefd.join(', ')})`); continue; }
    const back = await sql`
      DELETE FROM scm.supplier_material_bindings d
       WHERE d.id = ${p.del}::uuid
         AND COALESCE(d.is_main_supplier, false) = false
         AND EXISTS (
           SELECT 1 FROM scm.supplier_material_bindings k
            WHERE k.id = ${p.keep}::uuid
              AND k.company_id = d.company_id AND k.supplier_id = d.supplier_id
              AND k.material_kind = d.material_kind AND k.item_code = d.item_code
              AND k.unit_price_sen IS NOT DISTINCT FROM d.unit_price_sen
              AND k.price_matrix IS NOT DISTINCT FROM d.price_matrix
              AND k.supplier_sku IS NOT DISTINCT FROM d.supplier_sku)
      RETURNING d.id::text AS id`;
    note(`  ${back.length ? 'OK  ' : 'SKIP'} ${p.del}  ${p.label}`);
    if (back.length) done.push(p);
  }
  note(`  deleted: ${done.length} of ${plan.length}`);

  await sql.end({ timeout: 5 });
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1, connect_timeout: 60 });
  let failed = false;
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    for (const p of done) {
      const [gone] = await check`SELECT COUNT(*)::int AS n FROM scm.supplier_material_bindings WHERE id = ${p.del}::uuid`;
      const [kept] = await check`
        SELECT k.id::text AS id,
               (SELECT COUNT(*)::int FROM scm.supplier_material_bindings x
                 WHERE x.company_id = k.company_id AND x.supplier_id = k.supplier_id
                   AND x.material_kind = k.material_kind AND x.item_code = k.item_code) AS group_size
          FROM scm.supplier_material_bindings k WHERE k.id = ${p.keep}::uuid`;
      const ok = gone.n === 0 && kept?.id === p.keep && kept.group_size === p.g.rows.length - 1;
      if (!ok) failed = true;
      (ok ? note : bad)(`  ${p.label}: deleted row present=${gone.n}, survivor ${kept ? 'present' : 'MISSING'}, group size now ${kept?.group_size ?? '?'} (was ${p.g.rows.length})`);
    }
    const left = await readGroups(check);
    note(`  duplicate groups remaining: ${left.length} (was ${groups.length}; ${refused.length} refused)`);
  } finally {
    await check.end({ timeout: 5 });
  }
  if (failed) process.exit(1);
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
