#!/usr/bin/env node
// check-batch-nets.mjs: READ ONLY, one READ ONLY transaction, writes nothing.
// What each open merchant report says it pays (the figure the screen prints as "net RM …"),
// for the sample PDF of "Merchant reports still to reconcile". Numbers and ids only.
import postgres from 'postgres';
import { pgSslMode } from './lib/pg-ssl-mode.mjs';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(2); }
if (process.env.APPLY === '1') { console.error('Read only.'); process.exit(1); }
const sql = postgres(url, { ssl: pgSslMode(url), max: 1, prepare: false });
await sql.begin('READ ONLY', async (tx) => {
  const rows = await tx`
    SELECT b.id, b.net_sen, b.stated_net_sen
      FROM scm.acc_settlement_batches b
     WHERE b.company_id = 1
       AND EXISTS (SELECT 1 FROM scm.acc_settlement_rows r WHERE r.batch_id = b.id AND r.confirmed_at IS NULL AND r.bucket::text <> 'IGNORED')
     ORDER BY b.id`;
  for (const r of rows) console.log(`NET|${r.id}|${r.net_sen}|${r.stated_net_sen ?? ''}`);
  console.log(`ROW|open reports ${rows.length}`);
});
await sql.end();
