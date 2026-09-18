#!/usr/bin/env node
/* READ-ONLY. Answers the owner's requirement, 2026-09-13:
 * 「处理 variant 关卖价什么事情呢 不要影响到我们的卖价啊 只是处理我们的 variant 啊」
 *
 * ── THE MECHANISM, read out of the code rather than assumed ────────────────
 * A picked option's SELLING surcharge folds into the line's unit price:
 * `specialsSurchargeSen` sums each option's `sellingPriceSen`
 * (shared/mfg-pricing.ts:237-254) and the recompute adds it as
 * `sellingSurchargesSen` (lib/mfg-pricing-recompute.ts:532). So stamping a
 * PRICED option onto a line CAN move that line's price on its next recompute.
 *
 * ── AND THE GUARD THAT ALREADY EXISTS, same file, :535-545 ─────────────────
 *     const isMigratedTrust = trustOperatorSelling === 'including-zero';
 *     const chargeableSurchargesSen = isMigratedTrust ? 0 : sellingSurchargesSen;
 * `'including-zero'` is derived from `linked_ac_docno IS NOT NULL`, and its
 * comment says it plainly: "A MIGRATED document must never be re-priced by this
 * engine (owner ruling A)". On a migrated document the surcharge arm is
 * STRUCTURALLY INERT — adding an option cannot move the price, priced or not.
 *
 * ── SO THE EXPOSURE IS EXACTLY ONE POPULATION ──────────────────────────────
 * A line on a NON-migrated document (`linked_ac_docno IS NULL`) carrying a
 * PRICED option. That, and only that, can gain a surcharge on the next edit.
 * This script counts it — the whole population, however the option got there,
 * not only what today's rounds wrote, because the owner's requirement is about
 * the system and not about one tool.
 *
 * It reports the same split for the options the legacy FOLD would add, so the
 * decision to fold can be made on the number rather than on a feeling.
 *
 * IT WRITES NOTHING. SELECT only, no DDL, no transaction, no UPDATE anywhere.
 *
 * RE-RUN: read-only and stateless.
 *
 *   DATABASE_URL   required
 *   COMPANY_ID     optional, default 1
 *     npx tsx scripts/check-priced-specials-exposure.mjs
 */
import postgres from 'postgres';

const DST = process.env.DATABASE_URL;
if (!DST) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const line = (s = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${s}` : s);
const rule = () => line('-'.repeat(78));
const pad = (n, w = 6) => String(n).padStart(w);
const K = (s) => String(s ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
const objOf = (v) => ((v && typeof v === 'object' && !Array.isArray(v)) ? v : null);
const rm = (sen) => `RM${(Number(sen) / 100).toFixed(2)}`;

const sql = postgres(DST, { ssl: 'require', max: 1, prepare: false });

try {
  line('='.repeat(78));
  line('PRICED OPTIONS — can fixing a variant move a selling price? Measured.');
  line('='.repeat(78));
  line(`   company ${CO}   READ-ONLY`);

  const addons = await sql`
    SELECT code, coalesce(selling_price_sen, 0)::int AS sell, active
      FROM scm.special_addons WHERE company_id = ${CO}`;
  const priceOf = new Map(addons.map((a) => [K(a.code), Number(a.sell)]));
  const priced = new Set(addons.filter((a) => Number(a.sell) !== 0).map((a) => K(a.code)));
  line(`   catalogue: ${addons.length} options, ${priced.size} of them carry a selling surcharge`);
  for (const a of addons.filter((x) => Number(x.sell) !== 0).sort((x, y) => y.sell - x.sell)) {
    line(`      ${rm(a.sell).padStart(10)}  ${a.code}${a.active === false ? '   (retired)' : ''}`);
  }

  /* The exposure population: a SALES line whose order is NOT migrated.
     `linked_ac_docno IS NOT NULL` is exactly the marker the recompute derives
     'including-zero' from (lib/mfg-pricing-recompute.ts:537-541). */
  const rows = await sql`
    SELECT i.id::text AS id, i.doc_no, i.item_code, i.variants,
           lower(coalesce(i.item_group,'')) AS grp,
           (h.linked_ac_docno IS NOT NULL) AS migrated,
           coalesce(h.status::text,'') AS status,
           coalesce(i.unit_price_sen, 0)::int AS unit_price_sen
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO}
       AND lower(coalesce(i.item_group,'')) IN ('sofa','bedframe')
       AND coalesce(i.cancelled, false) = false`;

  let migratedLines = 0;
  let nativeLines = 0;
  const exposed = [];
  const byCodeMigrated = new Map();
  const byCodeNative = new Map();
  for (const r of rows) {
    if (r.migrated) migratedLines += 1; else nativeLines += 1;
    const specials = (objOf(r.variants)?.specials ?? []).map(String);
    const hits = specials.filter((s) => priced.has(K(s)));
    if (!hits.length) continue;
    const target = r.migrated ? byCodeMigrated : byCodeNative;
    for (const h of hits) target.set(K(h), (target.get(K(h)) ?? 0) + 1);
    if (!r.migrated) {
      exposed.push({
        doc: r.doc_no, itemCode: r.item_code, status: r.status,
        unit: r.unit_price_sen,
        codes: hits, sen: hits.reduce((n, h) => n + (priceOf.get(K(h)) ?? 0), 0),
      });
    }
  }

  rule();
  line(`   sofa + bedframe sales lines                        ${pad(rows.length)}`);
  line(`   on a MIGRATED order (linked_ac_docno IS NOT NULL)  ${pad(migratedLines)}`);
  line(`      -> the surcharge arm is structurally inert here. Adding an option`);
  line(`         CANNOT move the price, priced or not. mfg-pricing-recompute.ts:535-545.`);
  line(`   on a NATIVE order (created in the ERP)             ${pad(nativeLines)}`);
  rule();
  line(`   THE EXPOSURE — native lines carrying a PRICED option: ${exposed.length}`);
  if (!exposed.length) {
    line('   ZERO. No line that a recompute would charge a surcharge to is carrying one.');
    line('   Fixing the variant cannot move any selling price.');
  } else {
    line('   These, and only these, could gain a surcharge if somebody edits the order:');
    for (const e of exposed.slice(0, 40)) {
      line(`      ${e.doc.padEnd(15)} ${String(e.itemCode).padEnd(24)} ${e.status.padEnd(10)}`
        + ` unit ${rm(e.unit).padStart(11)}  would add ${rm(e.sen).padStart(10)}   ${e.codes.join(', ')}`);
    }
    if (exposed.length > 40) line(`      ... and ${exposed.length - 40} more`);
    line('');
    line(`   total surcharge at risk across them: ${rm(exposed.reduce((n, e) => n + e.sen, 0))}`);
  }
  rule();
  line('   priced options carried, by population:');
  line(`      ${'option'.padEnd(36)} ${'migrated (inert)'.padStart(16)} ${'native (exposed)'.padStart(17)}`);
  for (const k of [...priced].sort()) {
    const m = byCodeMigrated.get(k) ?? 0;
    const n = byCodeNative.get(k) ?? 0;
    if (!m && !n) continue;
    line(`      ${k.padEnd(36)} ${pad(m, 16)} ${pad(n, 17)}`);
  }
  rule();
  line('READ-ONLY — nothing was written.');
} finally {
  await sql.end({ timeout: 5 });
}
