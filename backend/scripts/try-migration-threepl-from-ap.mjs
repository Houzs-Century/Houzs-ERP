#!/usr/bin/env node
// try-migration-threepl-from-ap.mjs — DRY RUN, ROLLED BACK. Runs migration
// 20261024T1000 (3PL invoices from the AP invoice: threepl_do_charges.
// ap_invoice_id, threepl_companies.supplier_id, one partial index) against
// PRODUCTION inside one transaction, reads back what it would leave and runs
// the 3PL list's own select, then ROLLS BACK — nothing stays, whatever the
// outcome. Env: DATABASE_URL.
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const text = readFileSync(new URL('./data/try-20261024T1000.sql', import.meta.url), 'utf8');
class Rollback extends Error {}
try {
  await sql.begin(async (tx) => {
    await tx.unsafe(text);
    const cols = await tx`SELECT table_name AS t, column_name AS c, data_type AS d, is_nullable AS n FROM information_schema.columns
      WHERE table_schema = 'scm' AND ((table_name = 'threepl_do_charges' AND column_name = 'ap_invoice_id') OR (table_name = 'threepl_companies' AND column_name = 'supplier_id'))`;
    for (const r of cols) console.log(`column ${r.t}.${r.c} ${r.d} nullable=${r.n}`);
    const idx = await tx`SELECT indexname FROM pg_indexes WHERE schemaname = 'scm' AND indexname = 'idx_threepl_do_charges_ap_invoice'`;
    console.log(`index: ${idx.map((r) => r.indexname).join(', ') || 'MISSING'}`);
    const rows = await tx`SELECT id, do_id, threepl_company_id, invoice_no, invoice_date, billed_sen, note, ap_invoice_id, created_at FROM scm.threepl_do_charges LIMIT 5`;
    console.log(`list select reads: ${rows.length} rows`);
    const carriers = await tx`SELECT company_id, name, supplier_id FROM scm.threepl_companies ORDER BY company_id, name`;
    for (const r of carriers) console.log(`  carrier co${r.company_id} ${r.name} supplier=${r.supplier_id ?? '-'}`);
    throw new Rollback();
  });
} catch (e) {
  if (e instanceof Rollback) console.log('ROLLED BACK — the migration applies cleanly; nothing was kept.');
  else { console.log(`MIGRATION FAILED (rolled back): ${e.message}`); process.exitCode = 1; }
} finally { await sql.end(); }
const after = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const still = await after`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'scm' AND table_name = 'threepl_do_charges' AND column_name = 'ap_invoice_id'`;
console.log(`after rollback, ap_invoice_id exists: ${still[0].n === 1}`);
await after.end();
