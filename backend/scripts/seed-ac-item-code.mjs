#!/usr/bin/env node
/* seed-ac-item-code.mjs — fill scm.supplier_material_bindings.ac_item_code with
   the ItemCode the ACCOUNT BOOK actually holds.
   ===========================================================================

   PLAIN LANGUAGE (老板版):
   migration 0326 把栏位拆开了：`supplier_sku` 归采购（印在供应商的单据上），
   `ac_item_code` 归 AutoCount（写进帐本的料号）。这支工具**预设只做预演**，
   把每一笔该填什么算出来，并且讲明白是**哪一条规则**决定的。算不出来的不猜，
   留 NULL 并且列出来给人看。MODE=apply 才会写。

   ── THE RULES, IN ORDER, AND WHY EACH ONE IS SAFE ────────────────────────
   R1  supplier_sku is ALREADY an ItemCode the book holds.
       Then it is the answer, and copying it changes nothing that happens
       today — these are the 1,874 rows that already land. Copying them is what
       lets purchasing edit supplier_sku afterwards without moving the book.

   R2  the cutover snapshot maps this ERP code to EXACTLY ONE book item.
       No ambiguity to resolve; the resolver already answers this way.

   R3  it maps to several, and exactly ONE of them is recorded against THIS
       supplier. That is the disambiguation the resolver already performs with
       `supplierCode`, written down instead of recomputed per document.

   ANYTHING ELSE IS LEFT NULL AND LISTED. The 139 refusals measured on
   2026-08-25 are `ambiguous: … none belongs to supplier` — e.g. `CODY-(K)`
   maps to `HOK-1007 (K)` (supplier 400-O002) and `NB-KHJ57(K)` (400-N002)
   while the binding belongs to 400-H003. Choosing between those is a business
   fact about who makes the item, not something a script may infer from a
   prefix. Guessing there would put a wrong stock identity in a licensed book,
   which is the failure this whole column exists to end.

   ── SAFETY ───────────────────────────────────────────────────────────────
   Writes ONE column, only where it is currently NULL, one statement per row,
   inside a transaction, then re-reads on a FRESH connection to assert every
   row landed. Never overwrites a value a human has already put there.

   RE-RUN: idempotent. A second plan prints the same table. A second apply finds
     every row it can decide already non-NULL — the UPDATE is guarded by
     `ac_item_code IS NULL` — so it writes nothing and exits 0. It cannot
     compound: the rules read `item_code`, `supplier_sku` and the snapshot, none
     of which this script writes. A row a human later cleared is re-seeded on
     the next run, which is the same request answered again.
   =========================================================================== */
import postgres from 'postgres';
import { acItemIndex } from '../src/services/autocount-item-code.js';

const MODE = (process.env.MODE ?? 'plan').toLowerCase();
const CONFIRM = process.env.CONFIRM ?? '';
const PHRASE = 'SEED AUTOCOUNT ITEM CODES';
const SHOW = Number(process.env.ROWS_PER_RULE ?? 6);

const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const fail = (m) => { console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : m); process.exitCode = 1; };

const url = process.env.DATABASE_URL;
if (!url) { fail('DATABASE_URL is not set'); process.exit(1); }

const pg = postgres(url, { max: 1, prepare: false, idle_timeout: 5, connect_timeout: 20 });
const index = acItemIndex();
const up = (v) => String(v ?? '').trim().toUpperCase();

try {
  notice(`mode=${MODE.toUpperCase()}${MODE === 'plan' ? ' (read-only, nothing is written)' : ''}`);
  notice(`account-book snapshot: ${index.rows} item(s)`);

  const rows = await pg`
    SELECT b.id, b.item_code, b.supplier_sku, b.ac_item_code,
           s.code AS supplier_code, s.name AS supplier_name
      FROM scm.supplier_material_bindings b
      JOIN scm.suppliers s ON s.id = b.supplier_id
     WHERE b.material_kind = 'mfg_product'
     ORDER BY s.code, b.item_code`;
  notice(`=== ${rows.length} binding row(s) ===`);

  const decided = [];
  const undecided = [];
  const byRule = new Map();

  for (const r of rows) {
    if (String(r.ac_item_code ?? '').trim()) continue;   // a human already answered
    const sku = String(r.supplier_sku ?? '').trim();
    const candidates = index.byErp.get(up(r.item_code)) ?? [];
    let rule = null, value = null;

    if (sku && index.acCodes.has(up(sku))) { rule = 'R1 sku is a book code'; value = sku; }
    else if (candidates.length === 1) { rule = 'R2 one candidate'; value = candidates[0].ac; }
    else if (candidates.length > 1) {
      const mine = candidates.filter((c) => up(c.supplier) === up(r.supplier_code));
      if (mine.length === 1) { rule = 'R3 one candidate is this supplier'; value = mine[0].ac; }
    }

    if (value) {
      decided.push({ id: r.id, value, rule, itemCode: r.item_code, sup: r.supplier_code });
      if (!byRule.has(rule)) byRule.set(rule, []);
      byRule.get(rule).push(`${r.supplier_code} ${r.item_code}  sku=${JSON.stringify(sku)}  ->  ${value}`);
    } else {
      undecided.push(`${r.supplier_code} ${r.item_code}  sku=${JSON.stringify(sku)}  candidates=[${candidates.map((c) => `${c.ac}@${c.supplier}`).join(', ')}]`);
    }
  }

  for (const [rule, lines] of byRule) {
    notice(`--- ${rule}: ${lines.length} row(s) ---`);
    for (const l of lines.slice(0, SHOW)) notice(`    ${l}`);
    if (lines.length > SHOW) notice(`    … ${lines.length - SHOW} more (ROWS_PER_RULE=${SHOW}; set 0 for all)`);
  }

  notice(`--- LEFT NULL, a person must decide: ${undecided.length} row(s) ---`);
  for (const l of undecided.slice(0, SHOW * 3)) notice(`    ${l}`);
  if (undecided.length > SHOW * 3) notice(`    … ${undecided.length - SHOW * 3} more not printed`);

  notice(`=== ${decided.length} row(s) would be seeded, ${undecided.length} left for a person ===`);

  if (MODE !== 'apply') { notice('PLAN ONLY. Nothing was written.'); process.exit(0); }
  if (CONFIRM !== PHRASE) { fail(`apply refused: CONFIRM must be exactly "${PHRASE}"`); process.exit(1); }

  await pg.begin(async (tx) => {
    for (const d of decided) {
      /* GUARDED ON NULL, so a value a human wrote between the read and the
         write is never overwritten by this run's stale plan. */
      await tx`UPDATE scm.supplier_material_bindings
                  SET ac_item_code = ${d.value}
                WHERE id = ${d.id} AND ac_item_code IS NULL`;
    }
  });
  notice(`wrote ${decided.length} row(s)`);

  const check = postgres(url, { max: 1, prepare: false, idle_timeout: 5 });
  try {
    const back = await check`SELECT id, ac_item_code FROM scm.supplier_material_bindings WHERE id = ANY(${decided.map((d) => d.id)})`;
    const byId = new Map(back.map((b) => [b.id, b.ac_item_code]));
    const wrong = decided.filter((d) => byId.get(d.id) !== d.value);
    if (wrong.length) fail(`${wrong.length} row(s) did not land: ${wrong.slice(0, 5).map((w) => w.itemCode).join(', ')}`);
    else notice(`VERIFIED on a fresh connection: all ${decided.length} row(s) hold the seeded code.`);
  } finally { await check.end({ timeout: 5 }); }
} finally {
  await pg.end({ timeout: 5 });
}
