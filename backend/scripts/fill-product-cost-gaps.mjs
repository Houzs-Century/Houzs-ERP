#!/usr/bin/env node
/* Fill Product Maintenance costs the owner named (2026-11-04), so orders can read
   them. Only a product whose cost is empty is written; a cost already there is
   never touched.

   KIV BEDFRAMES take the cost of the real model of each level, size for size:
     LV1 = JAGER, LV2 = CODY, LV3 = REGAL (A), LV4 = TRION (A).
   MATTRESS and ACCESSORY products with no cost take the newest non-cancelled
   purchase invoice price of that code, as a reference.
   NAMED_COSTS are the prices the owner gave for products with neither.

   MODE=plan (default) prints every write and changes nothing. MODE=apply needs
   CONFIRM="I HAVE REVIEWED THE DRY-RUN"; then it re-reads on a fresh connection
   and checks every written product carries the planned cost.

   REVERSAL: every written product had an empty cost:
     UPDATE scm.mfg_products SET base_price_sen = NULL WHERE company_id = <co> AND code IN (<printed codes>);

   RE-RUN: idempotent, value-guarded on an empty cost; a second run writes nothing.
   Env: DATABASE_URL (required); COMPANY (optional, default every company). */
import "./lib/public-log-guard.mjs";
import postgres from 'postgres';
import { kivSourceCode } from './lib/kiv-bedframe-cost.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const PHRASE = 'I HAVE REVIEWED THE DRY-RUN';
if (APPLY && process.env.CONFIRM !== PHRASE) { console.error(`MODE=apply requires CONFIRM="${PHRASE}"`); process.exit(2); }
const ONLY = process.env.COMPANY ? Number(process.env.COMPANY) : null;

const NAMED_COSTS = { 'DUNLOPILLO COOLSILK 2.0 NANO BREEZE MATT (K)': 345500 };

const rm = (sen) => (Number(sen) / 100).toFixed(2);
const empty = (p) => !(Number(p.base_price_sen) > 0) && !(Number(p.cost_price_sen) > 0);
const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

async function planFor(co) {
  const prods = await sql`SELECT code, category, base_price_sen, cost_price_sen FROM scm.mfg_products WHERE company_id = ${co}`;
  const byCode = new Map(prods.map((p) => [p.code, p]));
  const writes = [];
  const skipped = [];
  for (const p of prods) {
    if (!empty(p)) continue;
    const source = kivSourceCode(p.code);
    if (source === null) continue;
    const sen = Number(byCode.get(source)?.base_price_sen) || 0;
    if (sen > 0) writes.push({ code: p.code, sen, from: source });
    else skipped.push(`${p.code}: ${source} has no cost`);
  }
  for (const p of prods) {
    const sen = NAMED_COSTS[p.code];
    if (sen && empty(p)) writes.push({ code: p.code, sen, from: 'owner 2026-11-05' });
  }
  const prices = await sql`
    SELECT DISTINCT ON (i.item_code) i.item_code, i.unit_price_sen, h.invoice_number, h.invoice_date
    FROM scm.purchase_invoice_items i
    JOIN scm.purchase_invoices h ON h.id = i.purchase_invoice_id
    WHERE h.company_id = ${co} AND h.status NOT IN ('CANCELLED', 'DRAFT') AND i.unit_price_sen > 0
    ORDER BY i.item_code, h.invoice_date DESC NULLS LAST, h.created_at DESC`;
  const lastPi = new Map(prices.map((r) => [r.item_code, r]));
  for (const p of prods) {
    if (!empty(p) || NAMED_COSTS[p.code] || !['MATTRESS', 'ACCESSORY'].includes(String(p.category).toUpperCase())) continue;
    const hit = lastPi.get(p.code);
    if (hit) writes.push({ code: p.code, sen: Number(hit.unit_price_sen), from: hit.invoice_number });
  }
  return { writes, skipped };
}

async function main() {
  const companies = ONLY != null ? [ONLY] : (await sql`SELECT DISTINCT company_id FROM scm.mfg_products ORDER BY 1`).map((r) => Number(r.company_id));
  const applied = [];
  for (const co of companies) {
    const { writes, skipped } = await planFor(co);
    console.log(`===== Company ${co}: ${writes.length} products to fill, ${skipped.length} with no source =====`);
    for (const w of writes) console.log(`  ${w.code} = RM ${rm(w.sen)} (from ${w.from})`);
    for (const s of skipped) console.log(`  SKIP ${s}`);
    if (!APPLY) continue;
    for (const w of writes) {
      await sql`UPDATE scm.mfg_products SET base_price_sen = ${w.sen}, updated_at = now()
                WHERE company_id = ${co} AND code = ${w.code} AND COALESCE(base_price_sen, 0) = 0 AND COALESCE(cost_price_sen, 0) = 0`;
      applied.push({ co, ...w });
    }
  }
  await sql.end();
  if (!APPLY) { console.log('Plan only: nothing written.'); return; }
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  let bad = 0;
  for (const w of applied) {
    const [r] = await check`SELECT base_price_sen FROM scm.mfg_products WHERE company_id = ${w.co} AND code = ${w.code}`;
    if (Number(r?.base_price_sen) !== w.sen) { bad += 1; console.error(`MISMATCH ${w.code}: base_price_sen=${r?.base_price_sen} != ${w.sen} sen`); }
  }
  await check.end();
  console.log(`APPLIED ${applied.length} products; ${bad} did not read back.`);
  if (bad > 0) process.exit(1);
}

main().catch(async (e) => { console.error(e); await sql.end(); process.exit(1); });
