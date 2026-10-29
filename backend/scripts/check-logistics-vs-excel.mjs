#!/usr/bin/env node
// check-logistics-vs-excel.mjs — READ ONLY. One month of the system set beside the
// owner's "Sept26 - Logistic & Operation Cost" workbook (owner 2026-10-29: 我想要
// 类似这样的 report), row by row:
//   - DOs and their value by region — the Logistics cost report's own handler
//     (src/scm/routes/acc-logistics.ts) over pgrest-shim + d1Compat;
//   - what the DO lines hold (goods vs service lines);
//   - the books for the month on the transport-shaped accounts (T / P / U / I / H /
//     B / W / R / E / S), and the outsource T-accounts summed by the region the
//     workbook's notes give them;
//   - the transport charges customers paid (SO service lines) for the DOs going out
//     in the month, by the DO's region;
//   - what the group's companies (2990, The Conts, Hookka) were billed, line by line.
// Env: DATABASE_URL, COMPANY_ID (1), FROM (2026-09-01), TO (2026-09-30).
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { d1Compat } from '../src/db/d1-compat.ts';
import { logisticsCostHandler } from '../src/scm/routes/acc-logistics.ts';
import { regionOfDo } from '../src/scm/lib/logistics-cost.ts';
import { countsInTheBooks } from '../src/acc/reversal-pairs.ts';

const CO = Number(process.env.COMPANY_ID || 1);
const FROM = String(process.env.FROM || '2026-09-01');
const TO = String(process.env.TO || '2026-09-30');
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, types: { dateText: asText(1082), tsText: asText(1114), tstzText: asText(1184) } });
const rm = (sen) => `RM ${(Number(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const out = (s) => console.log(`ROW|${s}`);
const add = (m, k, v) => m.set(k, (m.get(k) ?? 0) + v);

/* The workbook's own split of the outsource accounts (its notes + the chart, 2026-10-29). */
const T_REGION = (n) => {
  if (n === 5) return 'Penang';
  if (n === 6) return 'KL';
  if (n === 7 || (n >= 17 && n <= 26) || n === 36) return 'SBH & SWK';
  if (n === 15 || (n >= 27 && n <= 29) || n === 34) return 'SGD';
  if ((n >= 30 && n <= 33) || n === 35) return 'fair transport';
  return 'other T';
};

try {
  /* 1. The report's own handler. */
  const sb = pgrestShim(sql, 'scm');
  const c = {
    env: { DB: d1Compat(() => sql) },
    req: { query: (k) => ({ from: FROM, to: TO })[k], path: '/api/scm/acc-events/logistics' },
    get: (k) => (k === 'companyId' ? CO : k === 'supabase' ? sb : k === 'allowedCompanyIds' ? [CO] : k === 'houzsUser' ? { name: 'check' } : undefined),
    json: (body, status = 200) => ({ body, status }),
  };
  const res = await logisticsCostHandler(c);
  if (sb.__gaps.length > 0) throw new Error(`shim gaps: ${sb.__gaps.join(' | ')}`);
  if (res.status !== 200) throw new Error(`status ${res.status}: ${JSON.stringify(res.body)}`);
  const r = res.body;
  out(`== company ${CO} ${r.from}..${r.to}`);
  out(`totals: ${r.totals.dos} DOs, value ${rm(r.totals.valueSen)}, our lorries ${rm(r.totals.ownSen)}, 3PL ${rm(r.totals.threeplSen)}`);
  for (const g of r.regions) out(`region ${g.name}: ${g.dos} DOs, value ${rm(g.valueSen)}, 3PL ${rm(g.threeplSen)}`);
  for (const m of r.months) out(`month ${m.month}: own cost ${rm(m.ownCostSen)}, own trips ${m.trips} | ${m.accounts.map((a) => `${a.code} ${rm(a.sen)}`).join(', ')}`);
  out(`gaps: ${JSON.stringify(r.gaps)}`);
  out(`fairs: ${r.eventsProblem ?? `${r.events.length} with setup/transport S&D, setup ${rm(r.totals.setupSen)}, transport S&D ${rm(r.totals.transportSen)}`}`);
  for (const e of r.events) out(`  fair ${e.startDate} ${e.code ?? ''} ${String(e.name).slice(0, 60)}: setup ${rm(e.setupSen)}, transport S&D ${rm(e.transportSen)}`);

  /* 2. The DOs of the month and what their lines hold. */
  const dos = await sql`
    SELECT d.id, d.do_number, d.so_doc_no, d.state, d.city, d.postcode, coalesce(d.customer_delivery_date, d.do_date)::text AS day
      FROM scm.delivery_orders d
     WHERE d.company_id = ${CO} AND d.status <> 'CANCELLED'
       AND coalesce(d.customer_delivery_date, d.do_date) BETWEEN ${FROM}::date AND ${TO}::date`;
  const regionOf = new Map(dos.map((d) => [String(d.id), regionOfDo({ state: d.state, city: d.city, postcode: d.postcode }).code]));
  const itemCols = (await sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'scm' AND table_name = 'delivery_order_items' ORDER BY ordinal_position`).map((x) => x.column_name);
  out(`delivery_order_items columns: ${itemCols.join(', ')}`);
  const codeCol = ['item_code', 'product_code', 'sku'].find((x) => itemCols.includes(x));
  const groupCol = ['item_group', 'item_type', 'kind'].find((x) => itemCols.includes(x));
  if (codeCol || groupCol) {
    const ids = dos.map((d) => d.id);
    const lines = await sql.unsafe(
      `SELECT delivery_order_id, ${codeCol ?? 'NULL'} AS code, ${groupCol ?? 'NULL'} AS grp, line_total_sen FROM scm.delivery_order_items WHERE company_id = $1 AND delivery_order_id = ANY($2)`,
      [CO, ids],
    );
    const byKind = new Map();
    for (const l of lines) {
      const service = /service/i.test(String(l.grp ?? '')) || /transport|dispose|install|setup|dismantle/i.test(String(l.code ?? ''));
      add(byKind, `${regionOf.get(String(l.delivery_order_id))} ${service ? `service ${l.code}` : 'goods'}`, Number(l.line_total_sen ?? 0));
    }
    for (const [k, v] of [...byKind].sort()) if (v !== 0) out(`DO lines ${k}: ${rm(v)}`);
  }

  /* 3. Transport charges customers paid, for the SOs whose DOs go out this month (each SO once, at its first DO's region). */
  const soRegion = new Map();
  for (const d of [...dos].sort((a, b) => String(a.day).localeCompare(String(b.day)))) {
    if (d.so_doc_no && !soRegion.has(String(d.so_doc_no))) soRegion.set(String(d.so_doc_no), regionOf.get(String(d.id)));
  }
  const soLines = await sql`
    SELECT i.doc_no, i.item_code, i.item_group, i.total_sen
      FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders o ON o.doc_no = i.doc_no AND o.company_id = ${CO}
     WHERE i.doc_no = ANY(${[...soRegion.keys()]}) AND (i.item_group ILIKE 'service%' OR i.item_code ~* '(transport|deliver|setup|dismantle|install)')`;
  const transport = new Map();
  const transportN = new Map();
  for (const l of soLines) {
    const k = `${soRegion.get(String(l.doc_no))} ${l.item_code}`;
    add(transport, k, Number(l.total_sen ?? 0));
    add(transportN, k, 1);
  }
  for (const [k, v] of [...transport].sort()) if (v !== 0) out(`SO service by DO region ${k}: ${transportN.get(k)} lines ${rm(v)}`);

  /* 4. The books for the month on the transport-shaped accounts. */
  const legs = await sql`
    SELECT account_code, account_name, debit_sen, credit_sen, posted, reversed, reversed_by_je, opening
      FROM scm.v_gl_entries
     WHERE company_id = ${CO} AND entry_date BETWEEN ${FROM}::date AND ${TO}::date
       AND account_code ~ '-(T|P|U|I|H|B|W|R|E|S|L|M)[0-9]{3}$'`;
  const byAcc = new Map();
  const nameOf = new Map();
  let drafts = 0;
  for (const l of legs) {
    if (l.opening === true) continue;
    if (!countsInTheBooks(l)) { if (l.posted !== true) drafts += 1; continue; }
    add(byAcc, String(l.account_code), Number(l.debit_sen ?? 0) - Number(l.credit_sen ?? 0));
    nameOf.set(String(l.account_code), l.account_name);
  }
  out(`books: ${legs.length} legs on those accounts, ${drafts} not posted (left out)`);
  const tRegion = new Map();
  for (const [code, v] of [...byAcc].sort()) {
    if (v === 0) continue;
    out(`acc ${code} ${String(nameOf.get(code) ?? '').slice(0, 45)}: ${rm(v)}`);
    const m = /-T(\d{3})$/.exec(code);
    if (m) add(tRegion, T_REGION(Number(m[1])), v);
  }
  for (const [k, v] of tRegion) out(`outsource T by region ${k}: ${rm(v)}`);

  /* 5. What the group's companies were billed this month. */
  const odb = await sql`
    SELECT d.name AS debtor, b.bill_number, b.bill_date::text AS bill_date, l.description, l.credit_account_code, l.amount_sen
      FROM scm.acc_debtor_bills b JOIN scm.acc_debtors d ON d.id = b.debtor_id
      JOIN scm.acc_debtor_bill_lines l ON l.bill_id = b.id
     WHERE b.company_id = ${CO} AND b.status <> 'CANCELLED' AND b.bill_date BETWEEN ${FROM}::date AND ${TO}::date
       AND d.name ~* '(2990|conts|hookka)'
     ORDER BY d.name, b.bill_number, l.line_no`;
  for (const l of odb) out(`ODB ${l.debtor} ${l.bill_number} ${l.bill_date} [${l.credit_account_code}] ${String(l.description ?? '').slice(0, 70)}: ${rm(l.amount_sen)}`);
} catch (e) {
  out(`FAILED: ${e?.message ?? e}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
