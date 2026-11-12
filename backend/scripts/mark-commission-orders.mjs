#!/usr/bin/env node
// mark-commission-orders.mjs — Finance's "Don't count" on a list of orders at
// once, through the Event Commission page's own handler (POST /commission/marks),
// so each order's History reads exactly as a click on the page would.
//
// Owner 2026-11-13, from his September sheet ("SO-9月-每个销售员-Summary"):
//   · the September orders on a fair he did not pay (old orders keyed again,
//     补旧单) — 48;
//   · the orders he paid in September that the system, going by when 30% was
//     keyed, would pay again in October — 12.
// Each run takes one list and one reason.
//
// MODE=plan (default) reads each order and its marks and says what it would do;
// nothing is written. MODE=apply with CONFIRM="MARK COMMISSION ORDERS" marks
// every listed order not yet marked Don't count, then re-reads the marks on a
// fresh connection and exits 1 if one is missing. Prints doc numbers and counts
// only (the Actions log is public).
//
// RE-RUN: an order already marked Don't count is left alone, so a second run
// writes nothing.
// Env: DATABASE_URL, DOCS (comma list), REASON, COMPANY_ID (default 1).
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
const ACTOR = 'Finance (owner 2026-11-13, his September sheet)';
const say = (s) => console.log(s);

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  if (DOCS.length === 0 || !REASON) { console.error('DOCS and REASON are required — nothing was written.'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    say(`mark-commission-orders   company ${CO}   mode ${APPLY ? 'APPLY' : 'PLAN'}   ${DOCS.length} order(s)`);
    const orders = await sql`SELECT doc_no FROM scm.mfg_sales_orders WHERE company_id = ${CO} AND doc_no IN ${sql(DOCS)}`;
    const found = new Set(orders.map((o) => o.doc_no));
    const marks = await sql`SELECT so_doc_no, kind FROM scm.event_commission_marks WHERE company_id = ${CO} AND so_doc_no IN ${sql(DOCS)}`;
    const excluded = new Set(marks.filter((m) => m.kind === 'exclude').map((m) => m.so_doc_no));
    const missing = DOCS.filter((d) => !found.has(d));
    const todo = DOCS.filter((d) => found.has(d) && !excluded.has(d));
    say(`   not an order of this company: ${missing.length}${missing.length ? ` (${missing.join(', ')})` : ''}`);
    say(`   already Don't count: ${excluded.size}${excluded.size ? ` (${[...excluded].join(', ')})` : ''}`);
    say(`   other marks kept as they are: ${marks.filter((m) => m.kind !== 'exclude').map((m) => `${m.so_doc_no} ${m.kind}`).join(', ') || 'none'}`);
    say(`   to mark Don't count: ${todo.length}`);
    for (const d of todo) say(`      ${d}`);
    if (!APPLY) { say(`\nNothing written. To write: MODE=apply CONFIRM="${PHRASE}"`); return; }

    const sb = pgrestShim(sql, 'scm');
    let done = 0;
    for (const docNo of todo) {
      const c = {
        req: { json: async () => ({ docNo, kind: 'exclude', reason: REASON }) },
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
      const now = await check`SELECT so_doc_no FROM scm.event_commission_marks WHERE company_id = ${CO} AND kind = 'exclude' AND so_doc_no IN ${check(DOCS)}`;
      const have = new Set(now.map((m) => m.so_doc_no));
      const absent = DOCS.filter((d) => found.has(d) && !have.has(d));
      say(`Verified on a fresh connection: ${DOCS.length - missing.length - absent.length} of ${DOCS.length - missing.length} marked Don't count${absent.length ? ` — MISSING: ${absent.join(', ')}` : ''}`);
      if (absent.length > 0) process.exitCode = 1;
    } finally { await check.end(); }
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(String(e?.message ?? e).slice(0, 300)); process.exit(1); });
