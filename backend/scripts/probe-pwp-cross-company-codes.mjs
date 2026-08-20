#!/usr/bin/env node
/**
 * Did the pwp_codes cross-company hazard ever actually fire?
 *
 * mig 0188 re-keyed scm.pwp_codes from PRIMARY KEY(code) to (company_id, code),
 * so two companies may hold the SAME code string. Four writes then keyed on
 * `code` alone — the atomic claim that BURNS a voucher, its rollback, and the
 * two TBC sofa-swap re-points — and would reach whichever row sorted first.
 *
 * The exposure is NOT "the code was unscoped". It is "the code was unscoped AND
 * some other company held the same string". This asks the second question,
 * which is the one that decides whether anything has to be repaired.
 *
 * Read-only. Prints counts and the colliding codes; changes nothing.
 *
 *   node backend/scripts/probe-pwp-cross-company-codes.mjs
 */
import { readFileSync } from 'node:fs';

const DSN = process.env.DATABASE_URL || process.env.PG_DSN || '';
if (!DSN) {
  console.error('Set DATABASE_URL (or PG_DSN) to the ERP postgres DSN. Nothing was read.');
  console.error('This script never embeds a credential — see CLAUDE.md rule on secrets.');
  process.exit(2);
}

const { default: pg } = await import('pg');
const client = new pg.Client({ connectionString: DSN });
await client.connect();

try {
  /* 1. Can it collide at all? Codes held by more than one company. */
  const dup = await client.query(`
    SELECT code, count(*) AS companies, array_agg(company_id ORDER BY company_id) AS company_ids
      FROM scm.pwp_codes
     GROUP BY code
    HAVING count(*) > 1
     ORDER BY count(*) DESC, code
     LIMIT 200`);

  console.log(`codes held by MORE THAN ONE company: ${dup.rowCount}`);
  if (dup.rowCount === 0) {
    console.log('  -> the hazard could never have fired: no code string is shared.');
  } else {
    for (const r of dup.rows) console.log(`  ${r.code}  companies=${r.company_ids.join(',')}`);
  }

  /* 2. Did a burn land on a row whose company disagrees with the SO that burned
        it? That is the footprint an actual mis-claim would leave. */
  const mis = await client.query(`
    SELECT p.code, p.company_id AS code_company, s.company_id AS order_company,
           p.redeemed_doc_no, p.status, p.updated_at
      FROM scm.pwp_codes p
      JOIN scm.mfg_sales_orders s ON s.doc_no = p.redeemed_doc_no
     WHERE p.redeemed_doc_no IS NOT NULL
       AND s.company_id IS DISTINCT FROM p.company_id
     ORDER BY p.updated_at DESC
     LIMIT 200`);

  console.log(`\nvouchers redeemed by an order belonging to a DIFFERENT company: ${mis.rowCount}`);
  for (const r of mis.rows) {
    console.log(`  ${r.code}  code_company=${r.code_company} order_company=${r.order_company} ` +
                `doc=${r.redeemed_doc_no} status=${r.status} at=${r.updated_at?.toISOString?.() ?? r.updated_at}`);
  }
  if (mis.rowCount === 0) console.log('  -> no evidence the hazard ever fired.');
  else console.log('  -> THESE NEED REPAIR. Each row was burned by another company\'s order.');
} finally {
  await client.end();
}
