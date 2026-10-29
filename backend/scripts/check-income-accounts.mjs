#!/usr/bin/env node
// check-income-accounts.mjs — READ ONLY. The income side of the chart, to place
// four transport income accounts beside the regional transport cost accounts
// (owner 2026-10-29: Transport Income – Penang / KL / SBH & SWK / SGD 「对」).
// Prints every 5xx account (code, name, type, parent, active) and the T-accounts
// the four mirror. Env: DATABASE_URL, COMPANY_ID (1).
import postgres from 'postgres';

const CO = Number(process.env.COMPANY_ID || 1);
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const out = (s) => console.log(`ROW|${s}`);
try {
  const cols = (await sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'scm' AND table_name = 'accounts'`).map((x) => x.column_name);
  out(`accounts columns: ${cols.join(', ')}`);
  const extra = ['parent_code', 'parent_account_code', 'level', 'is_group', 'pms_row', 'special_type'].filter((x) => cols.includes(x));
  for (const a of await sql.unsafe(
    `SELECT account_code, account_name, account_type, is_active${extra.length ? ', ' + extra.join(', ') : ''}
       FROM scm.accounts WHERE company_id = $1 AND (account_code LIKE '5%' OR account_code ~ '-T0(0[5-7]|2[7-9]|3[0-5])$')
      ORDER BY account_code`,
    [CO],
  )) out(`${a.account_code} | ${a.account_name} | ${a.account_type}${a.is_active === false ? ' (inactive)' : ''}${extra.map((k) => ` | ${k}=${a[k] ?? ''}`).join('')}`);
} catch (e) {
  out(`FAILED: ${e?.message ?? e}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
