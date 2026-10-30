// HC-0182: move the sales lines parked on the old placeholder "BEDFRAME KIV LV2"
// onto the sized KIV codes their own text names. PLAN BY DEFAULT: nothing is
// written unless MODE=apply and CONFIRM repeats the phrase this run prints.
//
// "BEDFRAME KIV LV2" (no size, created 2026-06-22) carries 212 sales lines of
// every level and size; the level and size live only in the typed Desc2
// ("LV1 KING", "Level 2 (Queen)"). It has no cost, so Finance's no-cost list
// cannot clear. On 2026-10-29 Sim made the sized models LV1 / LV3 / LV4, and the
// LV2 model's six sizes came out as "BEDFRAME KIV-(K)" etc.: they were generated
// while that model was coded "BEDFRAME KIV". The rules are in
// lib/kiv-bedframe-line-target.mjs.
//
// WHAT IT WRITES, in one transaction:
//   1. the six level-less codes renamed to "BEDFRAME KIV LV2-(size)" (code, name,
//      base_model). Refused if anything already uses them;
//   2. scm.mfg_sales_order_items.item_code on each line that resolves to ONE level
//      and ONE size, re-keyed to that code, row by row by id. Size: the text, else
//      the order's one mattress size. Level: the text (LVn or the costing model
//      name), else LV2 only with DEFAULT_LEVEL=2 (Sim 2026-10-30, boss to rule).
// WHAT IT NEVER TOUCHES: the lines it cannot read (they stay on the old code for
// Sales to fill in), Desc2, variants, qty, prices, costs, the SO headers, the old
// catalogue row; AutoCount - a raw SQL change queues no write-back.
//
// OUTPUT: line ids, the typed Desc2 and the target code. This repository's
// Actions logs are public: no document numbers, no customers, no money.
//
//   DATABASE_URL  required
//   MODE          plan (default, writes nothing) | apply
//   CONFIRM       on apply, the phrase this run prints (it carries the counts)
//   COMPANY_ID    default 1
//   DEFAULT_LEVEL unset (lines with no level stay) | 2
//
// RE-RUN: convergent. A renamed code no longer exists under its old name and a
// moved line no longer names the old code, so a second apply plans nothing new.
// Every UPDATE re-asserts the code it replaces; a count that differs from the
// plan rolls the whole transaction back.

import postgres from 'postgres';
import { PRODUCT_CODE_CASCADE } from '../src/scm/lib/product-code-rename.ts';
import { resolveAcItemCode } from '../src/services/autocount-item-code.ts';
import { OLD_CODE, RENAMES, lineText, planKivRehome, confirmPhrase } from './lib/kiv-bedframe-line-target.mjs';

const DSN = process.env.DATABASE_URL;
const MODE = (process.env.MODE || 'plan').toLowerCase();
const APPLY = MODE === 'apply';
const CONFIRM = process.env.CONFIRM ?? '';
const CO = Number(process.env.COMPANY_ID || 1);
const DEFAULT_LEVEL = (process.env.DEFAULT_LEVEL || '').trim() || null;

if (DEFAULT_LEVEL && DEFAULT_LEVEL !== '2') { console.error(`REFUSED: DEFAULT_LEVEL can only be 2 (Sim: unidentified old bills go to LV2), got "${DEFAULT_LEVEL}".`); process.exit(2); }
if (!DSN) { console.error('REFUSED: DATABASE_URL not set.'); process.exit(2); }
if (!['plan', 'apply'].includes(MODE)) { console.error(`REFUSED: MODE must be plan or apply, got "${MODE}".`); process.exit(2); }

const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const OPEN_AMENDMENT = ['REQUESTED', 'SUPPLIER_PENDING', 'SO_APPROVED', 'PO_APPROVED'];
const renamedName = (name) => String(name ?? '').replace(/^BEDFRAME KIV (?!LV)/, 'BEDFRAME KIV LV2 ');

async function readWorld(sql) {
  const products = await sql`
    SELECT id, code, name, model_id, status::text AS status, base_model
      FROM scm.mfg_products
     WHERE company_id = ${CO} AND code ILIKE 'BEDFRAME KIV%'`;
  const present = new Set((await sql`
    SELECT table_name || '.' || column_name AS k FROM information_schema.columns WHERE table_schema = 'scm'`).map((r) => r.k));
  const froms = RENAMES.map((r) => r.from);
  const refsOnRename = [];
  for (const c of PRODUCT_CODE_CASCADE) {
    if (!present.has(`${c.table}.${c.col}`)) continue;
    const kind = c.kind ? `AND material_kind::text = 'mfg_product'` : '';
    const rows = await sql.unsafe(
      `SELECT ${c.col} AS code, count(*)::int AS n FROM scm.${c.table}
        WHERE company_id = $1 AND ${c.col} = ANY($2::text[]) ${kind} GROUP BY 1`, [CO, froms]);
    for (const r of rows) refsOnRename.push({ code: r.code, table: `${c.table}.${c.col}`, rows: r.n });
  }
  const raw = await sql`
    SELECT i.id::text AS id, i.description2, i.remark, i.variants, h.status::text AS so_status,
           ARRAY(SELECT DISTINCT p.size_code FROM scm.mfg_sales_order_items m
                   JOIN scm.mfg_products p ON p.company_id = m.company_id AND p.code = m.item_code
                  WHERE m.company_id = i.company_id AND m.doc_no = i.doc_no AND coalesce(m.cancelled, false) = false
                    AND p.category::text = 'MATTRESS' AND p.size_code IS NOT NULL) AS mattress_sizes,
           EXISTS (SELECT 1 FROM scm.so_amendment_lines al JOIN scm.so_amendments a ON a.id = al.amendment_id
                    WHERE al.sales_order_item_id = i.id AND a.status::text IN ${sql(OPEN_AMENDMENT)}) AS open_amendment
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.company_id = i.company_id AND h.doc_no = i.doc_no
     WHERE i.company_id = ${CO} AND i.item_code = ${OLD_CODE}
     ORDER BY i.id`;
  const lines = raw.map((r) => ({
    id: r.id, text: lineText(r), soStatus: r.so_status, openAmendment: r.open_amendment, mattressSizes: r.mattress_sizes ?? [],
  }));
  return { products, refsOnRename, lines };
}

async function main() {
  log(`rehome-kiv-bedframe-lines (HC-0182) mode=${MODE} company=${CO} default level=${DEFAULT_LEVEL ? `LV${DEFAULT_LEVEL}` : 'off'}`);
  const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  const world = await sql.begin('read only', readWorld);
  const plan = planKivRehome({ ...world, defaultLevel: DEFAULT_LEVEL });
  const byCode = new Map(world.products.map((p) => [p.code, p]));

  log('');
  log(`RENAME  ${plan.renames.length} code(s) (the LV2 model's sizes, generated without the level)`);
  for (const r of plan.renames) log(`  "${r.from}" -> "${r.to}"   name -> "${renamedName(byCode.get(r.from)?.name)}"`);
  for (const x of plan.refusals) log(`  REFUSED: ${x}`);

  const groups = new Map();
  for (const m of plan.moves) { if (!groups.has(m.target)) groups.set(m.target, []); groups.get(m.target).push(m); }
  log('');
  log(`MOVE  ${plan.moves.length} of ${world.lines.length} line(s) on "${OLD_CODE}"`);
  for (const [code, ls] of [...groups.entries()].sort()) {
    log(`  -> ${code}: ${ls.length}`);
    for (const l of ls) {
      const from = [l.levelFrom === 'default' ? 'level=LV2 default' : '', l.sizeFrom === 'mattress' ? 'size=mattress' : ''].filter(Boolean).join(', ');
      log(`       line ${l.id} (${l.soStatus}) "${l.text}"${from ? ` [${from}]` : ''}`);
    }
  }
  const src = (k, v) => plan.moves.filter((m) => m[k] === v).length;
  log(`  level from text ${src('levelFrom', 'text')}, by LV2 default ${src('levelFrom', 'default')}; size from text ${src('sizeFrom', 'text')}, from the order's mattress ${src('sizeFrom', 'mattress')}`);
  const why = new Map();
  for (const s of plan.stays) { if (!why.has(s.reason)) why.set(s.reason, []); why.get(s.reason).push(s); }
  log('');
  log(`STAY on "${OLD_CODE}"  ${plan.stays.length} line(s), by reason`);
  for (const [reason, ls] of [...why.entries()].sort((a, b) => b[1].length - a[1].length)) {
    log(`  ${reason}: ${ls.length}`);
    for (const l of ls) log(`       line ${l.id} (${l.soStatus}) "${l.text}"${l.target ? ` [would be ${l.target}]` : ''}`);
  }

  const targets = [...groups.keys()];
  log('');
  log('AUTOCOUNT  the item each target code sends to (no binding = the code itself)');
  for (const code of [OLD_CODE, ...targets]) {
    const r = resolveAcItemCode(code, { bindings: new Map() });
    log(`  ${code}: ${r.ok ? r.acItemCode : `cannot send (${r.detail})`}`);
  }

  const phrase = confirmPhrase(plan);
  log('');
  log(`TOTALS  rename ${plan.renames.length}; move ${plan.moves.length}; leave ${plan.stays.length}; refused ${plan.refusals.length}`);
  log(`to apply: MODE=apply CONFIRM="${phrase}"`);
  if (!APPLY) { log('PLAN ONLY - nothing was written.'); await sql.end(); return; }
  if (plan.refusals.length) { log('REFUSED: fix the refusals above first. Nothing was written.'); await sql.end(); process.exit(2); }
  if (CONFIRM !== phrase) { log(`REFUSED: apply needs CONFIRM="${phrase}" - measured by this run. Nothing was written.`); await sql.end(); process.exit(2); }
  if (plan.renames.length === 0 && plan.moves.length === 0) { log('nothing to do - a re-run after a completed apply ends here.'); await sql.end(); return; }

  log('');
  log(`UNDO  (before any write): UPDATE scm.mfg_sales_order_items SET item_code = '${OLD_CODE}' WHERE id::text = ANY(<ids>); each rename back with code/name/base_model as printed above`);
  for (const [code, ls] of groups) log(`   undo ${code}: ${JSON.stringify(ls.map((l) => l.id))}`);

  await sql.begin(async (t) => {
    for (const r of plan.renames) {
      const p = byCode.get(r.from);
      const res = await t`
        UPDATE scm.mfg_products
           SET code = ${r.to}, name = ${renamedName(p.name)}, base_model = ${OLD_CODE}, updated_at = now()
         WHERE company_id = ${CO} AND id = ${p.id} AND code = ${r.from}`;
      if (res.count !== 1) throw new Error(`rename ${r.from} touched ${res.count} row(s), expected 1 - rolled back`);
    }
    for (const [code, ls] of groups) {
      const ids = ls.map((l) => l.id);
      const res = await t`
        UPDATE scm.mfg_sales_order_items SET item_code = ${code}
         WHERE company_id = ${CO} AND item_code = ${OLD_CODE} AND id::text IN ${t(ids)}`;
      if (res.count !== ids.length) throw new Error(`${code}: moved ${res.count} line(s), planned ${ids.length} - rolled back`);
    }
  });
  log(`WRITTEN: ${plan.renames.length} code(s) renamed, ${plan.moves.length} line(s) moved`);
  await sql.end();

  const v = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  const problems = [];
  for (const r of plan.renames) {
    const [{ n }] = await v`SELECT count(*)::int AS n FROM scm.mfg_products WHERE company_id = ${CO} AND code = ${r.to}`;
    if (n !== 1) problems.push(`${r.to} is on ${n} catalogue row(s)`);
  }
  for (const [code, ls] of groups) {
    const [{ n }] = await v`SELECT count(*)::int AS n FROM scm.mfg_sales_order_items WHERE company_id = ${CO} AND item_code = ${code} AND id::text IN ${v(ls.map((l) => l.id))}`;
    log(`   VERIFY ${code}: ${n} of ${ls.length} moved line(s)`);
    if (n !== ls.length) problems.push(`${code}: ${n} of ${ls.length}`);
  }
  const [{ left }] = await v`SELECT count(*)::int AS left FROM scm.mfg_sales_order_items WHERE company_id = ${CO} AND item_code = ${OLD_CODE}`;
  log(`   VERIFY "${OLD_CODE}" still carries ${left} line(s) (planned ${plan.stays.length})`);
  await v.end();
  if (problems.length) { for (const x of problems) log(`   VERIFY FAILED: ${x}`); process.exit(1); }
  log('VERIFIED on a fresh connection.');
  log("NEXT: set cost + supplier on the target codes in SKU Master; the nightly restamp then fills the moved lines' cost. Run 'Recompute SO stock allocation (DRY-RUN gated)' too (docs/bugs/0675).");
}

main().catch((e) => {
  console.error(String(e?.message ?? e).replace(/postgres(ql)?:\/\/\S+/g, 'postgres://<redacted>'));
  process.exit(1);
});
