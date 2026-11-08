#!/usr/bin/env node
// check-cashflow-nov-dep.mjs: READ ONLY, one READ ONLY transaction, writes nothing.
// 2990's November "Deposit · Card - not matched yet": RM 32,820 now, RM 31,200 on the owner's
// screenshot of 2026-11-08. Which payments make it, and when was each keyed or changed?
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { pgSslMode } from './lib/pg-ssl-mode.mjs';
import { buildReceiptsPayments, rpDbSources } from '../src/scm/routes/accounting-rp.ts';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(2); }
if (process.env.APPLY === '1') { console.error('Read only.'); process.exit(1); }
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const sql = postgres(url, { ssl: pgSslMode(url), max: 1, prepare: false, types: { dateText: asText(1082), tsText: asText(1114), tstzText: asText(1184) } });
const out = (s) => console.log(`ROW|${s}`);
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const CO = 2;

await sql.begin('READ ONLY', async (tx) => {
  await tx`SET LOCAL search_path = public, scm`;
  const r = await buildReceiptsPayments(CO, { from: '2026-11-01', to: '2026-11-08', byParty: false, wanted: [] }, rpDbSources(pgrestShim(tx, 'scm'), CO, []));
  if (!r.ok) throw new Error(r.reason);
  const mine = r.report.entries.filter((e) => e.rowKey.endsWith(':DEP:CARD-UNMATCHED') || e.rowKey.endsWith(':DEP:CARD-MATCHED'));
  const ids = [...new Set(mine.map((e) => e.sourceDocNo))];
  const pays = ids.length ? await tx`
    SELECT p.id::text AS id, p.so_doc_no, p.amount_sen, p.paid_at, p.created_at, p.updated_at, p.method, p.merchant_provider, p.approval_code
      FROM scm.mfg_sales_order_payments p WHERE p.company_id = ${CO} AND p.id::text IN ${tx(ids)}` : [];
  const byId = new Map(pays.map((p) => [p.id, p]));
  const jes = ids.length ? await tx`
    SELECT je.source_doc_no, je.je_no, je.entry_date, je.created_at
      FROM scm.journal_entries je WHERE je.company_id = ${CO} AND je.source_type = 'SOPAY' AND je.source_doc_no IN ${tx(ids)}` : [];
  const jeOf = new Map(jes.map((j) => [j.source_doc_no, j]));
  out(`2990 Nov 1-8: Deposit card rows ${mine.length} amounts, matched RM ${rm(mine.filter((e) => e.rowKey.endsWith('MATCHED') && !e.rowKey.endsWith('UNMATCHED')).reduce((s, e) => s + e.sen, 0))}, not matched RM ${rm(mine.filter((e) => e.rowKey.endsWith('UNMATCHED')).reduce((s, e) => s + e.sen, 0))}`);
  for (const e of mine.sort((a, b) => String(byId.get(b.sourceDocNo)?.created_at).localeCompare(String(byId.get(a.sourceDocNo)?.created_at)))) {
    const p = byId.get(e.sourceDocNo);
    const j = jeOf.get(e.sourceDocNo);
    out(`   ${e.rowKey.split(':').pop()} RM ${rm(e.sen)} | ${p?.so_doc_no} paid ${String(p?.paid_at).slice(0, 10)} keyed ${String(p?.created_at).slice(0, 19)} changed ${String(p?.updated_at).slice(0, 19)} | ${p?.merchant_provider ?? '-'} ${p?.approval_code ?? '-'} | journal ${j?.je_no ?? '-'} ${String(j?.entry_date ?? '').slice(0, 10)} made ${String(j?.created_at ?? '').slice(0, 19)}`);
  }
  /* Anything about 2990's payments that moved today. */
  const today = await tx`
    SELECT so_doc_no, amount_sen, paid_at, created_at, updated_at, method FROM scm.mfg_sales_order_payments
     WHERE company_id = ${CO} AND (created_at >= '2026-11-07T16:00:00Z' OR updated_at >= '2026-11-07T16:00:00Z') ORDER BY created_at`;
  out(`2990 payments keyed or changed since 2026-11-08 00:00 MYT: ${today.length}`);
  for (const p of today) out(`   ${p.so_doc_no} RM ${rm(p.amount_sen)} ${p.method} paid ${String(p.paid_at).slice(0, 10)} keyed ${String(p.created_at).slice(0, 19)} changed ${String(p.updated_at).slice(0, 19)}`);
});
await sql.end();
