#!/usr/bin/env node
// check-logistics-rows.mjs — READ ONLY. For every company: which Logistics P&L row
// each account feeds under today's name rules (scm/lib/logistics-pnl.ts
// pnlAccountsOf, the own-lorry list = Finance's ticks else defaultOwnCostAccounts,
// transportIncomeRegionOf for the income accounts) — the lists the Chart of
// Accounts "Logistics" column is back-filled from (owner 2026-10-29: 在 coa 那边
// 选 —「可以」). Also: codes that would get different rows in different companies,
// and headers among them. Nothing is written. Env: DATABASE_URL.
import postgres from 'postgres';
import { defaultOwnCostAccounts } from '../src/scm/lib/logistics-cost.ts';
import { ownCostKindOf, pnlAccountsOf, transportIncomeRegionOf } from '../src/scm/lib/logistics-pnl.ts';

const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const out = (s) => console.log(`ROW|${s}`);

try {
  const companies = await sql`SELECT DISTINCT company_id FROM scm.accounts ORDER BY 1`;
  const rowOf = new Map(); // code -> Map(company -> row)
  const put = (code, co, row) => {
    const m = rowOf.get(code) ?? new Map();
    m.set(co, row);
    rowOf.set(code, m);
  };
  const nameOf = new Map();
  for (const { company_id: co } of companies) {
    const chart = await sql`
      SELECT account_code, account_name, account_type, is_active, parent_code, pms_row
        FROM scm.accounts WHERE company_id = ${co} ORDER BY account_code`;
    const parents = new Set(chart.map((a) => a.parent_code).filter(Boolean));
    for (const a of chart) if (!nameOf.has(a.account_code)) nameOf.set(a.account_code, `${a.account_name} [${a.account_type}${a.is_active === false ? ', inactive' : ''}${parents.has(a.account_code) ? ', HEADER' : ''}]`);
    const lorries = (await sql`SELECT id, plate, is_internal FROM scm.lorries WHERE company_id = ${co}`)
      .map((l) => ({ id: String(l.id), plate: String(l.plate ?? ''), isInternal: l.is_internal === true }));
    const [set] = await sql`SELECT own_cost_accounts FROM scm.acc_logistics_settings WHERE company_id = ${co}`;
    const picked = set?.own_cost_accounts?.length ? set.own_cost_accounts.map(String) : null;
    const def = defaultOwnCostAccounts(chart, lorries);
    const own = picked ?? def;
    const a = pnlAccountsOf(chart, lorries, own);
    out(`== company ${co}: ${chart.length} accounts; our lorries ${lorries.filter((l) => l.isInternal).map((l) => l.plate).join(', ') || 'none'}; own-lorry list ${picked ? `TICKED (${picked.length})` : `default (${def.length})`}`);
    if (picked) out(`  ticked: ${picked.join(', ')} | default would be: ${def.join(', ')}`);
    for (const [code, region] of a.outsource) put(code, co, `outsource_${region.toLowerCase()}`);
    for (const code of own) put(code, co, ownCostKindOf(chart.find((x) => x.account_code === code)?.account_name) === 'petrol' ? 'petrol' : ownCostKindOf(chart.find((x) => x.account_code === code)?.account_name) === 'upkeep' ? 'upkeep' : 'other_lorry');
    for (const code of a.roadTax) put(code, co, 'roadtax');
    for (const code of a.instalment) put(code, co, 'instalment');
    for (const x of chart) {
      const r = transportIncomeRegionOf(x.account_name);
      if (r) put(x.account_code, co, `income_${r.toLowerCase()}`);
    }
    out(`  salary accounts (manpower lines read from, by name): ${[...a.salary].join(', ') || 'none'}`);
  }
  const byRow = new Map();
  const conflicts = [];
  for (const [code, m] of [...rowOf.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    const rows = [...new Set(m.values())];
    if (rows.length > 1) conflicts.push(`${code} ${[...m.entries()].map(([co, r]) => `co${co}=${r}`).join(' ')}`);
    const key = rows.join('|');
    const list = byRow.get(key) ?? [];
    list.push(`${code} ${nameOf.get(code)} {${[...m.keys()].join(',')}}`);
    byRow.set(key, list);
  }
  for (const [row, list] of [...byRow.entries()].sort()) {
    out(`-- ${row} (${list.length})`);
    for (const l of list) out(`   ${l}`);
  }
  out(`conflicts between companies: ${conflicts.length ? conflicts.join(' ; ') : 'none'}`);
  const counts = await sql`SELECT company_id, count(*)::int AS n FROM scm.accounts GROUP BY 1 ORDER BY 1`;
  out(`accounts per company: ${counts.map((c) => `co${c.company_id}=${c.n}`).join(' ')}`);
} catch (e) {
  out(`FAILED: ${e?.message ?? e}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
