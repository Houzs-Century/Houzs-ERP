#!/usr/bin/env node
// check-logistics-owner-rules.mjs — READ ONLY. The data behind the owner's rules for
// his Logistic Cost Report (2026-10-29, 先确定):
//   - Upkeep 「先从我这个月的upkeep 拉出来，我觉得要平除多少个月」: every upkeep
//     (U accounts) and insurance & road tax (I002) line FROM..TO, posted or still a draft;
//   - Manpower 「进salary 时有分driver和helper」: how the salary postings name them —
//     accounts and line notes on the payroll-shaped accounts, and any account named
//     DRIVER / HELPER;
//   - Set/Dismantle Income (in-house, RM 400 KL / RM 600 other area, each way): the
//     fairs starting or ending FROM..TO, their place, and any outsourced setup /
//     dismantle on them (3PL bill lines; T030–T035 lines carrying the fair).
// Env: DATABASE_URL, COMPANY_ID (1), FROM (2026-09-01), TO (2026-10-31).
import postgres from 'postgres';

const CO = Number(process.env.COMPANY_ID || 1);
const FROM = String(process.env.FROM || '2026-09-01');
const TO = String(process.env.TO || '2026-10-31');
const FAIR_FROM = String(process.env.FAIR_FROM || '2026-08-01');
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, types: { dateText: asText(1082), tsText: asText(1114), tstzText: asText(1184) } });
const rm = (sen) => `RM ${(Number(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const out = (s) => console.log(`ROW|${s}`);
const cut = (s, n = 70) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const colsOf = async (schema, table) => (await sql`SELECT column_name FROM information_schema.columns WHERE table_schema = ${schema} AND table_name = ${table}`).map((x) => x.column_name);

try {
  const glCols = await colsOf('scm', 'v_gl_entries');
  const docCol = ['je_no', 'source_doc_no'].find((x) => glCols.includes(x)) ?? 'line_id';
  const srcCol = ['source_type'].find((x) => glCols.includes(x));

  /* 1. Upkeep and insurance & road tax, posted. */
  for (const r of await sql.unsafe(
    `SELECT entry_date::text AS day, account_code, account_name, ${docCol}::text AS doc, ${srcCol ?? "''"} AS src, notes,
            (debit_sen - credit_sen)::bigint AS sen
       FROM scm.v_gl_entries
      WHERE company_id = $1 AND entry_date BETWEEN $2::date AND $3::date AND posted = true
        AND reversed IS NOT TRUE AND reversed_by_je IS NULL AND opening IS NOT TRUE
        AND account_code ~ '-(U0[0-9]{2}|I002)$'
      ORDER BY entry_date, account_code`,
    [CO, FROM, TO],
  )) out(`UPKEEP-GL ${r.day} ${r.account_code} ${cut(r.account_name, 34)} ${r.src} ${r.doc}: ${cut(r.notes, 60)} ${rm(r.sen)}`);
  /* … and still drafts (bills and vouchers not posted yet). */
  for (const r of await sql`
    SELECT 'AP' AS src, inv.invoice_number AS doc, inv.invoice_date::text AS day, inv.status::text AS status, l.debit_account_code AS acc, l.description, l.amount_sen AS sen
      FROM scm.ap_invoice_lines l JOIN scm.ap_invoices inv ON inv.id = l.invoice_id
     WHERE inv.company_id = ${CO} AND inv.invoice_date BETWEEN ${FROM}::date AND ${TO}::date AND inv.status::text NOT IN ('POSTED', 'PAID', 'PARTIALLY_PAID', 'CANCELLED')
       AND l.debit_account_code ~ '-(U0[0-9]{2}|I002)$'
    UNION ALL
    SELECT 'PV', pv.pv_number, pv.voucher_date::text, pv.status::text, l.debit_account_code, l.description, l.amount_sen
      FROM scm.payment_voucher_lines l JOIN scm.payment_vouchers pv ON pv.id = l.pv_id
     WHERE pv.company_id = ${CO} AND pv.voucher_date BETWEEN ${FROM}::date AND ${TO}::date AND pv.status::text NOT IN ('POSTED', 'APPROVED', 'CANCELLED', 'VOID')
       AND l.debit_account_code ~ '-(U0[0-9]{2}|I002)$'
     ORDER BY 3`) out(`UPKEEP-DRAFT ${r.day} ${r.acc} ${r.src} ${r.doc} ${r.status}: ${cut(r.description, 60)} ${rm(r.sen)}`);

  /* 2. Salaries: the accounts and how the lines name drivers and helpers. */
  for (const a of await sql`
    SELECT account_code, account_name, account_type FROM scm.accounts
     WHERE company_id = ${CO} AND account_name ~* '(driver|helper|lorry crew|logistic|manpower|salar|wages|allowance|epf|socso|eis|pcb)'
     ORDER BY account_code`) out(`SAL-ACC ${a.account_code} ${cut(a.account_name, 50)} (${a.account_type})`);
  const salLines = await sql.unsafe(
    `SELECT to_char(entry_date, 'YYYY-MM') AS ym, account_code, notes, party_name, (debit_sen - credit_sen)::bigint AS sen, ${srcCol ?? "''"} AS src, ${docCol}::text AS doc
       FROM scm.v_gl_entries
      WHERE company_id = $1 AND entry_date BETWEEN $2::date AND $3::date AND posted = true
        AND reversed IS NOT TRUE AND reversed_by_je IS NULL AND opening IS NOT TRUE
        AND account_code IN (SELECT account_code FROM scm.accounts WHERE company_id = $1
                              AND account_name ~* '(driver|helper|salar|wages|allowance|epf|socso|eis|overtime)')
      ORDER BY 1, 2`,
    [CO, FROM, TO],
  );
  out(`salary legs: ${salLines.length}`);
  const words = new Map();
  for (const l of salLines) {
    const tag = /driver/i.test(`${l.notes} ${l.party_name}`) ? 'DRIVER' : /helper/i.test(`${l.notes} ${l.party_name}`) ? 'HELPER' : 'other';
    const k = `${l.ym} ${l.account_code} ${tag}`;
    const w = words.get(k) ?? { n: 0, sen: 0, eg: new Set() };
    w.n += 1; w.sen += Number(l.sen); if (w.eg.size < 4) w.eg.add(`${l.src} ${l.doc} "${cut(l.notes, 40)}"`);
    words.set(k, w);
  }
  for (const [k, w] of words) out(`SAL ${k}: ${w.n} legs ${rm(w.sen)} — ${[...w.eg].join(' · ')}`);
  for (const l of salLines.filter((x) => /driver|helper/i.test(`${x.notes} ${x.party_name}`)).slice(0, 25)) {
    out(`SAL-LINE ${l.ym} ${l.account_code} ${l.src} ${l.doc}: ${cut(l.notes, 70)} ${cut(l.party_name, 30)} ${rm(l.sen)}`);
  }
  /* Draft salary vouchers / journals (not posted yet) naming drivers or helpers. */
  for (const r of await sql`
    SELECT pv.pv_number AS doc, pv.voucher_date::text AS day, pv.status::text AS status, l.debit_account_code AS acc, l.description, l.amount_sen AS sen
      FROM scm.payment_voucher_lines l JOIN scm.payment_vouchers pv ON pv.id = l.pv_id
     WHERE pv.company_id = ${CO} AND pv.voucher_date BETWEEN ${FROM}::date AND ${TO}::date
       AND l.description ~* '(driver|helper)'
     ORDER BY 2 LIMIT 25`) out(`SAL-PV ${r.day} ${r.doc} ${r.status} [${r.acc}] ${cut(r.description, 70)} ${rm(r.sen)}`);

  /* 3. Fairs starting or ending in the range: place and outsourced setup / dismantle. */
  const pCols = await colsOf('public', 'projects');
  const placeCols = pCols.filter((x) => /state|venue|city|region|location/i.test(x));
  out(`projects place columns: ${placeCols.join(', ')}`);
  const fairs = await sql.unsafe(
    `SELECT id, code, name, ${placeCols.length ? placeCols.join(', ') + ',' : ''} start_date::text AS start_date, end_date::text AS end_date, status
       FROM public.projects
      WHERE company_id = $1 AND archived_at IS NULL AND lower(coalesce(status, '')) <> 'cancelled'
        AND ((start_date >= $2 AND start_date <= $3) OR (end_date >= $2 AND end_date <= $3))
      ORDER BY start_date, id`,
    [CO, FAIR_FROM, TO],
  );
  const ids = fairs.map((f) => Number(f.id));
  const bl = ids.length === 0 ? [] : await sql`
    SELECT project_id, kind, assign, amount_sen, text FROM scm.threepl_bill_lines
     WHERE company_id = ${CO} AND project_id = ANY(${ids}) AND assign = 'event'`;
  const legs = ids.length === 0 ? [] : await sql`
    SELECT l.project_id, l.debit_account_code AS acc, l.amount_sen AS sen, l.description FROM scm.ap_invoice_lines l
      JOIN scm.ap_invoices inv ON inv.id = l.invoice_id
     WHERE inv.company_id = ${CO} AND inv.status::text <> 'CANCELLED' AND l.project_id = ANY(${ids}) AND l.debit_account_code ~ '-T03[0-5]$'
    UNION ALL
    SELECT l.project_id, l.debit_account_code, l.amount_sen, l.description FROM scm.payment_voucher_lines l
      JOIN scm.payment_vouchers pv ON pv.id = l.pv_id
     WHERE pv.company_id = ${CO} AND pv.status::text NOT IN ('CANCELLED', 'VOID') AND l.project_id = ANY(${ids}) AND l.debit_account_code ~ '-T03[0-5]$'`;
  out(`fairs: ${fairs.length}`);
  /* Trips: a setup on the start day and a dismantle on the end day; booths at one
     venue on one day share the trip. Counted by month and state. */
  const trips = new Map();
  const add = (month, state, key, booth, outsourced) => {
    const k = `${month} ${state}`;
    const t = trips.get(k) ?? { keys: new Set(), booths: 0, outsourced: new Set() };
    t.keys.add(key); t.booths += 1; if (outsourced) t.outsourced.add(key);
    trips.set(k, t);
  };
  for (const f of fairs) {
    const state = String(f.state ?? '').trim().toUpperCase() || '(no state)';
    const venue = String(f.venue ?? '').trim().toUpperCase();
    const out3pl = bl.some((b) => Number(b.project_id) === Number(f.id)) || legs.some((b) => Number(b.project_id) === Number(f.id));
    if (f.start_date) add(String(f.start_date).slice(0, 7), state, `setup|${venue}|${f.start_date}`, f.id, out3pl);
    if (f.end_date) add(String(f.end_date).slice(0, 7), state, `dismantle|${venue}|${f.end_date}`, f.id, out3pl);
  }
  for (const [k, t] of [...trips].sort()) out(`TRIPS ${k}: ${t.keys.size} trips (${t.booths} booth-ends), ${t.outsourced.size} with an outsourced bill on the fair`);

  /* Salary by the department the salary journal names. */
  const dept = new Map();
  for (const l of salLines) {
    const m = /^(.*?)\s*(SALARY|EPF|SOCSO|EIS|SKBB|ALLOWANCE|OVERTIME)\b/i.exec(String(l.notes ?? '').toUpperCase());
    if (!m || !m[1]) continue;
    const k = `${l.ym} ${m[1].replace(/[-–—\s]+$/, '').trim()}`;
    dept.set(k, (dept.get(k) ?? 0) + Number(l.sen));
  }
  for (const [k, v] of [...dept].sort()) out(`DEPT ${k}: ${rm(v)}`);
  for (const f of fairs) {
    const mine = bl.filter((b) => Number(b.project_id) === Number(f.id));
    const t = legs.filter((b) => Number(b.project_id) === Number(f.id));
    const place = placeCols.map((k) => f[k]).filter(Boolean).join(' / ');
    out(`FAIR ${f.start_date}→${f.end_date} #${f.id} ${cut(f.code, 60)} | ${cut(place, 50)} | 3PL ${mine.map((b) => `${b.kind} ${rm(b.amount_sen)}`).join(', ') || '-'} | T03x ${t.map((b) => `${b.acc} ${rm(b.sen)} "${cut(b.description, 30)}"`).join(', ') || '-'}`);
  }
} catch (e) {
  out(`FAILED: ${e?.message ?? e}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
