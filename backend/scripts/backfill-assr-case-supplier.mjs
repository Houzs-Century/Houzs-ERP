#!/usr/bin/env node
/* HC-0130 — fill the Supplier on open service cases the way a new case gets it
   today: the PO raised from the case item's SO line, else the SO item's main
   bound supplier, else AutoCount MainSupplier (stock_items cache). The rule is
   lib/assr-supplier-pick.mjs, the Node twin of resolveCreditorForCase.

   WHY. A case's supplier is resolved once, at creation (and when its item code
   changes). Cases created before #4768 / #4826 went live never saw the PO or
   SO step, so they show "—" in the ASSR List until someone presses
   "Resolve now" on each one.

   SCOPE. Not archived, stage not completed / voided, an item code, and
   creditor_source NULL or 'auto'. NEVER 'manual' (a person chose it), and not
   'po' / 'so' (already from the order). Each case is read inside ITS OWN
   company_id; a case with no company_id only gets the AutoCount step, which is
   keyed by item code alone, like the Worker.

   MODE=plan (default) lists every case it would change, old -> new, and writes
   nothing. MODE=apply needs CONFIRM="FILL SERVICE CASE SUPPLIERS", writes one
   case at a time (guarded on the code and source it planned from) with a
   creditor_resolved activity row, then re-reads on a fresh connection that
   every written case holds the planned code and source and that no 'manual'
   case changed.

   RE-RUN: safe. A written case is 'po' / 'so' and drops out of scope; an 'auto'
   case whose answer is unchanged is skipped; manual cases are never read for writing. */
import postgres from 'postgres';
import { pickCaseSupplier } from './lib/assr-supplier-pick.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'FILL SERVICE CASE SUPPLIERS';

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

/* The manual links, as one fingerprint: the apply must leave it identical. */
const manualPrint = async (client) => (await client`
  SELECT COUNT(*)::int AS n,
         COALESCE(md5(string_agg(id::text || ':' || COALESCE(creditor_code, ''), ',' ORDER BY id)), '') AS h
    FROM public.assr_cases WHERE creditor_source = 'manual'`)[0];

async function planFor(c) {
  const co = Number(c.company_id);
  const scoped = Number.isInteger(co) && co > 0 && c.doc_no;
  const lines = scoped ? await sql`
    SELECT id FROM scm.mfg_sales_order_items
     WHERE company_id = ${co} AND doc_no = ${c.doc_no} AND item_code = ${c.item_code}` : [];
  const lineIds = lines.map((l) => l.id);
  const pos = lineIds.length ? await sql`
    SELECT DISTINCT po.id, po.po_number, po.po_date::text AS po_date, po.status, s.code
      FROM scm.purchase_order_items pi
      JOIN scm.purchase_orders po ON po.id = pi.purchase_order_id AND po.company_id = ${co}
      LEFT JOIN scm.suppliers s ON s.id = po.supplier_id
     WHERE pi.company_id = ${co} AND pi.so_item_id IN ${sql(lineIds)}` : [];
  const binds = lineIds.length ? await sql`
    SELECT b.is_main_supplier, s.code
      FROM scm.supplier_material_bindings b
      JOIN scm.suppliers s ON s.id = b.supplier_id
     WHERE b.company_id = ${co} AND b.material_kind = 'mfg_product' AND b.item_code = ${c.item_code}` : [];
  const [si] = await sql`SELECT main_supplier FROM public.stock_items WHERE item_code = ${c.item_code} LIMIT 1`;
  return pickCaseSupplier({ hasSoLine: lineIds.length > 0, pos, binds, mainSupplier: si?.main_supplier ?? null });
}

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'}`);
  const cases = await sql`
    SELECT id, assr_no, stage, doc_no, item_code, company_id, creditor_code, creditor_source
      FROM public.assr_cases
     WHERE archived_at IS NULL
       AND stage NOT IN ('completed', 'voided')
       AND COALESCE(item_code, '') <> ''
       AND COALESCE(creditor_source, '') IN ('', 'auto')
     ORDER BY id`;
  note(`in scope (open, no manual / po / so link): ${cases.length}`);

  const change = [], none = [];
  let same = 0;
  for (const c of cases) {
    const pick = await planFor(c);
    if (!pick) { none.push(c); continue; }
    if (pick.code === c.creditor_code && pick.source === (c.creditor_source ?? '')) { same++; continue; }
    change.push({ ...c, pick });
  }

  note(`\n=== WOULD CHANGE ${change.length} ===`);
  for (const c of change) {
    note(`  ${c.assr_no.padEnd(16)} ${String(c.stage).padEnd(26)} ${String(c.item_code).padEnd(26)} ${c.creditor_code ?? '(blank)'} [${c.creditor_source ?? '-'}] -> ${c.pick.code} [${c.pick.source}]`);
  }
  note(`\n=== NO SUPPLIER FOUND, left for Service Team: ${none.length} ===`);
  for (const c of none) note(`  ${c.assr_no.padEnd(16)} ${String(c.stage).padEnd(26)} ${c.item_code} (now ${c.creditor_code ?? 'blank'})`);
  note(`\nalready right: ${same}   would change: ${change.length}   no answer: ${none.length}`);

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  const manualBefore = await manualPrint(sql);
  note(`\n=== WRITING ${change.length} CASE(S) ===`);
  const written = [];
  for (const c of change) {
    const ok = await sql.begin(async (tx) => {
      const back = await tx`
        UPDATE public.assr_cases
           SET creditor_code = ${c.pick.code}, creditor_source = ${c.pick.source},
               updated_at = to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')
         WHERE id = ${c.id}
           AND COALESCE(creditor_source, '') IN ('', 'auto')
           AND creditor_code IS NOT DISTINCT FROM ${c.creditor_code}
        RETURNING id`;
      if (!back.length) return false;
      await tx`
        INSERT INTO public.assr_activity (assr_id, action, from_value, to_value, note, user_id, category)
        VALUES (${c.id}, 'creditor_resolved', ${c.creditor_code}, ${c.pick.code},
                ${`Backfill HC-0130: supplier from ${c.pick.source === 'po' ? 'the PO' : c.pick.source === 'so' ? 'the SO' : 'AutoCount'} of item ${c.item_code}`},
                NULL, 'supplier')`;
      return true;
    });
    note(`  ${ok ? 'OK  ' : 'SKIP (changed since the plan)'} ${c.assr_no} -> ${c.pick.code} [${c.pick.source}]`);
    if (ok) written.push(c);
  }
  note(`  written: ${written.length} of ${change.length}`);
  await sql.end({ timeout: 5 });

  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  let failed = false;
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    for (const c of written) {
      const [r] = await check`SELECT creditor_code, creditor_source FROM public.assr_cases WHERE id = ${c.id}`;
      if (r?.creditor_code !== c.pick.code || r?.creditor_source !== c.pick.source) {
        failed = true;
        bad(`  ${c.assr_no}: reads ${r?.creditor_code} [${r?.creditor_source}], planned ${c.pick.code} [${c.pick.source}]`);
      }
    }
    const manualAfter = await manualPrint(check);
    if (manualAfter.n !== manualBefore.n || manualAfter.h !== manualBefore.h) {
      failed = true;
      bad(`  manual links changed: ${manualBefore.n} -> ${manualAfter.n}`);
    }
    note(`  ${written.length} case(s) hold the planned supplier; manual links unchanged: ${manualAfter.n}`);
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
