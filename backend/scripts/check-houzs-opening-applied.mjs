#!/usr/bin/env node
/* check-houzs-opening-applied.mjs — READ ONLY. After open-houzs-books-start.mjs
   MODE=apply (owner 2026-10-28 「A，入账」): what the books now hold, read back
   through the books' own views — the start day and opening stock, the opening
   papers and journals, the clearing (nil), the 31/08 balance of the books, the
   creditors and other debtors at 31/08, and the four recoded suppliers.
   Env: DATABASE_URL, COMPANY_ID (1). Writes nothing. */
import postgres from 'postgres';

const CO = Number(process.env.COMPANY_ID || 1);
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const out = (s) => console.log(`ROW|${s}`);

async function main() {
  if (String(process.env.MODE || 'plan') !== 'plan') { console.error('read-only: MODE must be plan'); process.exit(2); }
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    const s = await sql`SELECT books_start_date::text AS start, opening_stock, opening_locked_at FROM scm.acc_company_settings WHERE company_id = ${CO}`;
    out(`settings: start ${s[0]?.start ?? '-'}, opening stock ${JSON.stringify(s[0]?.opening_stock ?? null)}, locked ${s[0]?.opening_locked_at ?? 'no'}`);
    const docs = await sql`SELECT
        (SELECT count(*) FROM scm.ap_invoices WHERE company_id = ${CO} AND opening AND status <> 'CANCELLED')::int AS api,
        (SELECT count(*) FROM scm.acc_credit_notes WHERE company_id = ${CO} AND opening AND status <> 'CANCELLED')::int AS scn,
        (SELECT count(*) FROM scm.acc_debtor_bills WHERE company_id = ${CO} AND opening AND status <> 'CANCELLED')::int AS odb,
        (SELECT count(*) FROM scm.acc_debtor_receipts WHERE company_id = ${CO} AND opening AND status <> 'CANCELLED')::int AS odr,
        (SELECT count(*) FROM scm.journal_entries WHERE company_id = ${CO} AND opening AND posted AND NOT reversed)::int AS je`;
    out(`opening papers: ${JSON.stringify(docs[0])}`);
    const clear = await sql`SELECT coalesce(sum(debit_sen - credit_sen), 0)::bigint AS b FROM scm.v_gl_entries WHERE company_id = ${CO} AND account_code = '190-0000' AND NOT reversed AND reversed_by_je IS NULL`;
    const tb31 = await sql`SELECT coalesce(sum(debit_sen - credit_sen), 0)::bigint AS b, count(*)::int AS n FROM scm.v_gl_entries WHERE company_id = ${CO} AND entry_date <= '2026-08-31' AND NOT reversed AND reversed_by_je IS NULL`;
    out(`190-0000 over all dates: ${rm(clear[0].b)}; books at 31/08: ${tb31[0].n} lines, net ${rm(tb31[0].b)}`);
    const key = await sql`SELECT account_code, coalesce(sum(debit_sen - credit_sen), 0)::bigint AS b FROM scm.v_gl_entries
        WHERE company_id = ${CO} AND entry_date <= '2026-08-31' AND NOT reversed AND reversed_by_je IS NULL
          AND account_code IN ('150-0000', '310-0010', '310-0020', '440-0000', '400-0000', '405-0000', '305-0000', '300-0000') GROUP BY 1 ORDER BY 1`;
    out(`31/08: ${key.map((k) => `${k.account_code} ${rm(k.b)}`).join(', ')}`);
    const sups = await sql`SELECT code, name FROM scm.suppliers WHERE company_id = ${CO} AND code IN ('400-B006', '405-E002', '405-C003', '405-H004')`;
    out(`recoded suppliers: ${sups.map((x) => `${x.code} ${x.name}`).join('; ')}`);
    const sep = await sql`SELECT source_doc_no, je_no, entry_date::text AS d FROM scm.journal_entries WHERE company_id = ${CO} AND source_type = 'PI'
        AND source_doc_no IN ('HC-PI-2609-023', 'HC-PI-2609-024') AND posted AND NOT reversed ORDER BY 1`;
    out(`Diglant bills owed in September: ${sep.map((x) => `${x.source_doc_no} ${x.je_no} ${x.d}`).join('; ')}`);
  } finally {
    await sql.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
