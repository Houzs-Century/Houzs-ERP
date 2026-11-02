#!/usr/bin/env node
/* One main supplier per item, the rest of them (owner 2026-10-31: "这些看最近跟
   谁order就是谁"). repair-sofa-main-supplier.mjs settled the sofas that had
   Hookka Industries among their mains; this settles every other item that still
   has more than one main.

   THE RULE. The item's main becomes the supplier of its LATEST purchase order
   (po_date, then created_at; DRAFT and CANCELLED left out), provided that
   supplier has a binding for the item. An item never ordered on its own (most
   sofa modules and sizes) takes the latest PO of any item of the SAME MODEL
   (mfg_products.model_id). That binding is set main and every other
   main binding on the item is set to not-main; bindings, prices and SKUs stay.
   An item with no such PO is LISTED and left for the owner.

   MODE=plan (default) lists every item with the PO it was decided by, writes
   nothing. MODE=apply needs CONFIRM="MAIN FROM LATEST PO", writes by binding
   id, and re-reads on a fresh connection that each decided item has exactly one
   main and that it is the chosen supplier.

   REVERSAL: the plan prints every binding id it promotes and demotes; flip
   is_main_supplier back on those ids to undo.
   RE-RUN: inert. Keyed on items with more than one main, which the write ends. */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'MAIN FROM LATEST PO';

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

/** Items with more than one main, every binding of each, and the latest PO's supplier. */
const plan = (client) => client`
  WITH multi AS (
    SELECT material_kind, item_code FROM scm.supplier_material_bindings
     WHERE company_id = ${CO} AND is_main_supplier = true
     GROUP BY material_kind, item_code HAVING COUNT(*) > 1
  ), latest AS (
    SELECT DISTINCT ON (i.item_code) i.item_code, po.supplier_id, po.po_number, po.po_date::text AS po_date
      FROM scm.purchase_order_items i JOIN scm.purchase_orders po ON po.id = i.purchase_order_id
     WHERE po.company_id = ${CO} AND po.status NOT IN ('DRAFT', 'CANCELLED')
       AND i.item_code IN (SELECT item_code FROM multi)
     ORDER BY i.item_code, po.po_date DESC, po.created_at DESC
  ), mdl AS (
    SELECT m.item_code, p.model_id FROM multi m
      JOIN scm.mfg_products p ON p.code = m.item_code AND p.company_id = ${CO}
     WHERE p.model_id IS NOT NULL
  ), latest_model AS (
    SELECT DISTINCT ON (p.model_id) p.model_id, po.supplier_id, po.po_number, po.po_date::text AS po_date, i.item_code AS via
      FROM scm.purchase_order_items i JOIN scm.purchase_orders po ON po.id = i.purchase_order_id
      JOIN scm.mfg_products p ON p.code = i.item_code AND p.company_id = ${CO}
     WHERE po.company_id = ${CO} AND po.status NOT IN ('DRAFT', 'CANCELLED')
       AND p.model_id IN (SELECT model_id FROM mdl)
     ORDER BY p.model_id, po.po_date DESC, po.created_at DESC
  )
  SELECT m.material_kind, m.item_code,
         COALESCE(l.supplier_id, lm.supplier_id)::text AS latest_supplier_id,
         COALESCE(l.po_number, lm.po_number) AS po_number, COALESCE(l.po_date, lm.po_date) AS po_date,
         CASE WHEN l.supplier_id IS NULL AND lm.supplier_id IS NOT NULL THEN lm.via END AS via,
         json_agg(json_build_object('id', b.id::text, 'supplierId', b.supplier_id::text, 'supplier', s.name, 'main', b.is_main_supplier) ORDER BY s.name) AS bindings
    FROM multi m
    JOIN scm.supplier_material_bindings b ON b.company_id = ${CO} AND b.material_kind = m.material_kind AND b.item_code = m.item_code
    JOIN scm.suppliers s ON s.id = b.supplier_id
    LEFT JOIN latest l ON l.item_code = m.item_code
    LEFT JOIN mdl d ON d.item_code = m.item_code
    LEFT JOIN latest_model lm ON lm.model_id = d.model_id
   GROUP BY m.material_kind, m.item_code, l.supplier_id, l.po_number, l.po_date, lm.supplier_id, lm.po_number, lm.po_date, lm.via
   ORDER BY m.item_code`;

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO}`);
  const rows = await plan(sql);
  const fix = [], leave = [];
  for (const r of rows) {
    const pick = r.bindings.find((b) => b.supplierId === r.latest_supplier_id);
    const mains = r.bindings.filter((b) => b.main).map((b) => b.supplier).join(' / ');
    if (!pick) { leave.push({ ...r, mains, why: r.po_number ? `latest PO ${r.po_number} is with a supplier not bound to it` : 'no purchase order for it or its model' }); continue; }
    fix.push({ ...r, pick, demote: r.bindings.filter((b) => b.main && b !== pick) });
  }

  note(`\n=== MAIN SET FROM THE LATEST PO: ${fix.length} item(s) ===`);
  for (const r of fix) {
    note(`  ${r.item_code.padEnd(20)} ${r.pick.supplier}  (${r.po_number}, ${r.po_date}${r.via ? `, same model via ${r.via}` : ''})  promote [${r.pick.main ? 'already main' : r.pick.id}]; demote ${r.demote.map((b) => `${b.supplier} [${b.id}]`).join(', ') || '-'}`);
  }
  note(`\n=== LEFT FOR THE OWNER: ${leave.length} item(s) ===`);
  for (const r of leave) note(`  ${r.item_code.padEnd(20)} ${r.mains} — ${r.why}`);

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  note(`\n=== WRITING ===`);
  let wrote = 0, planned = 0;
  for (const r of fix) {
    await sql.begin(async (tx) => {
      for (const b of r.demote) {
        planned += 1;
        const back = await tx`UPDATE scm.supplier_material_bindings SET is_main_supplier = false
                               WHERE id = ${b.id} AND company_id = ${CO} AND is_main_supplier = true RETURNING id`;
        wrote += back.length;
      }
      if (!r.pick.main) {
        planned += 1;
        const back = await tx`UPDATE scm.supplier_material_bindings SET is_main_supplier = true
                               WHERE id = ${r.pick.id} AND company_id = ${CO} RETURNING id`;
        wrote += back.length;
      }
    });
    note(`  OK ${r.item_code} -> ${r.pick.supplier}`);
  }
  note(`  written: ${wrote} of ${planned}`);

  await sql.end({ timeout: 5 });
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    let wrong = 0;
    for (const r of fix) {
      const mains = await check`
        SELECT b.supplier_id::text AS id, s.name FROM scm.supplier_material_bindings b JOIN scm.suppliers s ON s.id = b.supplier_id
         WHERE b.company_id = ${CO} AND b.material_kind = ${r.material_kind} AND b.item_code = ${r.item_code} AND b.is_main_supplier = true`;
      if (mains.length !== 1 || mains[0].id !== r.pick.supplierId) { wrong += 1; bad(`  ${r.item_code}: mains are now ${mains.map((m) => m.name).join(' / ') || '(none)'}`); }
    }
    const left = await check`
      SELECT COUNT(*)::int AS n FROM (SELECT 1 FROM scm.supplier_material_bindings
        WHERE company_id = ${CO} AND is_main_supplier = true GROUP BY material_kind, item_code HAVING COUNT(*) > 1) x`;
    note(`  decided items with exactly one main, the latest-PO supplier: ${fix.length - wrong} of ${fix.length}`);
    note(`  items still with more than one main: ${left[0].n} (the ${leave.length} left for the owner)`);
    if (wrong) process.exitCode = 1;
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
