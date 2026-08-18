#!/usr/bin/env node
/**
 * Does Houzs hold ANY row in the POS-only tables ported from 2990's?
 *
 * On 2026-06-18 (5d384d6d) the whole 2990's SCM backend was ported into Houzs —
 * 37 routes in one commit. 2990's is a retail showroom business; Houzs is
 * manufacture-and-wholesale. The owner's account of how Houzs actually works:
 * pick the SKU, type the amount. No quick-picks, no free-gift engine, no
 * purchase-with-purchase, no delivery-fee engine. Orders arrive from 2990's over
 * an API carrying only "which SKU, how much".
 *
 * That makes these tables a prediction, and this script tests it. Per company,
 * per table, one count. It answers the question a code search cannot: not "is
 * this route called" but "did anything ever land in it".
 *
 * A non-zero for Houzs is the interesting result — it means the feature ran, and
 * the module is not dead after all. Read-only.
 *
 *   DATABASE_URL=... node backend/scripts/probe-pos-only-tables-by-company.mjs
 */
const DSN = process.env.DATABASE_URL || process.env.PG_DSN || '';
if (!DSN) {
  console.error('Set DATABASE_URL (or PG_DSN). This script embeds no credential — see CLAUDE.md.');
  process.exit(2);
}

/* The tables the removed / candidate modules own. Kept as a literal list rather
   than derived, so a rename cannot silently shrink what gets asked. */
const TABLES = [
  'pos_cart', 'pos_pools',
  'personal_quick_picks', 'sofa_quick_picks',
  'free_item_campaigns', 'model_free_gifts',
  'pwp_codes', 'pwp_rules',
  'delivery_fees', 'fabric_tier_addon',
  'payment_audit_log', 'maintenance_push',
  'so_settings', 'sales_analysis',
];

const { default: pg } = await import('pg');
const client = new pg.Client({ connectionString: DSN });
await client.connect();

try {
  const companies = await client.query(
    `SELECT id, code, name FROM public.companies ORDER BY id`);
  console.log('companies: ' + companies.rows.map((r) => `${r.id}=${r.code}`).join('  '));
  console.log('');

  const present = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'scm' AND table_name = ANY($1::text[])`, [TABLES]);
  const have = new Set(present.rows.map((r) => r.table_name));

  const missing = TABLES.filter((t) => !have.has(t));
  if (missing.length) console.log(`not in the scm schema at all: ${missing.join(', ')}\n`);

  const hdr = ['table'.padEnd(24), 'total'.padStart(8),
    ...companies.rows.map((c) => String(c.code).padStart(10))].join('');
  console.log(hdr);
  console.log('-'.repeat(hdr.length));

  for (const t of TABLES) {
    if (!have.has(t)) continue;
    const hasCo = await client.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema='scm' AND table_name=$1 AND column_name='company_id'`, [t]);
    const total = (await client.query(`SELECT count(*)::int AS n FROM scm.${t}`)).rows[0].n;
    const cells = [];
    for (const c of companies.rows) {
      if (!hasCo.rowCount) { cells.push('n/a'.padStart(10)); continue; }
      const n = (await client.query(
        `SELECT count(*)::int AS n FROM scm.${t} WHERE company_id = $1`, [c.id])).rows[0].n;
      cells.push(String(n).padStart(10));
    }
    console.log(t.padEnd(24) + String(total).padStart(8) + cells.join(''));
  }

  console.log('\nRead this as: a column of zeros for a company means that company never');
  console.log('used the feature. A non-zero under Houzs means the module is NOT dead and');
  console.log('its removal has to be reconsidered, not argued about.');
} finally {
  await client.end();
}
