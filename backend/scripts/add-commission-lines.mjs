#!/usr/bin/env node
// add-commission-lines.mjs — Finance's own lines on the Event Commission, typed
// for a list of orders at once through the page's own handler
// (POST /commission/lines), so each order's History reads exactly as the form
// on the page would write it.
//
// Owner 2026-11-13 (「做」): HR pays two upsales in October that were made before
// the orders came into the ERP (HC-SO-011254 and HC-SO-004110 were raised in
// AutoCount), so the page holds no dated change to count. Finance types the
// amounts itself, for October.
//
// LINES is "ORDER:AMOUNT,ORDER:AMOUNT" — the amount in RM of goods, less than 0
// to take commission back; MONTH (YYYY-MM) is the open month they are paid in;
// REASON is written on each line and in each order's History.
//
// THE AMOUNTS DO NOT TRAVEL IN THE CLEAR: the workflow prints a run's variables
// in a log anyone can read. In GitHub Actions the lines are given SEALED
// (lib/sealed-input.mjs): run once with SEAL_KEY=1 — it prints the sealing key
// and stops — seal the LINES text to that key on your own machine, and pass the
// hex as LINES_SEALED. A plain LINES is taken on a machine of your own only.
//
// MODE=plan (default) lists what it would add, then REHEARSES it inside a
// transaction that is always rolled back, so a refusal shows before the real
// run; nothing is written. MODE=apply with CONFIRM="ADD COMMISSION LINES" adds
// them in ONE transaction — all or none — then re-reads on a fresh connection
// and exits 1 if one is missing.
// Prints doc numbers and counts only (the Actions log is public).
//
// RE-RUN: a line of the same order, month and amount that is already there is
// not added again, so a second run writes nothing.
// Env: DATABASE_URL, LINES_SEALED (or LINES off GitHub Actions), MONTH, REASON,
// ACTOR, COMPANY_ID (default 1); SEAL_KEY=1 to print the sealing key.
import './lib/public-log-guard.mjs';
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { sealingKeyOf, unseal } from './lib/sealed-input.mjs';
import { addCommissionLineHandler } from '../src/scm/routes/acc-event-commission.ts';

const PHRASE = 'ADD COMMISSION LINES';
const MODE = String(process.env.MODE || 'plan').trim().toLowerCase();
const APPLY = MODE === 'apply';
if (APPLY && (process.env.CONFIRM ?? '').trim() !== PHRASE) {
  console.error(`MODE=apply requires CONFIRM="${PHRASE}" — refusing, nothing was written.`);
  process.exit(2);
}
const CO = Number(process.env.COMPANY_ID || 1);
const MONTH = String(process.env.MONTH ?? '').trim();
const REASON = String(process.env.REASON ?? '').trim();
const ACTOR = String(process.env.ACTOR ?? '').trim() || 'Finance (by script)';
const SEAL_LABEL = 'add-commission-lines';
const PUBLIC_LOG = process.env.GITHUB_ACTIONS === 'true';
/** The LINES text: sealed where the log is public, plain on a machine of one's own. */
function linesText() {
  const sealed = String(process.env.LINES_SEALED ?? '').trim();
  if (sealed) return unseal(process.env.DATABASE_URL, SEAL_LABEL, sealed);
  const plain = String(process.env.LINES ?? '').trim();
  if (plain && PUBLIC_LOG) throw new Error('LINES carries amounts and this log is public — seal it and pass LINES_SEALED (SEAL_KEY=1 prints the key).');
  return plain;
}
/** "HC-SO-2610-001:800,HC-SO-2610-002:-250.50" → [{ docNo, goodsSen }] ; null for a piece that does not read. */
const linesOfText = (text) => String(text ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((piece) => {
  const at = piece.lastIndexOf(':');
  const docNo = at > 0 ? piece.slice(0, at).trim().toUpperCase() : '';
  const rm = at > 0 ? Number(piece.slice(at + 1).trim()) : NaN;
  const goodsSen = Math.round(rm * 100);
  return docNo && Number.isFinite(rm) && goodsSen !== 0 ? { docNo, goodsSen } : null;
});
const say = (s) => console.log(s);

/** The lines already there for this month on the listed orders. */
const linesOf = async (db, docs) => db`
  SELECT id::text AS id, so_doc_no, goods_sen::text AS goods_sen, added_by
    FROM scm.event_commission_lines
   WHERE company_id = ${CO} AND month = ${`${MONTH}-01`}::date AND so_doc_no IN ${db(docs)} ORDER BY so_doc_no, added_at`;
const ctxOf = (db, line) => {
  const sb = pgrestShim(db, 'scm');
  return {
    req: { json: async () => ({ docNo: line.docNo, month: MONTH, goodsSen: line.goodsSen, reason: REASON }), path: '/api/scm/acc-events/commission/lines' },
    get: (k) => (k === 'companyId' ? CO : k === 'supabase' ? sb : k === 'houzsUser' ? { name: ACTOR } : undefined),
    json: (body, status = 200) => ({ body, status }),
  };
};
const has = (rows, line) => rows.some((r) => r.so_doc_no === line.docNo && Number(r.goods_sen) === line.goodsSen);
/** Every new line added on `tx`; throws on the first refusal or if one is missing after. */
const addAll = async (tx, todo, docs) => {
  for (const line of todo) {
    const res = await addCommissionLineHandler(ctxOf(tx, line));
    if (res.status !== 200) throw new Error(`${line.docNo}: the line was refused (${res.status} ${res.body?.error ?? ''})`);
  }
  const after = await linesOf(tx, docs);
  const missing = todo.filter((line) => !has(after, line));
  if (missing.length > 0) throw new Error(`not there after the add: ${missing.map((l) => l.docNo).join(', ')}`);
};

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  if (process.env.SEAL_KEY === '1') {
    /* A public key: it seals, it opens nothing. */
    say(`Sealing key for LINES_SEALED: ${sealingKeyOf(process.env.DATABASE_URL, SEAL_LABEL)}`);
    say('Nothing read, nothing written.');
    return;
  }
  let LINES;
  try { LINES = linesOfText(linesText()); } catch (e) { console.error(`${String(e?.message ?? e).slice(0, 200)} — nothing was written.`); process.exit(2); }
  if (LINES.length === 0 || LINES.some((l) => l == null)) { console.error('The lines are "ORDER:AMOUNT,ORDER:AMOUNT" with amounts that are not 0 — nothing was written.'); process.exit(2); }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(MONTH)) { console.error('MONTH=YYYY-MM is required — nothing was written.'); process.exit(2); }
  if (!REASON) { console.error('REASON is required — nothing was written.'); process.exit(2); }
  const docs = [...new Set(LINES.map((l) => l.docNo))];
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    say(`add-commission-lines   company ${CO}   mode ${APPLY ? 'APPLY' : 'PLAN'}   month ${MONTH}   ${LINES.length} line(s) on ${docs.length} order(s)`);
    const known = await sql`SELECT doc_no FROM scm.mfg_sales_orders WHERE company_id = ${CO} AND doc_no IN ${sql(docs)}`;
    const knownDocs = new Set(known.map((r) => r.doc_no));
    const strangers = docs.filter((d) => !knownDocs.has(d));
    say(`   not an order of this company: ${strangers.length}${strangers.length ? ` (${strangers.join(', ')})` : ''}`);
    if (strangers.length > 0) { console.error('Take those out of LINES — nothing was written.'); process.exit(2); }
    const there = await linesOf(sql, docs);
    const todo = LINES.filter((line) => !has(there, line));
    say(`   already there (same order, month and amount): ${LINES.length - todo.length}`);
    say(`   to add: ${todo.length}`);
    for (const line of todo) say(`      ${line.docNo}   ${line.goodsSen > 0 ? 'adds commission' : 'takes commission back'}`);

    if (!APPLY) {
      const UNDO = Symbol('rehearsal');
      let rehearsal = todo.length === 0 ? 'nothing to add' : 'not run';
      if (todo.length > 0) {
        try {
          await sql.begin(async (tx) => { await addAll(tx, todo, docs); rehearsal = `would go through — ${todo.length} line(s) added`; throw UNDO; });
        } catch (e) {
          if (e !== UNDO) rehearsal = `FAILED (${String(e?.message ?? e).slice(0, 160)})`;
        }
      }
      say(`   rehearsal, rolled back: ${rehearsal}`);
      say(`   lines there after the rehearsal: ${(await linesOf(sql, docs)).length}`);
      say(`\nNothing written. To write: MODE=apply CONFIRM="${PHRASE}"`);
      return;
    }
    if (todo.length === 0) { say('\nNothing to add — nothing written.'); return; }

    await sql.begin(async (tx) => { await addAll(tx, todo, docs); });
    say(`\n   added: ${todo.length} of ${todo.length}`);

    const check = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
    try {
      const after = await linesOf(check, docs);
      const missing = LINES.filter((line) => !has(after, line));
      say(`Verified on a fresh connection: ${LINES.length - missing.length} of ${LINES.length} line(s) there for ${MONTH}${missing.length ? ` — MISSING: ${missing.map((l) => l.docNo).join(', ')}` : ''}`);
      if (missing.length > 0) process.exitCode = 1;
    } finally { await check.end(); }
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(String(e?.message ?? e).slice(0, 300)); process.exit(1); });
