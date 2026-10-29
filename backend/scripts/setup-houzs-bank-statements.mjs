#!/usr/bin/env node
// setup-houzs-bank-statements.mjs — Houzs's eight bank accounts take a statement
// (owner 2026-10-29: 「houzs 现在bank statement recon 要setup bank 先？」 → yes →
// 「做，户口号码先空着」). Writes what Recon Setup → Bank statements → + Add account
// saves, once per account (bankConfigSave, src/scm/routes/accounting-bank-config.ts):
// the account must be an active MONEY account of this company's chart; no account
// number yet (he gives them later — until then a file is not checked for one);
// Maybank and Hong Leong copy 2990's own setups (company 2, the ones its uploads
// already read), the other banks read by the reader's built-in headings.
//
// MODE=plan (the default) prints the rows and writes nothing. MODE=apply with
// CONFIRM="SET UP HOUZS BANK STATEMENTS" inserts the missing ones in one
// transaction, then reads them back on a fresh connection. An account that already
// has a setup is left exactly as it is.
// Env: DATABASE_URL, COMPANY_ID (1), TEMPLATE_COMPANY_ID (2).
import postgres from 'postgres';

const PHRASE = 'SET UP HOUZS BANK STATEMENTS';
const CO = Number(process.env.COMPANY_ID || 1);
const TEMPLATE_CO = Number(process.env.TEMPLATE_COMPANY_ID || 2);
const MODE = String(process.env.MODE || 'plan').trim().toLowerCase();
const APPLY = MODE === 'apply' || process.env.APPLY === '1';
const stop = (msg, code = 1) => { console.error(msg); process.exit(code); };
if (APPLY && (process.env.CONFIRM ?? '').trim() !== PHRASE) stop(`CONFIRM must be exactly "${PHRASE}" to apply. Nothing was written.`, 2);
if (CO === TEMPLATE_CO) stop('COMPANY_ID and TEMPLATE_COMPANY_ID are the same company.');

/* Which bank each account is, and whose setup it copies. TEMPLATE = 2990's row
   for that bank; null = the reader's built-in headings (an empty column map,
   CSV, comma, decimal, CR — the form's own defaults). */
const WANT = [
  { account_code: '310-0010', bank_code: 'MBB', template: 'MBB' },
  { account_code: '310-0020', bank_code: 'HLB', template: 'HLB' },
  { account_code: '310-0030', bank_code: 'ALLIANCE', template: null },
  { account_code: '310-0040', bank_code: 'UOB', template: null },
  { account_code: '310-0050', bank_code: 'CIMB', template: null },
  { account_code: '310-0060', bank_code: 'MBB', template: 'MBB' },
  { account_code: '310-0090', bank_code: 'UOB', template: null },
  { account_code: '310-0100', bank_code: 'MBB', template: 'MBB' },
];
const BUILT_IN = { statement_format: 'CSV', delimiter: null, amount_format: 'decimal', credit_indicator: 'CR', column_map: {} };

const show = (r) => `${r.account_code} ${r.bank_code} | no. ${r.account_no ?? '-'} | ${r.statement_format}`
  + ` delim ${r.delimiter == null ? 'comma' : JSON.stringify(r.delimiter)} ${r.amount_format} ind ${r.credit_indicator}`
  + `${r.is_active === false ? ' (off)' : ''} | ${JSON.stringify(r.column_map)}`;

const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
let inserted = 0;
try {
  /* 2990's setups, one per bank, as the templates. */
  const tpl = await sql`
    SELECT bank_code, statement_format, delimiter, amount_format, credit_indicator, column_map
      FROM scm.acc_bank_statement_config
     WHERE company_id = ${TEMPLATE_CO} AND is_active AND bank_code IN ('MBB', 'HLB')`;
  const templates = new Map();
  for (const t of tpl) {
    if (templates.has(t.bank_code)) stop(`Company ${TEMPLATE_CO} has more than one active ${t.bank_code} setup — which to copy is not obvious. Nothing was written.`);
    templates.set(t.bank_code, t);
  }
  for (const b of ['MBB', 'HLB']) if (!templates.has(b)) stop(`Company ${TEMPLATE_CO} has no active ${b} setup to copy. Nothing was written.`);

  const codes = WANT.map((w) => w.account_code);
  const accts = await sql`
    SELECT account_code, account_name, acc_money, is_active FROM scm.accounts
     WHERE company_id = ${CO} AND account_code IN ${sql(codes)}`;
  const byCode = new Map(accts.map((a) => [a.account_code, a]));
  const have = await sql`
    SELECT account_code, bank_code, account_no, statement_format, delimiter, amount_format, credit_indicator, column_map, is_active
      FROM scm.acc_bank_statement_config WHERE company_id = ${CO}`;
  const existing = new Map(have.map((h) => [h.account_code, h]));

  const rows = [];
  for (const w of WANT) {
    const a = byCode.get(w.account_code);
    /* The handler's own refusals: in this company's chart, a money account. */
    if (!a) stop(`${w.account_code} is not in company ${CO}'s chart of accounts. Nothing was written.`);
    if (a.acc_money !== true) stop(`${w.account_code} is not a bank or cash account. Nothing was written.`);
    if (a.is_active !== true) stop(`${w.account_code} is not active, so the setup form would not offer it. Nothing was written.`);
    if (existing.has(w.account_code)) {
      console.log(`KEEP|${w.account_code} ${a.account_name} already set up: ${show(existing.get(w.account_code))}`);
      continue;
    }
    const t = w.template ? templates.get(w.template) : BUILT_IN;
    const row = {
      company_id: CO, account_code: w.account_code, bank_code: w.bank_code.toUpperCase().slice(0, 12), account_no: null,
      statement_format: t.statement_format, delimiter: t.delimiter, amount_format: t.amount_format,
      credit_indicator: t.credit_indicator, column_map: t.column_map ?? {}, is_active: true,
    };
    rows.push(row);
    console.log(`ADD|${a.account_name} | ${show(row)}${w.template ? ` (copied from company ${TEMPLATE_CO}'s ${w.template})` : ' (built-in headings)'}`);
  }

  if (!APPLY) {
    console.log(rows.length === 0 ? 'Nothing to do.' : `\nPLAN only — ${rows.length} setup(s) would be added, nothing was written. Re-run with MODE=apply and the CONFIRM phrase.`);
  } else if (rows.length > 0) {
    await sql.begin(async (tx) => {
      for (const r of rows) {
        const got = await tx`
          INSERT INTO scm.acc_bank_statement_config
            (company_id, account_code, bank_code, account_no, statement_format, delimiter, amount_format, credit_indicator, column_map, is_active)
          VALUES (${r.company_id}, ${r.account_code}, ${r.bank_code}, ${r.account_no}, ${r.statement_format}, ${r.delimiter},
                  ${r.amount_format}, ${r.credit_indicator}, ${tx.json(r.column_map)}, ${r.is_active})
          ON CONFLICT (company_id, account_code) DO NOTHING
          RETURNING id`;
        if (got.length !== 1) throw new Error(`${r.account_code} was set up by someone else meanwhile — nothing was written.`);
        inserted += 1;
      }
    });
    console.log(`APPLIED|${inserted} setup(s) added for company ${CO}.`);
  } else {
    console.log('Nothing to do.');
  }
} finally {
  await sql.end();
}

if (APPLY) {
  /* Read back on a fresh connection: what Bank Recon will now offer. */
  const check = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    const back = await check`
      SELECT c.account_code, a.account_name, c.bank_code, c.account_no, c.statement_format, c.delimiter, c.amount_format,
             c.credit_indicator, c.column_map, c.is_active
        FROM scm.acc_bank_statement_config c
        LEFT JOIN scm.accounts a ON a.company_id = c.company_id AND a.account_code = c.account_code
       WHERE c.company_id = ${CO} ORDER BY c.account_code`;
    for (const r of back) console.log(`NOW|${r.account_name} | ${show(r)}`);
    const missing = WANT.filter((w) => !back.some((b) => b.account_code === w.account_code));
    console.log(missing.length === 0 ? `VERIFIED|all ${WANT.length} accounts take a statement.` : `MISSING|${missing.map((m) => m.account_code).join(', ')}`);
    if (missing.length > 0) process.exitCode = 1;
  } finally {
    await check.end();
  }
}
