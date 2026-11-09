#!/usr/bin/env node
// check-draft-receipts-banked.mjs: READ ONLY, one READ ONLY transaction, writes nothing.
// Owner 2026-11-09 (Receipts, "Draft · money not confirmed 71": 这个不是我bank recon了就
// confirm 了？): today a transfer's draft receipt turns formal only by Confirm money. How
// many DRAFT receipts, per company, kind of money and month, have their payment's journal
// already matched to a bank line (POSTED) in Bank recon — i.e. the money was seen?
import postgres from 'postgres';
import { pgSslMode } from './lib/pg-ssl-mode.mjs';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(2); }
if (process.env.APPLY === '1') { console.error('Read only.'); process.exit(1); }
const sql = postgres(url, { ssl: pgSslMode(url), max: 1, prepare: false });
const out = (s) => console.log(`ROW|${s}`);

await sql.begin('READ ONLY', async (tx) => {
  const rows = await tx`
    WITH d AS (
      SELECT r.id, r.company_id, r.or_number, r.method, r.amount_sen, r.paid_at, r.payment_source, r.payment_id
        FROM scm.acc_official_receipts r
       WHERE r.status = 'DRAFT'
    ), j AS (
      SELECT d.id, (SELECT g.je_no FROM scm.v_gl_entries g
                     WHERE g.company_id = d.company_id AND g.source_type = d.payment_source AND g.source_doc_no = d.payment_id
                       AND g.posted AND NOT COALESCE(g.reversed, false) ORDER BY g.entry_date DESC LIMIT 1) AS je_no
        FROM d
    )
    SELECT d.company_id, COALESCE(d.method, '∅') AS method, to_char(d.paid_at, 'YYYY-MM') AS month,
           count(*)::int AS drafts,
           count(*) FILTER (WHERE j.je_no IS NULL)::int AS no_journal,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM scm.acc_bank_statement_matches m JOIN scm.acc_bank_statement_lines l ON l.id = m.bank_line_id
              WHERE m.company_id = d.company_id AND m.je_no = j.je_no AND to_jsonb(l)->>'state' = 'POSTED'))::int AS banked,
           sum(d.amount_sen)::bigint AS sen
      FROM d JOIN j ON j.id = d.id
     GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`;
  let all = 0; let banked = 0;
  for (const r of rows) {
    all += r.drafts; banked += r.banked;
    out(`co${r.company_id} ${r.method} ${r.month ?? '∅'}: drafts ${r.drafts} (RM ${(Number(r.sen) / 100).toFixed(2)}) · matched in Bank recon ${r.banked} · no journal ${r.no_journal}`);
  }
  out(`TOTAL drafts ${all} · their money matched in Bank recon ${banked}`);
});
await sql.end();
