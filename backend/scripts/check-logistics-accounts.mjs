#!/usr/bin/env node
// check-logistics-accounts.mjs — READ ONLY. The chart rows the logistics P&L reads
// by name (owner 2026-10-29 做): transport T-accounts, petrol / upkeep, insurance &
// road tax, HP creditors, salary accounts, 700-0000 and 590-0000 (section, parent),
// and the lorries list. Env: DATABASE_URL, COMPANY_ID (1).
import postgres from 'postgres';

const CO = Number(process.env.COMPANY_ID || 1);
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const out = (s) => console.log(`ROW|${s}`);
try {
  for (const a of await sql`
    SELECT account_code, account_name, account_type, parent_code, section, is_active, pms_row
      FROM scm.accounts
     WHERE company_id = ${CO}
       AND (account_code ~ '-(T0[0-9]{2}|P0[0-9]{2}|U0[0-9]{2}|I00[0-9]|H0[0-9]{2}|S[0-9]{3}|D[0-9]{3})$'
            OR account_code IN ('700-0000', '590-0000'))
     ORDER BY account_code`) {
    out(`${a.account_code} | ${a.account_name} | ${a.account_type} | parent ${a.parent_code ?? '-'} | ${a.section ?? '-'}${a.is_active === false ? ' | inactive' : ''}${a.pms_row ? ` | pms ${a.pms_row}` : ''}`);
  }
  for (const l of await sql`SELECT plate, is_internal FROM scm.lorries WHERE company_id = ${CO} ORDER BY is_internal DESC, plate`) out(`lorry ${l.plate} ${l.is_internal ? 'OURS' : 'outside'}`);
} catch (e) {
  out(`FAILED: ${e?.message ?? e}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
