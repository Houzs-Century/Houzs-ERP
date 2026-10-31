#!/usr/bin/env node
/* One main supplier per item (owner 2026-10-31: "main supplier 只可以一个 ...
   sofa 如果有两个 以 hookka industries 为准").

   THE SHAPE. The batch bind (POST /suppliers/:id/bindings/batch) inserted
   `is_main_supplier = true` without demoting the item's existing main, so an
   import left items with two or three mains. Every reader takes "the first main
   it sees", so which supplier a PO or a cost came from was a coin toss. A live
   read on 2026-10-31 found 46 such items in HOUZS and 37 in 2990.

   WHAT THIS FIXES, and only this: a SOFA item (mfg_products.category = 'SOFA'
   in the same company) with more than one main, one of which is HOOKKA
   INDUSTRIES. Hookka Industries stays main; every other main binding on that
   item is set to not-main. The binding itself, its price and its SKU stay.
   Anything else with more than one main is LISTED and left for the owner.

   MODE=plan (default) lists every item and writes nothing.
   MODE=apply needs CONFIRM="ONE MAIN SUPPLIER", demotes by binding id, and
   re-reads on a fresh connection that each fixed item now has exactly one main
   and that it is Hookka Industries.

   REVERSAL: the plan prints every demoted binding id; set is_main_supplier =
   true on those ids to undo.
   RE-RUN: inert. Keyed on items with more than one main, which the demote ends. */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'ONE MAIN SUPPLIER';
const KEEP = /^HOOKKA INDUSTRIES\b/i;

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

/** Every item in the company with more than one main binding, with its mains. */
const multiMain = (client) => client`
  SELECT b.material_kind, b.item_code, p.category,
         json_agg(json_build_object('id', b.id::text, 'supplier', s.name) ORDER BY s.name) AS mains
    FROM scm.supplier_material_bindings b
    JOIN scm.suppliers s ON s.id = b.supplier_id
    LEFT JOIN scm.mfg_products p ON p.code = b.item_code AND p.company_id = b.company_id
   WHERE b.company_id = ${CO} AND b.is_main_supplier = true
   GROUP BY b.material_kind, b.item_code, p.category
  HAVING COUNT(*) > 1
   ORDER BY p.category NULLS LAST, b.item_code`;

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO}`);
  const rows = await multiMain(sql);
  const fix = [], leave = [];
  for (const r of rows) {
    const keep = r.mains.filter((m) => KEEP.test(m.supplier));
    if (r.category === 'SOFA' && keep.length === 1) fix.push({ ...r, keep: keep[0], demote: r.mains.filter((m) => m !== keep[0]) });
    else leave.push(r);
  }

  note(`\n=== SOFA, HOOKKA INDUSTRIES KEPT AS MAIN: ${fix.length} item(s) ===`);
  for (const r of fix) note(`  ${r.item_code.padEnd(22)} keep ${r.keep.supplier}; demote ${r.demote.map((m) => `${m.supplier} [${m.id}]`).join(', ')}`);
  note(`\n=== LEFT FOR THE OWNER (not sofa, or no Hookka Industries among the mains): ${leave.length} item(s) ===`);
  for (const r of leave) note(`  ${r.item_code.padEnd(22)} ${String(r.category ?? '(no product)').padEnd(10)} ${r.mains.map((m) => m.supplier).join(' / ')}`);

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  note(`\n=== DEMOTING ===`);
  let wrote = 0;
  for (const r of fix) {
    for (const m of r.demote) {
      const back = await sql`
        UPDATE scm.supplier_material_bindings SET is_main_supplier = false
         WHERE id = ${m.id} AND company_id = ${CO} AND is_main_supplier = true
        RETURNING id::text AS id`;
      wrote += back.length;
      note(`  ${back.length ? 'OK  ' : 'SKIP'} ${r.item_code} ${m.supplier} [${m.id}]`);
    }
  }
  note(`  written: ${wrote} of ${fix.reduce((s, r) => s + r.demote.length, 0)}`);

  await sql.end({ timeout: 5 });
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    let wrong = 0;
    for (const r of fix) {
      const mains = await check`
        SELECT s.name FROM scm.supplier_material_bindings b JOIN scm.suppliers s ON s.id = b.supplier_id
         WHERE b.company_id = ${CO} AND b.material_kind = ${r.material_kind} AND b.item_code = ${r.item_code} AND b.is_main_supplier = true`;
      if (mains.length !== 1 || !KEEP.test(mains[0].name)) { wrong += 1; bad(`  ${r.item_code}: mains are now ${mains.map((m) => m.name).join(' / ') || '(none)'}`); }
    }
    const left = await multiMain(check);
    note(`  fixed items with exactly one main, Hookka Industries: ${fix.length - wrong} of ${fix.length}`);
    note(`  items still with more than one main: ${left.length} (the ${leave.length} left for the owner)`);
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
