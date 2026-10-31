#!/usr/bin/env node
/* The last HOUZS items with more than one main supplier, decided by the owner
   (2026-10-31: "5152 red sofa / ricardo hookka / divan only hookka dont have
   then nb"). The latest-PO rule (repair-main-supplier-latest-po.mjs) could not
   decide these: no PO for them or their model, or a latest PO with a supplier
   not bound to the item.

   Each pick names the supplier by the start of its name. The chosen binding is
   set main and every other main binding on the item is set to not-main;
   bindings, prices and SKUs stay. A pick whose supplier is not bound to the
   item is refused and printed, never guessed.

   MODE=plan (default) prints each item's mains and the pick, writes nothing.
   MODE=apply needs CONFIRM="OWNER PICKS", writes by binding id in one
   transaction per item, and re-reads on a fresh connection that each item has
   exactly one main and that it is the pick.

   REVERSAL: the plan prints every binding id it promotes and demotes; flip
   is_main_supplier back on those ids to undo.
   RE-RUN: inert. An item already settled on its pick is reported and skipped. */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = 1;
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'OWNER PICKS';
const PICKS = [
  ['5152-1S', /^RED SOFA\b/i],
  ['RICARDO-(SK)', /^HOOKKA INDUSTRIES\b/i],
  ['RICARDO-(SP)', /^HOOKKA INDUSTRIES\b/i],
  ['DIVAN ONLY', /^NB FURNITURE\b/i],
];

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

const bindingsOf = (client, code) => client`
  SELECT b.id::text AS id, b.material_kind, b.is_main_supplier AS main, s.name AS supplier
    FROM scm.supplier_material_bindings b JOIN scm.suppliers s ON s.id = b.supplier_id
   WHERE b.company_id = ${CO} AND b.item_code = ${code} AND b.material_kind = 'mfg_product'
   ORDER BY s.name`;

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO}`);
  const work = [];
  let refused = 0;
  for (const [code, want] of PICKS) {
    const bs = await bindingsOf(sql, code);
    const pick = bs.filter((b) => want.test(b.supplier));
    const mains = bs.filter((b) => b.main);
    if (pick.length !== 1) { refused += 1; bad(`  ${code}: ${pick.length} bindings match ${want} among ${bs.map((b) => b.supplier).join(' / ') || '(none)'} — refused`); continue; }
    const demote = mains.filter((b) => b.id !== pick[0].id);
    if (pick[0].main && !demote.length) { note(`  ${code}: already only ${pick[0].supplier} — skipped`); continue; }
    work.push({ code, pick: pick[0], demote });
    note(`  ${code.padEnd(14)} mains now ${mains.map((b) => b.supplier).join(' / ')} -> ${pick[0].supplier} [${pick[0].main ? 'already main' : pick[0].id}]; demote ${demote.map((b) => `${b.supplier} [${b.id}]`).join(', ') || '-'}`);
  }

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written (${work.length} to set, ${refused} refused). Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  let wrote = 0, planned = 0;
  for (const w of work) {
    await sql.begin(async (tx) => {
      for (const b of w.demote) {
        planned += 1;
        wrote += (await tx`UPDATE scm.supplier_material_bindings SET is_main_supplier = false
                            WHERE id = ${b.id} AND company_id = ${CO} AND is_main_supplier = true RETURNING id`).length;
      }
      if (!w.pick.main) {
        planned += 1;
        wrote += (await tx`UPDATE scm.supplier_material_bindings SET is_main_supplier = true
                            WHERE id = ${w.pick.id} AND company_id = ${CO} RETURNING id`).length;
      }
    });
  }
  note(`  written: ${wrote} of ${planned}`);

  await sql.end({ timeout: 5 });
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    let wrong = 0;
    for (const w of work) {
      const mains = (await bindingsOf(check, w.code)).filter((b) => b.main);
      const ok = mains.length === 1 && mains[0].id === w.pick.id;
      if (!ok) wrong += 1;
      (ok ? note : bad)(`  ${w.code}: main is ${mains.map((b) => b.supplier).join(' / ') || '(none)'}`);
    }
    const left = await check`
      SELECT COUNT(*)::int AS n FROM (SELECT 1 FROM scm.supplier_material_bindings
        WHERE company_id = ${CO} AND is_main_supplier = true GROUP BY material_kind, item_code HAVING COUNT(*) > 1) x`;
    note(`  items set to the owner's pick: ${work.length - wrong} of ${work.length}`);
    note(`  items in the company still with more than one main: ${left[0].n}`);
    if (wrong || refused) process.exitCode = 1;
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
