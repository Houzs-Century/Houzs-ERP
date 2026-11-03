#!/usr/bin/env node
// check-settle-group-dryrun.mjs — READ ONLY (everything rolled back). Runs migration
// 20261103T1200_acc_settlement_row_groups.sql on production inside one transaction
// (twice — it must be idempotent), then confirms the owner's two swipes TOGETHER
// against the two orders through the app's own code (confirmSettlementGroup), prints
// the entries it books and the links it writes, takes the group back from its second
// line (unconfirmSettlementRow) — and rolls it all back.
// Env: DATABASE_URL, COMPANY_ID, ACQUIRER, DAY (YYYY-MM-DD), GROSS (sen, comma-separated),
//      DOCS (SO numbers, comma-separated).
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { confirmSettlementGroup, unconfirmSettlementRow } from '../src/acc/settlement.ts';

const CO = Number(process.env.COMPANY_ID);
const ACQ = String(process.env.ACQUIRER ?? '').trim();
const DAY = String(process.env.DAY ?? '').trim();
const GROSS = String(process.env.GROSS ?? '').split(',').map((g) => Number(g.trim())).filter((n) => Number.isInteger(n) && n > 0);
const DOCS = String(process.env.DOCS ?? '').split(',').map((d) => d.trim()).filter(Boolean);
if (!Number.isInteger(CO) || !ACQ || !/^\d{4}-\d{2}-\d{2}$/.test(DAY) || GROSS.length < 2 || DOCS.length === 0) {
  console.error('Refused: COMPANY_ID, ACQUIRER, DAY, GROSS (two or more) and DOCS are required.');
  process.exit(2);
}

const MIGRATION = new URL('../src/db/migrations-pg/20261103T1200_acc_settlement_row_groups.sql', import.meta.url);
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, types: { dateText: asText(1082), tsText: asText(1114), tstzText: asText(1184) } });
const out = (s) => console.log(`ROW|${s}`);
const rm = (sen) => `RM ${(Number(sen ?? 0) / 100).toFixed(2)}`;
class Rollback extends Error {}

try {
  await sql.begin(async (tx) => {
    await tx.unsafe(readFileSync(MIGRATION, 'utf8'));
    await tx.unsafe(readFileSync(MIGRATION, 'utf8'));
    const [col] = await tx`SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'scm' AND table_name = 'acc_settlement_rows' AND column_name = 'matched_with_row_id'`;
    out(`migration ran twice; matched_with_row_id ${col?.data_type} nullable=${col?.is_nullable}`);

    const lines = await tx`SELECT id, batch_id, line_no, txn_date, ref, gross_sen, fee_sen, bucket, confirmed_at
      FROM scm.acc_settlement_rows WHERE company_id = ${CO} AND acquirer_code = ${ACQ} AND txn_date = ${DAY}
      ORDER BY batch_id, line_no`;
    for (const l of lines) out(`line ${l.line_no} (#${l.id}, report ${l.batch_id}) ${l.txn_date} ref ${l.ref ?? '-'} gross ${rm(l.gross_sen)} fee ${rm(l.fee_sen)} ${l.bucket}${l.confirmed_at ? ' CONFIRMED' : ''}`);
    const pick = GROSS.map((g) => lines.find((l) => Number(l.gross_sen) === g && !l.confirmed_at && l.bucket !== 'IGNORED'));
    if (pick.some((l) => !l)) { out(`not every gross in ${GROSS.join(', ')} has an open line on ${DAY}`); throw new Rollback(); }

    const pays = await tx`SELECT id, so_doc_no, amount_sen, method, merchant_provider, paid_at
      FROM scm.mfg_sales_order_payments WHERE company_id = ${CO} AND so_doc_no IN ${tx(DOCS)} ORDER BY so_doc_no, paid_at`;
    for (const p of pays) out(`payment ${p.so_doc_no} ${rm(p.amount_sen)} ${p.method} ${p.merchant_provider ?? '(no bank)'} paid ${String(p.paid_at).slice(0, 16)} id ${p.id}`);
    const card = pays.filter((p) => ['merchant', 'installment', 'imported'].includes(String(p.method)));
    out(`group: lines ${pick.map((l) => l.line_no).join(' + ')} = ${rm(GROSS.reduce((t, g) => t + g, 0))} against ${card.map((p) => p.so_doc_no).join(' + ')} = ${rm(card.reduce((t, p) => t + Number(p.amount_sen), 0))}`);

    const sb = pgrestShim(tx, 'scm');
    const r = await confirmSettlementGroup(sb, {
      companyId: CO, rowIds: pick.map((l) => Number(l.id)), userName: 'dry-run',
      payments: card.map((p) => ({ source: 'SOPAY', id: String(p.id), docNo: p.so_doc_no, amountSen: Number(p.amount_sen) })),
    });
    out(`confirm together: ${JSON.stringify(r)}`);

    const ids = pick.map((l) => Number(l.id));
    const keys = [...ids.map((id) => `SETTLE-${id}`), ...ids.map((id) => `SETTLEMOVE-${id}`)];
    const jes = await tx`SELECT id, je_no, entry_date, source_type, source_doc_no, narration FROM scm.journal_entries
      WHERE company_id = ${CO} AND source_doc_no IN ${tx(keys)} ORDER BY je_no`;
    for (const j of jes) {
      out(`${j.je_no} ${j.entry_date} ${j.source_type} ${j.source_doc_no} — ${j.narration}`);
      const ls = await tx`SELECT account_code, debit_sen, credit_sen FROM scm.journal_entry_lines WHERE journal_entry_id = ${j.id} ORDER BY debit_sen DESC`;
      for (const l of ls) out(`    ${l.account_code} Dr ${rm(l.debit_sen)} Cr ${rm(l.credit_sen)}`);
    }
    const after = await tx`SELECT id, line_no, bucket, posted_je_no, matched_with_row_id FROM scm.acc_settlement_rows WHERE id IN ${tx(ids)} ORDER BY line_no`;
    for (const a of after) out(`after: line ${a.line_no} ${a.bucket} je ${a.posted_je_no ?? '-'} with ${a.matched_with_row_id ?? '(lead)'}`);
    const links = await tx`SELECT settlement_row_id, doc_no, amount_sen FROM scm.acc_settlement_matches WHERE settlement_row_id IN ${tx(ids)} ORDER BY doc_no`;
    for (const l of links) out(`link: row ${l.settlement_row_id} ${l.doc_no} ${rm(l.amount_sen)}`);

    if (r.ok) {
      const u = await unconfirmSettlementRow(sb, CO, ids[ids.length - 1]);
      out(`undo from the last line: ${JSON.stringify(u)}`);
      const back = await tx`SELECT line_no, bucket, confirmed_at, matched_with_row_id FROM scm.acc_settlement_rows WHERE id IN ${tx(ids)} ORDER BY line_no`;
      for (const b of back) out(`after undo: line ${b.line_no} ${b.bucket} confirmed=${b.confirmed_at != null} with ${b.matched_with_row_id ?? '-'}`);
      const [{ n }] = await tx`SELECT count(*)::int AS n FROM scm.acc_settlement_matches WHERE settlement_row_id IN ${tx(ids)}`;
      out(`links left after undo: ${n}`);
    }
    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) { out(`FAILED: ${e?.stack ?? e?.message ?? e}`); process.exitCode = 1; }
  else out('rolled back — nothing kept');
} finally {
  await sql.end();
}
