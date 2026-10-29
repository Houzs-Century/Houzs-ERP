#!/usr/bin/env node
// create-transport-income-accounts.mjs — the four transport income accounts the
// Logistics P&L reads Other Debtor bill lines by (owner 2026-10-29: 开 4 个收入
// 账户 Transport Income – Penang / KL / SBH & SWK / SGD，开 bill 时选账户 —「对」),
// for COMPANY_ID only. They sit BESIDE 590-0000 TRANSPORT INCOME under 700-0000
// Other Income, not under it: a header takes no money, and 590-0000 keeps its own
// use (a sales invoice's transport income 「另有用途」).
//
// The row is the one the chart's own door writes (scm/routes/accounting-chart.ts
// chartCreateHandler: type, parent, section, acc_money false, no special type,
// active) — written here in SQL because the pgrest shim has no composite-key
// upsert. Its refusals are kept: a code that exists in ANY company is refused,
// and the parent must already be in this company's chart in the same section.
//
// PLAN by default: everything inside one transaction, read back, ROLLED BACK.
// APPLY=1 with CONFIRM="CREATE TRANSPORT INCOME ACCOUNTS" keeps it.
// Env: DATABASE_URL, COMPANY_ID (1).
import postgres from 'postgres';

const PHRASE = 'CREATE TRANSPORT INCOME ACCOUNTS';
const CO = Number(process.env.COMPANY_ID || 1);
const APPLY = process.env.APPLY === '1';
if (APPLY && process.env.CONFIRM !== PHRASE) {
  console.error(`Refused: APPLY needs CONFIRM="${PHRASE}".`);
  process.exit(2);
}
const PARENT = '700-0000';
const SECTION = 'OTHER INCOMES';
const ACCOUNTS = [
  ['590-0001', 'TRANSPORT INCOME (PNG, PERLIS, KEDAH, KELANTAN, TERENGGANU, PAHANG)'],
  ['590-0002', 'TRANSPORT INCOME (KL, SLG, MLK, JHR, OTHERS)'],
  ['590-0003', 'TRANSPORT INCOME (SABAH & SARAWAK)'],
  ['590-0004', 'TRANSPORT INCOME (SGD)'],
];
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const out = (s) => console.log(`ROW|${s}`);
class Rollback extends Error {}

try {
  await sql.begin(async (tx) => {
    const [parent] = await tx`SELECT account_code, section FROM scm.accounts WHERE company_id = ${CO} AND account_code = ${PARENT}`;
    if (!parent) throw new Error(`${PARENT} is not in company ${CO}'s chart`);
    if (parent.section !== SECTION) throw new Error(`${PARENT} sits under ${parent.section}, not ${SECTION}`);
    const taken = await tx`SELECT DISTINCT account_code FROM scm.accounts WHERE account_code = ANY(${ACCOUNTS.map(([code]) => code)})`;
    if (taken.length > 0) throw new Error(`already exists: ${taken.map((t) => t.account_code).join(', ')} — nothing written`);
    for (const [code, name] of ACCOUNTS) {
      await tx`
        INSERT INTO scm.accounts (company_id, account_code, account_name, account_type, parent_code, acc_money, special_type, section, is_active)
        VALUES (${CO}, ${code}, ${name}, 'INCOME', ${PARENT}, false, NULL, ${SECTION}, true)`;
      out(`opened ${code} ${name}`);
    }
    for (const r of await tx`
      SELECT account_code, account_name, account_type, parent_code, section, is_active
        FROM scm.accounts WHERE company_id = ${CO} AND account_code LIKE '590-%' ORDER BY account_code`) {
      out(`now: ${r.account_code} | ${r.account_name} | ${r.account_type} | parent ${r.parent_code} | ${r.section} | ${r.is_active ? 'active' : 'inactive'}`);
    }
    if (!APPLY) throw new Rollback();
  });
  out('APPLIED — the four accounts are open.');
} catch (e) {
  if (e instanceof Rollback) out('PLAN — ROLLED BACK, nothing was kept. Run with mode=apply and the CONFIRM phrase to keep it.');
  else { out(`FAILED: ${e?.message ?? e}`); process.exitCode = 1; }
} finally {
  await sql.end();
}
