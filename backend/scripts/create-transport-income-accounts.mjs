#!/usr/bin/env node
// create-transport-income-accounts.mjs — the four transport income accounts the
// Logistics P&L reads Other Debtor bill lines by (owner 2026-10-29: 开 4 个收入
// 账户 Transport Income – Penang / KL / SBH & SWK / SGD，开 bill 时选账户 —「对」),
// opened through the app's own chart door (src/scm/routes/accounting-chart.ts
// chartCreateHandler), for COMPANY_ID only. They sit BESIDE 590-0000 TRANSPORT
// INCOME under 700-0000 Other Income, not under it: a header takes no money, and
// 590-0000 keeps its own use (a sales invoice's transport income 「另有用途」).
//
// PLAN by default: everything inside one transaction, read back, ROLLED BACK.
// APPLY=1 with CONFIRM="CREATE TRANSPORT INCOME ACCOUNTS" keeps it.
// Env: DATABASE_URL, COMPANY_ID (1).
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { chartCreateHandler } from '../src/scm/routes/accounting-chart.ts';

const PHRASE = 'CREATE TRANSPORT INCOME ACCOUNTS';
const CO = Number(process.env.COMPANY_ID || 1);
const APPLY = process.env.APPLY === '1';
if (APPLY && process.env.CONFIRM !== PHRASE) {
  console.error(`Refused: APPLY needs CONFIRM="${PHRASE}".`);
  process.exit(2);
}
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
    const sb = pgrestShim(tx, 'scm');
    for (const [code, name] of ACCOUNTS) {
      const c = {
        req: { json: async () => ({ code, name, section: 'OTHER INCOMES', parentCode: '700-0000', companyIds: [CO] }) },
        get: (k) => (k === 'supabase' ? sb : k === 'allowedCompanyIds' ? [CO] : k === 'companyId' ? CO
          : k === 'houzsUser' ? { id: 0, name: 'script: create-transport-income-accounts', permissions_set: ['scm.payment_voucher.post'] } : undefined),
        json: (body, status = 200) => ({ body, status }),
      };
      const res = await chartCreateHandler(c);
      if (sb.__gaps.length > 0) throw new Error(`shim gaps: ${sb.__gaps.join(' | ')}`);
      out(`${code} ${name}: ${res.status} ${JSON.stringify(res.body)}`);
      if (res.status !== 200) throw new Error(`${code} refused`);
    }
    for (const r of await tx`
      SELECT account_code, account_name, account_type, parent_code, section, is_active
        FROM scm.accounts WHERE company_id = ${CO} AND account_code LIKE '590-%' ORDER BY account_code`) {
      out(`now: ${r.account_code} | ${r.account_name} | ${r.account_type} | parent ${r.parent_code} | ${r.section} | ${r.is_active ? 'active' : 'inactive'}`);
    }
    if (!APPLY) throw new Rollback();
  });
  out(APPLY ? 'APPLIED — the four accounts are open.' : 'never reached');
} catch (e) {
  if (e instanceof Rollback) out('PLAN — ROLLED BACK, nothing was kept. Run with mode=apply and the CONFIRM phrase to keep it.');
  else { out(`FAILED: ${e?.message ?? e}`); process.exitCode = 1; }
} finally {
  await sql.end();
}
