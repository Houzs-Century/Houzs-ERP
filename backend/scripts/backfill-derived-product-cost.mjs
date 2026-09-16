/* Backfill the derived Product-Maintenance cost from the supplier side, for
   every SKU that has bindings — the one-shot that replaces hand-typed costs
   with the whole-set most-expensive-supplier value (auto-derive).

   THIS IS ALSO THE STAGE-4 DIFF. Its DRY-RUN is exactly the before/after the
   owner must approve before the live reprice: it prints, per company, how many
   SKUs change and by how much, the biggest movers, and what is skipped (no
   binding, or all suppliers zero-priced). Nothing is written in DRY-RUN.

   Uses the SAME derivation the live recompute hook uses
   (deriveProductCostFromSuppliers), so the backfill and the ongoing hook agree
   by construction — there is no second copy of the money rule.

   MODE=plan (default) writes nothing. MODE=apply needs
   CONFIRM="I HAVE REVIEWED THE DRY-RUN", writes one product at a time, then
   RE-READS on a FRESH connection and asserts the invariant "every SKU with
   bindings now stores its derived cost" (shape, not a row count).

   DO NOT run apply on production without the owner's explicit go — that live
   reprice is auto-derive stage 4.

   Env: DATABASE_URL (required); COMPANY (optional, default = every company with
   active products); LIST_LIMIT (biggest movers to print, default 40).

   RE-RUN: idempotent — once applied, a re-run plans 0 changes (stored == derived). */
import postgres from 'postgres';
import { deriveProductCostFromSuppliers } from '../src/scm/lib/derive-product-cost-from-suppliers.ts';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';
const ONLY_COMPANY = process.env.COMPANY ? Number(process.env.COMPANY) : null;
const LIST_LIMIT = Number(process.env.LIST_LIMIT) > 0 ? Number(process.env.LIST_LIMIT) : 40;

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);
const rm = (sen) => (sen == null ? '-' : (Number(sen) / 100).toFixed(2));

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

/** Normalise a seat grid for equality (order-independent). */
const seatKey = (rows) =>
  JSON.stringify(
    (Array.isArray(rows) ? rows : [])
      .map((r) => [String(r.height ?? ''), String(r.tier ?? 'PRICE_2'), Number(r.priceSen ?? 0)])
      .sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : 1)),
  );

/** A trustworthy COST signal for the diff. For SOFA the SO cost is the seat
 *  grid (base_price_sen is only a flat fallback and is often a stale legacy
 *  value), so report the dearest seat-grid cell; for every other category the
 *  cost IS base_price_sen. This stops the diff headlining sofas as "5063 -> 0"
 *  when the real per-height cost is preserved/corrected in the grid. */
const costSignalSen = (category, baseSen, seatRows) => {
  if (String(category ?? '').toUpperCase() === 'SOFA') {
    let max = 0;
    for (const r of Array.isArray(seatRows) ? seatRows : []) {
      const n = Number(r?.priceSen ?? 0);
      if (Number.isFinite(n) && n > max) max = n;
    }
    if (max > 0) return max;
  }
  return Number(baseSen ?? 0);
};

/** Derive one company's planned changes. Returns { changes, skipped, byReason }. */
async function planCompany(client, companyId) {
  const products = await client`
    SELECT id, code, category, base_price_sen, price1_sen, seat_height_prices
    FROM scm.mfg_products
    WHERE status = 'ACTIVE' AND company_id = ${companyId}`;
  const bindings = await client`
    SELECT item_code, supplier_id, is_main_supplier, unit_price_sen, price_matrix
    FROM scm.supplier_material_bindings
    WHERE material_kind = 'mfg_product' AND company_id = ${companyId}`;

  const byCode = new Map();
  for (const b of bindings) {
    if (!byCode.has(b.item_code)) byCode.set(b.item_code, []);
    byCode.get(b.item_code).push({
      supplier_id: b.supplier_id,
      is_main_supplier: b.is_main_supplier,
      unit_price_sen: b.unit_price_sen,
      price_matrix: b.price_matrix,
    });
  }

  const changes = [];
  const byReason = { no_supplier_binding: 0, all_zero_priced: 0, product_not_found: 0 };
  for (const p of products) {
    const derived = deriveProductCostFromSuppliers(p.category, byCode.get(p.code) ?? []);
    if (derived.skipped) { byReason[derived.reason] = (byReason[derived.reason] ?? 0) + 1; continue; }
    if (derived.dearnessSen === 0) { byReason.all_zero_priced += 1; continue; }
    const pt = derived.patch;
    const newBase = 'base_price_sen' in pt ? (pt.base_price_sen ?? null) : p.base_price_sen;
    const newP1 = 'price1_sen' in pt ? (pt.price1_sen ?? null) : p.price1_sen;
    const newSeat = pt.seat_height_prices !== undefined ? pt.seat_height_prices : p.seat_height_prices;
    const baseChanged = Number(newBase ?? -1) !== Number(p.base_price_sen ?? -1);
    const p1Changed = 'price1_sen' in pt && Number(newP1 ?? -1) !== Number(p.price1_sen ?? -1);
    const seatChanged = pt.seat_height_prices !== undefined && seatKey(newSeat) !== seatKey(p.seat_height_prices);
    if (!baseChanged && !p1Changed && !seatChanged) continue;
    const oldCost = costSignalSen(p.category, p.base_price_sen, p.seat_height_prices);
    const newCost = costSignalSen(p.category, newBase, newSeat);
    changes.push({
      id: p.id, code: p.code, category: p.category,
      oldCost, newCost, p1Changed, seatChanged,
      delta: newCost - oldCost,
      patch: { base_price_sen: newBase, price1_sen: newP1, seat_height_prices: newSeat },
    });
  }
  return { changes, byReason, products: products.length };
}

try {
  const companies = ONLY_COMPANY != null
    ? [ONLY_COMPANY]
    : (await sql`SELECT DISTINCT company_id FROM scm.mfg_products WHERE status='ACTIVE' ORDER BY company_id`).map((r) => r.company_id);

  let grandChanges = 0;
  for (const co of companies) {
    const { changes, byReason, products } = await planCompany(sql, co);
    grandChanges += changes.length;
    note('');
    note(`===== Company ${co} =====`);
    note(`active SKUs: ${products}; would CHANGE: ${changes.length}; skipped no-binding: ${byReason.no_supplier_binding}; skipped all-zero: ${byReason.all_zero_priced}`);
    const movers = [...changes].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, LIST_LIMIT);
    note(`biggest movers (code | category | old RM -> new RM${'  (+P1/seat)'}):`);
    for (const m of movers) {
      const tags = `${m.p1Changed ? ' P1' : ''}${m.seatChanged ? ' seat' : ''}`;
      note(`  ${m.code} | ${m.category ?? '-'} | ${rm(m.oldCost)} -> ${rm(m.newCost)}${tags}`);
    }
    if (changes.length > movers.length) note(`  ... ${changes.length - movers.length} more.`);

    if (APPLY) {
      for (const ch of changes) {
        await sql`
          UPDATE scm.mfg_products
          SET base_price_sen = ${ch.patch.base_price_sen},
              price1_sen = ${ch.patch.price1_sen},
              seat_height_prices = ${sql.json(ch.patch.seat_height_prices ?? null)},
              updated_at = now()
          WHERE id = ${ch.id} AND company_id = ${co}`;
      }
      note(`APPLIED ${changes.length} product cost updates for company ${co}.`);
    }
  }

  if (APPLY) {
    // Fresh connection; assert the INVARIANT (shape): re-planning now finds no
    // remaining change, i.e. every SKU with bindings stores its derived cost.
    const verify = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
    try {
      let remaining = 0;
      for (const co of companies) remaining += (await planCompany(verify, co)).changes.length;
      if (remaining !== 0) { bad(`post-apply invariant FAILED: ${remaining} SKU(s) still diverge from their derived cost`); process.exit(1); }
      note(`post-apply invariant OK: 0 SKUs diverge (${grandChanges} repriced).`);
    } finally {
      await verify.end({ timeout: 5 });
    }
  } else {
    note('');
    note(`DRY-RUN total: ${grandChanges} SKU(s) would be repriced across ${companies.length} company(ies). Nothing written.`);
    note('This is the stage-4 diff. The live reprice (MODE=apply) waits for the owner.');
  }
} finally {
  await sql.end({ timeout: 5 });
}
