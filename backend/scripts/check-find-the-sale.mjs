#!/usr/bin/env node
// check-find-the-sale.mjs — READ-ONLY. Owner 2026-11-09: 「为什么我按find the
// sales 还有这么多？」 on 2990's Merchant Recon. What the listed payments are
// (method, bank, online type), whether a merchant line or a bank line already
// holds them, and how many such payments the company has in total.
// One READ ONLY transaction; MODE=apply refused. Env: DATABASE_URL, COMPANY_ID (2).
import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if ((process.env.MODE || 'plan') !== 'plan') { console.error('read-only: mode=plan'); process.exit(1); }
const sql = postgres(process.env.DATABASE_URL, {
  max: 1, prepare: false,
  types: { date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } },
});
const CO = Number(process.env.COMPANY_ID || 2);
const DOCS = ['2990-SO-2609-042', '2990-SO-2608-069', '2990-SO-2608-048', '2990-SO-2609-031', '2990-SO-2609-032', '2990-SO-2608-037',
  '2990-SO-2608-054', '2990-SO-2609-014', '2990-SO-2608-005', '2990-SO-2609-008', '2990-SO-2608-070', '2990-SO-2609-001',
  '2990-SO-2608-067', '2990-SO-2606-008', '2990-SO-2608-047', '2990-SO-2607-028', '2990-SO-2607-026', '2990-SO-2608-019', '2990-SO-2608-020'];
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? '—' : String(v).slice(0, 10));
const row = (...p) => console.log(`ROW|${p.join('|')}`);

try {
  await sql.begin('read only', async (tx) => {
    /* Each payment's live journal entry and whether a POSTED bank line holds it. */
    const enrich = async (pays) => {
      const ids = pays.map((p) => p.id);
      if (ids.length === 0) return new Map();
      const jes = await tx`
        SELECT je.source_doc_no, je.je_no FROM scm.journal_entries je
         WHERE je.company_id = ${CO} AND je.source_type = 'SOPAY' AND je.source_doc_no IN ${tx(ids)} AND je.posted AND NOT coalesce(je.reversed, false)`;
      const jeNos = jes.map((j) => j.je_no);
      const held = jeNos.length === 0 ? [] : await tx`
        SELECT m.je_no FROM scm.acc_bank_statement_matches m JOIN scm.acc_bank_statement_lines l ON l.id = m.bank_line_id
         WHERE m.company_id = ${CO} AND l.state = 'POSTED' AND m.je_no IN ${tx(jeNos)}
        UNION SELECT l.posted_je_no FROM scm.acc_bank_statement_lines l WHERE l.company_id = ${CO} AND l.state = 'POSTED' AND l.posted_je_no IN ${tx(jeNos)}`;
      const heldSet = new Set(held.map((h) => h.je_no ?? h.posted_je_no));
      const out = new Map();
      for (const j of jes) out.set(String(j.source_doc_no), { jeNo: j.je_no, bank: heldSet.has(j.je_no) });
      return out;
    };

    console.log('\n=== The payments on his screen');
    const listed = await tx`
      SELECT p.id::text AS id, p.so_doc_no, p.paid_at, p.amount_sen, p.method, p.merchant_provider, p.online_type, p.approval_code, p.account_sheet,
             (SELECT count(*) FROM scm.acc_settlement_matches m WHERE m.payment_id = p.id::text) AS on_merchant
        FROM scm.mfg_sales_order_payments p
       WHERE p.company_id = ${CO} AND p.so_doc_no IN ${tx(DOCS)} AND p.method NOT IN ('cash', 'converted')
       ORDER BY p.paid_at DESC`;
    const info = await enrich(listed);
    for (const p of listed) {
      const e = info.get(p.id);
      row('LISTED', p.so_doc_no, day(p.paid_at), `RM ${rm(p.amount_sen)}`, p.method, `bank ${p.merchant_provider ?? '—'}`, `online ${p.online_type ?? '—'}`,
        `code ${p.approval_code ?? '—'}`, `sheet ${p.account_sheet ?? '—'}`, `merchant line ${Number(p.on_merchant) > 0 ? 'yes' : 'no'}`,
        `JE ${e?.jeNo ?? '—'}`, `bank line ${e?.bank ? 'yes' : 'no'}`);
    }

    console.log('\n=== Totals, company payments no merchant line holds (what Find the sale can list)');
    for (const kind of [{ name: 'Online (transfer)', methods: ['transfer'] }, { name: 'card (merchant/installment/imported)', methods: ['merchant', 'installment', 'imported'] }]) {
      const pays = await tx`
        SELECT p.id::text AS id, p.paid_at, p.amount_sen, p.method, p.merchant_provider
          FROM scm.mfg_sales_order_payments p
          LEFT JOIN scm.mfg_sales_orders o ON o.doc_no = p.so_doc_no AND o.company_id = p.company_id
         WHERE p.company_id = ${CO} AND p.method IN ${tx(kind.methods)}
           AND coalesce(upper(o.status::text), '') <> 'CANCELLED'
           AND NOT EXISTS (SELECT 1 FROM scm.acc_settlement_matches m WHERE m.payment_id = p.id::text)`;
      const e = await enrich(pays);
      const byMonth = new Map();
      let onBank = 0; let untagged = 0;
      for (const p of pays) {
        const m = day(p.paid_at).slice(0, 7);
        const t = byMonth.get(m) ?? { n: 0, sen: 0, bank: 0 };
        t.n += 1; t.sen += Number(p.amount_sen);
        if (e.get(p.id)?.bank) { t.bank += 1; onBank += 1; }
        byMonth.set(m, t);
        if (p.merchant_provider == null || String(p.merchant_provider).trim() === '') untagged += 1;
      }
      row('TOTAL', kind.name, `payments ${pays.length}`, `no bank keyed ${untagged}`, `already matched on a bank line ${onBank}`);
      for (const [m, t] of [...byMonth].sort()) row('  MONTH', kind.name, m, `n ${t.n}`, `RM ${rm(t.sen)}`, `on a bank line ${t.bank}`);
    }
  });
  console.log('\nRead-only: nothing was written.');
} finally {
  await sql.end();
}
