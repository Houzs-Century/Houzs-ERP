#!/usr/bin/env node
/* Sales Order lines whose item_group disagrees with their SKU's category.

   WHY. The SKU decides a line's group (docs/bugs/0514), and the group decides
   whether company 1 hard-binds the line to its own PO (isHardBoundLine). An
   approved amendment that swapped the code kept the OLD line's group: on
   HC-SO-012243 SQUARE PILLOW (Sofa Accessory) became AMN-SOFA PILLOW (an
   Accessory, pooled) but stayed `fabric_accessory`, so MRP read 4 SHORT
   beside 78 in stock. The apply is fixed in lib/so-revision.ts; this restamps
   the lines it already wrote.

   SCOPE. Lines not cancelled, on an SO not CANCELLED / CLOSED / DELIVERED /
   COMPLETED. A catalogued SKU with a category is required; a line whose code
   is not in the catalogue is left alone.

   MODE=plan (default) lists every mismatch and writes nothing.
   MODE=apply needs CONFIRM="RESTAMP SO LINE GROUPS" and writes ONLY the lines
   on DOC_NOS (comma-separated doc numbers): the plan is a survey, the apply is
   a decision per order. A fresh connection then re-reads every written line and
   asserts its stored group equals its SKU's category.

   GROUP ONLY. description2 is not rebuilt: the printed summary is built from
   the line's variants, and the lines this is for carry no attribute that the
   old and new group summarise differently. Check the plan before naming a line
   whose variants hold a fabric or a size.

   AFTER AN APPLY. MRP reads the new group on its next live read or snapshot
   (15 minutes, or Regenerate). The line's stored stock_status moves only when
   the stock allocator next runs (its cron, or recompute-so-allocation).

   COMPANY (default 1). RE-RUN: inert, a restamped line no longer mismatches. */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'RESTAMP SO LINE GROUPS';
const DOC_NOS = String(process.env.DOC_NOS || '').split(',').map((s) => s.trim()).filter(Boolean);

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) { bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`); process.exit(2); }
if (APPLY && DOC_NOS.length === 0) { bad('MODE=apply requires DOC_NOS'); process.exit(2); }

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
let written = [];
try {
  const rows = await sql`
    SELECT i.id::text, i.doc_no, i.item_code, i.item_group::text AS item_group,
           lower(btrim(p.category::text)) AS sku_group, i.qty, s.status::text AS so_status
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no AND s.company_id = ${CO}
      JOIN scm.mfg_products p ON p.code = i.item_code AND p.company_id = ${CO}
     WHERE i.company_id = ${CO}
       AND coalesce(i.cancelled, false) = false
       AND s.status::text NOT IN ('CANCELLED', 'CLOSED', 'DELIVERED', 'COMPLETED')
       AND btrim(coalesce(p.category::text, '')) <> ''
       AND lower(btrim(p.category::text)) IS DISTINCT FROM lower(coalesce(i.item_group::text, ''))
     ORDER BY i.doc_no, i.line_no`;
  note(`company ${CO}: ${rows.length} open SO line(s) whose group differs from the SKU's category`);
  for (const r of rows) {
    note(`  ${r.doc_no} [${r.so_status}]  ${r.item_code}  ${r.item_group ?? '(none)'} -> ${r.sku_group}  qty ${r.qty}  ${r.id}`);
  }
  if (!APPLY) { note('MODE=plan, nothing written.'); process.exit(0); }

  const target = rows.filter((r) => DOC_NOS.includes(r.doc_no));
  if (target.length === 0) { note(`no mismatched line on ${DOC_NOS.join(', ')}, nothing to write.`); process.exit(0); }
  await sql.begin(async (tx) => {
    for (const r of target) {
      const res = await tx`UPDATE scm.mfg_sales_order_items SET item_group = ${r.sku_group}
        WHERE id = ${r.id}::uuid AND company_id = ${CO} AND item_group::text IS NOT DISTINCT FROM ${r.item_group}`;
      if (res.count !== 1) throw new Error(`line ${r.id} moved since the read (${res.count} rows), rolled back`);
      note(`  wrote ${r.doc_no} ${r.item_code}: ${r.item_group} -> ${r.sku_group}`);
    }
  });
  written = target;
} finally {
  await sql.end();
}

const fresh = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
try {
  const back = await fresh`
    SELECT i.id::text, i.item_group::text AS item_group FROM scm.mfg_sales_order_items i
     WHERE i.company_id = ${CO} AND i.id = ANY(${written.map((r) => r.id)}::uuid[])`;
  const byId = new Map(back.map((r) => [r.id, r.item_group]));
  const wrong = written.filter((r) => byId.get(r.id) !== r.sku_group);
  for (const r of wrong) bad(`re-read ${r.doc_no} ${r.item_code}: stored ${byId.get(r.id) ?? '(missing)'}, expected ${r.sku_group}`);
  if (wrong.length) process.exit(1);
  note(`verified on a fresh connection: ${written.length} line(s) now carry their SKU's group`);
} finally {
  await fresh.end();
}
