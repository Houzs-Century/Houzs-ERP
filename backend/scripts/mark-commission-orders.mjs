#!/usr/bin/env node
// mark-commission-orders.mjs — one of Finance's Event Commission buttons on a
// list of orders at once, through the page's own handler (POST
// /commission/marks), so each order's History reads exactly as a click on the
// page would:
//   KIND=exclude (default)         "Don't count" — the order earns in no month;
//   KIND=exclude_change MONTH=…    "Don't count change" — the order's upsales /
//                                  drop sales of that month (YYYY-MM, an open
//                                  month) are left out, the order still counts.
//
// Owner 2026-11-13, from his September sheet ("SO-9月-每个销售员-Summary"):
//   · the September orders on a fair he did not pay (old orders keyed again,
//     补旧单) — 48;
//   · the orders he paid in September that the system, going by when 30% was
//     keyed, would pay again in October — 12.
// Then, the same day: the old orders' drop sales that were only a record put
// right (a bill split in two, a fee line taken off, a mattress swapped with the
// new line not priced) — Don't count change for their month.
// Each run takes one list, one kind and one reason.
//
// MODE=plan (default) reads each order and its marks and says what it would do;
// nothing is written. MODE=apply with CONFIRM="MARK COMMISSION ORDERS" marks
// every listed order not carrying the mark yet, then re-reads the marks on a
// fresh connection and exits 1 if one is missing. Prints doc numbers and counts
// only (the Actions log is public).
//
// RE-RUN: an order already carrying the mark is left alone, so a second run
// writes nothing. Don't count change skips an order that is Don't count as a
// whole — it earns nothing either way.
// Env: DATABASE_URL, DOCS (comma list), REASON, KIND, MONTH, ACTOR, COMPANY_ID (default 1).
import './lib/public-log-guard.mjs';
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { markCommissionOrderHandler } from '../src/scm/routes/acc-event-commission.ts';

const PHRASE = 'MARK COMMISSION ORDERS';
const MODE = String(process.env.MODE || 'plan').trim().toLowerCase();
const APPLY = MODE === 'apply';
if (APPLY && (process.env.CONFIRM ?? '').trim() !== PHRASE) {
  console.error(`MODE=apply requires CONFIRM="${PHRASE}" — refusing, nothing was written.`);
  process.exit(2);
}
const CO = Number(process.env.COMPANY_ID || 1);
const DOCS = [...new Set(String(process.env.DOCS ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))];
const REASON = String(process.env.REASON ?? '').trim();
const KIND = String(process.env.KIND || 'exclude').trim().toLowerCase();
const MONTH = String(process.env.MONTH ?? '').trim();
const CHANGE = KIND === 'exclude_change';
const ACTOR = String(process.env.ACTOR ?? '').trim() || 'Finance (owner 2026-11-13, his September sheet)';
const WORDS = CHANGE ? `Don't count change (${MONTH})` : "Don't count";
const say = (s) => console.log(s);

/** The orders of DOCS carrying this run's mark, and those Don't count as a whole. */
async function marksOf(sql) {
  const rows = await sql`
    SELECT so_doc_no, kind, to_char(month, 'YYYY-MM') AS ym
      FROM scm.event_commission_marks WHERE company_id = ${CO} AND so_doc_no IN ${sql(DOCS)}`;
  const whole = new Set(rows.filter((m) => m.kind === 'exclude').map((m) => m.so_doc_no));
  const has = CHANGE ? new Set(rows.filter((m) => m.kind === 'exclude_change' && m.ym === MONTH).map((m) => m.so_doc_no)) : whole;
  return { rows, whole, has };
}

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  if (DOCS.length === 0 || !REASON) { console.error('DOCS and REASON are required — nothing was written.'); process.exit(2); }
  if (KIND !== 'exclude' && !CHANGE) { console.error('KIND is exclude or exclude_change — nothing was written.'); process.exit(2); }
  if (CHANGE && !/^\d{4}-(0[1-9]|1[0-2])$/.test(MONTH)) { console.error('KIND=exclude_change needs MONTH=YYYY-MM — nothing was written.'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    say(`mark-commission-orders   company ${CO}   mode ${APPLY ? 'APPLY' : 'PLAN'}   ${WORDS}   ${DOCS.length} order(s)`);
    const orders = await sql`SELECT doc_no FROM scm.mfg_sales_orders WHERE company_id = ${CO} AND doc_no IN ${sql(DOCS)}`;
    const found = new Set(orders.map((o) => o.doc_no));
    const { rows, whole, has } = await marksOf(sql);
    const skipWhole = (d) => CHANGE && whole.has(d);
    const missing = DOCS.filter((d) => !found.has(d));
    const todo = DOCS.filter((d) => found.has(d) && !has.has(d) && !skipWhole(d));
    say(`   not an order of this company: ${missing.length}${missing.length ? ` (${missing.join(', ')})` : ''}`);
    say(`   already ${WORDS}: ${has.size}${has.size ? ` (${[...has].join(', ')})` : ''}`);
    if (CHANGE) say(`   Don't count as a whole order, left alone: ${DOCS.filter(skipWhole).join(', ') || 'none'}`);
    say(`   other marks kept as they are: ${rows.filter((m) => !has.has(m.so_doc_no) || (CHANGE ? m.kind !== 'exclude_change' || m.ym !== MONTH : m.kind !== 'exclude')).map((m) => `${m.so_doc_no} ${m.kind}${m.ym ? ` ${m.ym}` : ''}`).join(', ') || 'none'}`);
    say(`   to mark ${WORDS}: ${todo.length}`);
    for (const d of todo) say(`      ${d}`);
    if (!APPLY) { say(`\nNothing written. To write: MODE=apply CONFIRM="${PHRASE}"`); return; }

    const sb = pgrestShim(sql, 'scm');
    let done = 0;
    for (const docNo of todo) {
      const c = {
        req: { json: async () => (CHANGE ? { docNo, kind: 'exclude_change', month: MONTH, reason: REASON } : { docNo, kind: 'exclude', reason: REASON }) },
        get: (k) => (k === 'companyId' ? CO : k === 'supabase' ? sb : k === 'houzsUser' ? { name: ACTOR } : undefined),
        json: (body, status = 200) => ({ body, status }),
      };
      const res = await markCommissionOrderHandler(c);
      if (res.status === 200) { done += 1; continue; }
      say(`   ${docNo}: NOT marked (${res.status} ${res.body?.error ?? ''})`);
    }
    say(`\n   marked ${done} of ${todo.length}`);

    const check = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
    try {
      const now = await marksOf(check);
      const due = DOCS.filter((d) => found.has(d) && !(CHANGE && now.whole.has(d)));
      const absent = due.filter((d) => !now.has.has(d));
      say(`Verified on a fresh connection: ${due.length - absent.length} of ${due.length} marked ${WORDS}${absent.length ? ` — MISSING: ${absent.join(', ')}` : ''}`);
      if (absent.length > 0) process.exitCode = 1;
    } finally { await check.end(); }
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(String(e?.message ?? e).slice(0, 300)); process.exit(1); });
