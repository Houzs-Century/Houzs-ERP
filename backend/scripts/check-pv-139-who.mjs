#!/usr/bin/env node
// check-pv-139-who.mjs: READ ONLY, one READ ONLY transaction, writes nothing.
// HC-Draft-2610-150 became HC-HPV-2610-139 this morning: who prepared and checked it, and
// the fair's Rental row as it stands now.
import postgres from 'postgres';
import { d1Compat } from '../src/db/d1-compat.ts';
import { pgSslMode } from './lib/pg-ssl-mode.mjs';
import { booksLinesFor, readCheckedVoucherLegs, readEventBooks, withCheckedVouchers } from '../src/scm/lib/event-books.ts';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(2); }
if (process.env.APPLY === '1') { console.error('Read only.'); process.exit(1); }
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const sql = postgres(url, { ssl: pgSslMode(url), max: 1, prepare: false, types: { dateText: asText(1082), tsText: asText(1114), tstzText: asText(1184) } });
const out = (s) => console.log(`ROW|${s}`);

await sql.begin('READ ONLY', async (tx) => {
  await tx`SET LOCAL search_path = public, scm`;
  const [p] = await tx`SELECT pv_number, status, submitted_at, submitted_by, checked_at, checked_by, approved_at, approved_by, updated_at FROM scm.payment_vouchers WHERE pv_number = 'HC-HPV-2610-139' AND company_id = 1`;
  out(`voucher ${JSON.stringify(p)}`);
  const db = d1Compat(() => tx);
  const merged = withCheckedVouchers(await readEventBooks(db, 2261, 1), await readCheckedVoucherLegs(db, 2261, 1));
  if (!merged.ok) throw new Error(merged.reason);
  const rental = booksLinesFor(2261, merged.legs).filter((b) => b.category === 'rental');
  out(`fair 2261 Rental: ${rental.map((b) => `${b.doc_no} ${b.amount.toFixed(2)}`).join(' ; ')}`);
});
await sql.end();
