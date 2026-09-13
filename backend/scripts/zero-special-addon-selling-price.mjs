#!/usr/bin/env node
// Put the special-option prices back to being COST ONLY: zero
// `selling_price_sen`, leave `cost_price_sen` exactly as it is.
// MODE=plan by default; MODE=apply needs CONFIRM.
//
// THE ASK (owner, 2026-09-13): 「我放的都是 costing 啊 为什么会 show 在 SO 和影响
// SO 呢？完全都不需要有这个功能啊 只有 co2 会把这个带去 2990s pos 然后 pos set
// 价格而已」 and 「正常我们的 selling price 全部自由的」.
//
// HE IS DESCRIBING THE ORIGINAL DESIGN. `shared/mfg-pricing.ts:223-234` says it
// in its own words: "variant priceSen is COST, NOT selling ... falls back to 0
// when the option carries no selling surcharge (the case today: surcharges
// contribute 0 to selling until a director sets a value)". And
// `SoLineCard.tsx:1416` says the SO must never surface the cost. The selling
// column was only ever meant to hold a figure a Sales Director had deliberately
// authored.
//
// WHAT MADE IT FALSE. Both Maintenance screens showed ONE box labelled "Price"
// and wrote it to BOTH columns "so they never diverge"
// (Products.tsx:4676, SpecialAddonsTab.tsx's withSyncedPrice). So a costing
// figure typed by the owner became a customer surcharge, and "a director set a
// value" became accidentally true. The tell: all eleven priced options carry
// selling EXACTLY equal to cost. Both screens are fixed in the same PR; this
// script repairs the values they already wrote. docs/bugs/0852.
//
// WHY IT IS SAFE, MEASURED NOT ASSUMED (prod run 34745750576, 2026-09-13):
// of 3,948 sofa/bedframe sales lines, 3,944 are on a MIGRATED order where the
// surcharge arm is structurally inert (mfg-pricing-recompute.ts:535-545), 4 are
// native, and **0** native lines carry a priced option. So no line's price
// today depends on any of these figures, and zeroing them changes no document.
// The change is entirely about what happens NEXT.
//
// WHAT IT ALSO FIXES, with no code change: both SO surfaces show the surcharge
// only when it is non-zero — desktop `SoLineCard.tsx:1223` (`extraSen > 0`) and
// mobile `MobileNewSO.tsx:3490` (`sellingPriceSen !== 0`). Zeroing the column
// makes both render clean, which is what the owner asked for on both.
//
// SCOPE IS ONE COMPANY. scm.special_addons is company-scoped and company 2
// carries its own values to the 2990s POS, which sets its own price. This
// touches COMPANY_ID only and names the other companies' row counts so the
// reader can see they were left alone.
//
// RE-RUN: convergent and inert. A second run finds every row already at 0 and
// writes nothing.
//
//   DATABASE_URL   required
//   COMPANY_ID     optional, default 1
//   MODE           plan (default) | apply
//   CONFIRM        required for apply: THE PRICE IS COST ONLY
import postgres from 'postgres';

const CONFIRM_PHRASE = 'THE PRICE IS COST ONLY';
const MODE = String(process.env.MODE || 'plan').toLowerCase();
const WANTS_APPLY = MODE === 'apply';
const CO = Number(process.env.COMPANY_ID || 1);
const line = (s = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${s}` : s);
const rule = () => line('-'.repeat(78));
const rm = (sen) => `RM${(Number(sen) / 100).toFixed(2)}`;

const DST = process.env.DATABASE_URL;
if (!DST) { console.error('need DATABASE_URL'); process.exit(2); }
if (WANTS_APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}" — refusing, nothing was written.`);
  process.exit(2);
}
const APPLY = WANTS_APPLY;

const sql = postgres(DST, { ssl: 'require', max: 1, prepare: false });

try {
  line('='.repeat(78));
  line('SPECIAL OPTIONS — the price is COST. Zero the selling surcharge.');
  line('='.repeat(78));
  line(`   company ${CO}   mode ${APPLY ? 'APPLY' : 'PLAN'}`);

  const others = await sql`
    SELECT company_id, count(*)::int AS n,
           count(*) FILTER (WHERE coalesce(selling_price_sen,0) <> 0)::int AS priced
      FROM scm.special_addons WHERE company_id <> ${CO}
     GROUP BY company_id ORDER BY company_id`;
  line('   OTHER COMPANIES — not touched by this script:');
  if (!others.length) line('      (none)');
  for (const o of others) line(`      company ${o.company_id}: ${o.n} option(s), ${o.priced} priced   LEFT ALONE`);

  const rows = await sql`
    SELECT id::text AS id, code, active,
           coalesce(selling_price_sen, 0)::int AS sell,
           coalesce(cost_price_sen, 0)::int AS cost
      FROM scm.special_addons WHERE company_id = ${CO} ORDER BY code`;
  const toZero = rows.filter((r) => r.sell !== 0);
  const sameAsCost = toZero.filter((r) => r.sell === r.cost);

  rule();
  line(`   options for company ${CO}                          ${rows.length}`);
  line(`   carrying a selling surcharge                     ${toZero.length}`);
  line(`   of those, selling EXACTLY equals cost            ${sameAsCost.length}`
    + `   <- the signature of a copied column`);
  rule();
  line(`   ${'option'.padEnd(36)} ${'cost (kept)'.padStart(12)} ${'selling'.padStart(12)} -> 0`);
  for (const r of toZero) {
    line(`   ${String(r.code).padEnd(36)} ${rm(r.cost).padStart(12)} ${rm(r.sell).padStart(12)}`
      + (r.sell === r.cost ? '    (equal)' : '    DIFFERENT — read this one before applying')
      + (r.active === false ? '  (retired)' : ''));
  }
  const different = toZero.filter((r) => r.sell !== r.cost);
  if (different.length) {
    rule();
    line(`   ${different.length} option(s) have a selling figure that is NOT the cost. Those may be a`);
    line('   real, deliberately authored surcharge rather than a copied column. They are');
    line('   listed above and are still zeroed by this run — say so to the owner first.');
  }

  if (!APPLY) {
    rule();
    line('PLAN ONLY — nothing was written.');
    line(`To write: MODE=apply CONFIRM="${CONFIRM_PHRASE}"`);
  } else {
    rule();
    let n = 0;
    for (const r of toZero) {
      const res = await sql`
        UPDATE scm.special_addons SET selling_price_sen = 0
         WHERE id = ${r.id} AND company_id = ${CO} AND coalesce(selling_price_sen, 0) <> 0`;
      n += Number(res.count ?? 0);
    }
    line(`APPLIED — ${n} option(s) zeroed on the selling side.`);

    /* VERIFY on a FRESH connection, asserting the SHAPE: the selling column is 0
       AND the cost column is byte-identical to what it was. A row count would
       be true even if the cost had been clobbered. */
    const check = postgres(DST, { ssl: 'require', max: 1, prepare: false });
    try {
      const after = await check`
        SELECT id::text AS id, code, coalesce(selling_price_sen,0)::int AS sell,
               coalesce(cost_price_sen,0)::int AS cost
          FROM scm.special_addons WHERE company_id = ${CO}`;
      const byId = new Map(after.map((r) => [r.id, r]));
      const bad = [];
      for (const r of rows) {
        const a = byId.get(r.id);
        if (!a) { bad.push(`${r.code}: row is gone`); continue; }
        if (a.sell !== 0) bad.push(`${r.code}: selling is still ${rm(a.sell)}`);
        if (a.cost !== r.cost) bad.push(`${r.code}: COST moved ${rm(r.cost)} -> ${rm(a.cost)}`);
      }
      const otherAfter = await check`
        SELECT count(*) FILTER (WHERE coalesce(selling_price_sen,0) <> 0)::int AS priced
          FROM scm.special_addons WHERE company_id <> ${CO}`;
      const wasPriced = others.reduce((t, o) => t + Number(o.priced), 0);
      if (Number(otherAfter[0]?.priced ?? 0) !== wasPriced) {
        bad.push(`another company's priced count moved ${wasPriced} -> ${otherAfter[0]?.priced}`);
      }
      if (bad.length) { line(`VERIFY FAILED — ${bad.length}: ${bad.slice(0, 8).join(' · ')}`); process.exitCode = 1; }
      else line(`VERIFY OK — every selling surcharge is 0, every cost unchanged, other companies untouched.`);
    } finally {
      await check.end({ timeout: 5 });
    }
  }
} finally {
  await sql.end({ timeout: 5 });
}
