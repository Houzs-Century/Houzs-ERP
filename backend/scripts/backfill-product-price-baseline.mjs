#!/usr/bin/env node
// One-time backfill: give every existing product SELLING price a DATE, so the
// effective-dating system (Pricing "Option B") has a timeline the day it goes
// live instead of a wall of date-less prices. Owner 2026-07-24: "把全部之前我 set
// 过的 price 都 set 一个日期 ... backfill 到完数据，要不然我现在的东西没有日期".
//
// Fills scm.mfg_product_price_history (migration 0187), PER COMPANY (1=HOUZS,
// 2=2990), from what we already know:
//
//   • If scm.master_price_history has SELL-PRICE audit records for the product
//     (field = 'sell_price_sen' — the exact value mfg-products.ts PATCH writes),
//     reconstruct the timeline: one row per change
//     (sell_price_sen = new_value_sen, effective_from = changed_at::date), PLUS a
//     baseline for the value BEFORE the first change (old_value_sen of the
//     earliest record) dated at the product's created_at::date.
//   • If there are NO audit records, insert ONE baseline row = the current flat
//     sell_price_sen dated at created_at::date.
//   • ALWAYS guarantee a row whose value equals the current live flat price, so
//     resolveSellPriceSenAsOf(today) == today's price — NO visible change on
//     go-live (this backfill only STORES history; it does NOT touch how any order
//     is priced — that read-integration is a separate phase).
//
// Dates use the Asia/Kuala_Lumpur (MYT) calendar day, matching todayMyt() /
// my-time.ts so a change logged late-evening UTC lands on the right MY date.
// Baseline-date rule: product.created_at::date (MYT), falling back to the fixed
// anchor 2024-01-01 when created_at is null.
//
// NON-CLOBBERING + IDEMPOTENT: any (company_id, product_code) that already has
// rows in mfg_product_price_history is SKIPPED whole — a re-run adds nothing, and
// the write path's own rows are never overwritten. Append-only.
//
// DRY-RUN by default (prints per-company counts + a sample of planned rows).
// APPLY=1 to write. Manual workflow: .github/workflows/backfill-product-price-baseline.yml
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const ANCHOR = "2024-01-01"; // baseline date when a product has no created_at
const dst = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

// MYT (UTC+8, no DST) calendar day — mirrors my-time.ts todayMyt().
const TODAY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

/* The as-of-today value the resolver WOULD return from a set of planned rows:
   newest effective_from <= today, tie-broken by build order (which is also the
   created_at order we write). Used to decide whether a today = flat guarantee row
   is needed. */
function asOfToday(rows) {
  const applicable = rows
    .map((r, i) => ({ ...r, _ord: i }))
    .filter((r) => r.effective_from <= TODAY && r.sell_price_sen != null);
  if (!applicable.length) return undefined;
  applicable.sort((a, b) =>
    a.effective_from < b.effective_from ? -1 :
    a.effective_from > b.effective_from ? 1 : a._ord - b._ord);
  return applicable[applicable.length - 1].sell_price_sen;
}

/* Plan the rows for one product. Returns { rows, kind } where rows are
   { sell_price_sen, effective_from, created_at, notes }. Empty => nothing to do. */
function planProduct(product, audit) {
  const flat = product.sell_price_sen;
  if (flat == null) return { rows: [], kind: "no-price" };
  const createdDate = product.created_date || ANCHOR;
  const rows = [];

  if (audit.length > 0) {
    // Baseline = the value BEFORE the first recorded change. Skip when it is null
    // (the product had no price before its first change — a null row says nothing,
    // and reads fall back to the flat value anyway).
    const firstOld = audit[0].old_value_sen;
    if (firstOld != null) {
      rows.push({
        sell_price_sen: firstOld,
        effective_from: createdDate,
        created_at: product.created_at ?? new Date(`${ANCHOR}T00:00:00Z`),
        notes: "Backfill: value before the first recorded price change.",
      });
    }
    // One row per recorded change (skip null new-values — a cleared price is not a
    // schedulable amount; the flat fallback covers it).
    for (const a of audit) {
      if (a.new_value_sen == null) continue;
      rows.push({
        sell_price_sen: a.new_value_sen,
        effective_from: a.eff,
        created_at: a.changed_at,
        notes: "Backfill: reconstructed from master_price_history.",
      });
    }
  } else {
    // No audit trail — a single baseline at the product's creation date.
    rows.push({
      sell_price_sen: flat,
      effective_from: createdDate,
      created_at: product.created_at ?? new Date(`${ANCHOR}T00:00:00Z`),
      notes: "Backfill: baseline (no price-change history).",
    });
  }

  // GUARANTEE the current flat price resolves as-of today. If the plan so far
  // does not already resolve to `flat` today (audit drift, a null tail, or a
  // future-only reconstruction), append a today-dated row carrying the flat value.
  if (asOfToday(rows) !== flat) {
    rows.push({
      sell_price_sen: flat,
      effective_from: TODAY,
      created_at: new Date(),
      notes: "Backfill: current live price (go-live guarantee).",
    });
  }
  return { rows, kind: audit.length > 0 ? "reconstructed" : "baseline" };
}

async function backfillCompany(cid, code) {
  log("");
  log(`########## COMPANY ${code} (id=${cid}) ##########`);
  const products = await dst`
    SELECT code, sell_price_sen,
           to_char((created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date, 'YYYY-MM-DD') AS created_date,
           created_at
      FROM scm.mfg_products
     WHERE company_id = ${cid} AND sell_price_sen IS NOT NULL
     ORDER BY code`;

  let planned = 0, skippedExisting = 0, productsPlanned = 0, reconstructed = 0;
  const sample = [];

  for (const p of products) {
    // NON-CLOBBERING: any product that already has a timeline is left alone.
    const existing = await dst`
      SELECT 1 FROM scm.mfg_product_price_history
       WHERE company_id = ${cid} AND product_code = ${p.code} LIMIT 1`;
    if (existing.length > 0) { skippedExisting++; continue; }

    const audit = await dst`
      SELECT old_value_sen, new_value_sen,
             to_char((changed_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date, 'YYYY-MM-DD') AS eff,
             changed_at
        FROM scm.master_price_history
       WHERE company_id = ${cid} AND product_code = ${p.code} AND field = 'sell_price_sen'
       ORDER BY changed_at ASC`;

    const { rows, kind } = planProduct(p, audit);
    if (rows.length === 0) continue;
    productsPlanned++;
    if (kind === "reconstructed") reconstructed++;
    planned += rows.length;
    for (const r of rows) {
      if (sample.length < 12) sample.push(`${p.code}  ${r.effective_from}  ${(r.sell_price_sen / 100).toFixed(2)}`);
    }

    if (APPLY) {
      for (const r of rows) {
        await dst`
          INSERT INTO scm.mfg_product_price_history
            (company_id, product_code, sell_price_sen, effective_from, notes, created_by, created_at)
          VALUES (${cid}, ${p.code}, ${r.sell_price_sen}, ${r.effective_from}, ${r.notes}, ${"backfill"}, ${r.created_at})`;
      }
    }
  }

  log(`  products with a live price: ${products.length}`);
  log(`  already had a timeline (skipped): ${skippedExisting}`);
  log(`  products ${APPLY ? "backfilled" : "to backfill"}: ${productsPlanned} (${reconstructed} reconstructed from audit, ${productsPlanned - reconstructed} single baseline)`);
  log(`  history rows ${APPLY ? "INSERTED" : "planned"}: ${planned}`);
  if (sample.length) {
    log(`  sample (product_code · effective_from · RM):`);
    for (const s of sample) log(`    ${s}`);
  }
  return { planned, productsPlanned };
}

async function main() {
  const only = (process.env.ONLY || "").trim(); // ONLY=HOUZS narrows to one company
  const companies = await dst`SELECT id, code FROM companies ORDER BY id`;
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}  today(MYT)=${TODAY}${only ? `  ONLY=${only}` : "  (all companies)"}`);

  let grand = 0, grandProducts = 0;
  for (const co of companies) {
    if (only && String(co.code) !== only) continue;
    const r = await backfillCompany(Number(co.id), co.code);
    grand += r.planned;
    grandProducts += r.productsPlanned;
  }

  log("");
  log(`GRAND TOTAL: ${grandProducts} products, ${grand} history rows ${APPLY ? "INSERTED" : "planned"}.`);
  if (!APPLY) log("DRY-RUN — set APPLY=1 to write. Re-runnable: products with a timeline are skipped.");
}

main().then(() => dst.end()).catch(async (e) => {
  console.error("BACKFILL_FAIL", e.message);
  try { await dst.end(); } catch {}
  process.exit(1);
});
