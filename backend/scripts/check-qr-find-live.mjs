#!/usr/bin/env node
// check-qr-find-live.mjs — READ-ONLY. Runs the shipped "Find the sale"
// (acc/settlement findPaymentsForRow) on one Merchant Recon line, against the
// live database, inside one READ ONLY transaction, and prints what it offers —
// to confirm #5454 (owner 2026-11-09: 已经match 的就不应该出现). MODE=apply refused.
// Env: DATABASE_URL, COMPANY_ID, ROW_ID.
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { findPaymentsForRow } from '../src/acc/settlement.ts';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if ((process.env.MODE || 'plan') !== 'plan') { console.error('read-only: mode=plan'); process.exit(1); }
const CO = Number(process.env.COMPANY_ID);
const ROW = Number(process.env.ROW_ID);
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, types: { date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } } });
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
try {
  await sql.begin('read only', async (tx) => {
    const [row] = await tx`SELECT id, txn_date, gross_sen, channel, bucket FROM scm.acc_settlement_rows WHERE id = ${ROW} AND company_id = ${CO}`;
    console.log(`LINE ${ROW}: ${JSON.stringify(row ?? null)}`);
    const out = await findPaymentsForRow(pgrestShim(tx, 'scm'), CO, ROW, '', 500);
    if (!out.ok) { console.log(`REFUSED: ${out.status} ${out.reason}`); return; }
    console.log(`OFFERED: ${out.payments.length} payment(s)`);
    for (const p of out.payments) console.log(`ROW|${p.docNo}|${p.paidOn}|RM ${rm(p.amountSen)}|${p.method}|${p.possible ? 'possible' : ''}|${p.customerName ?? '—'}`);
  });
  console.log('Read-only: nothing was written.');
} finally {
  await sql.end();
}
