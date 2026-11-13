#!/usr/bin/env node
// unmark-commission-orders.mjs — Finance's "Undo" on a list of Event Commission
// marks at once, through the page's own handler (POST /commission/marks/undo),
// so each order's History reads exactly as a click on the page would:
//   KIND=exclude (default)         the "Don't count" on the order is taken away —
//                                  it counts again;
//   KIND=exclude_change MONTH=…    the "Don't count change" of that month (YYYY-MM);
//   KIND=defer MONTH=…             the "Next month" of that month.
//
// Owner 2026-11-13: Anthony's HC-SO-2609-213 / -215 / -325 were marked Don't
// count with the September orders he had not paid in September; his October
// commission file pays them as "9 月的单（10 月补算）" — 「可以先拿掉 don't count
// 吗？」. September is closed, so what they earn shows in October as a closed
// month's adjustment.
//
// MODE=plan (default) lists the marks it would take away, then REHEARSES the
// undo inside a transaction that is always rolled back, so a refusal shows
// before the real run; nothing is written. MODE=apply with
// CONFIRM="UNMARK COMMISSION ORDERS" takes them away in ONE transaction — all or
// none — then re-reads on a fresh connection and exits 1 if one is still there.
// Prints doc numbers, kinds and counts only (the Actions log is public).
//
// RE-RUN: a mark already taken away is not there any more, so a second run
// writes nothing.
// Env: DATABASE_URL, DOCS (comma list), KIND, MONTH, ACTOR, COMPANY_ID (default 1).
import './lib/public-log-guard.mjs';
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { unmarkCommissionOrderHandler } from '../src/scm/routes/acc-event-commission.ts';

const PHRASE = 'UNMARK COMMISSION ORDERS';
const MODE = String(process.env.MODE || 'plan').trim().toLowerCase();
const APPLY = MODE === 'apply';
if (APPLY && (process.env.CONFIRM ?? '').trim() !== PHRASE) {
  console.error(`MODE=apply requires CONFIRM="${PHRASE}" — refusing, nothing was written.`);
  process.exit(2);
}
const CO = Number(process.env.COMPANY_ID || 1);
const DOCS = [...new Set(String(process.env.DOCS ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))];
const KIND = String(process.env.KIND || 'exclude').trim().toLowerCase();
const MONTH = String(process.env.MONTH ?? '').trim();
const WHOLE = KIND === 'exclude';
const ACTOR = String(process.env.ACTOR ?? '').trim() || 'Finance (by script)';
const WORDS = WHOLE ? "Don't count" : KIND === 'exclude_change' ? `Don't count change (${MONTH})` : `Next month (${MONTH})`;
const say = (s) => console.log(s);

/** This run's marks on the listed orders. */
const marksOf = async (db) => {
  const rows = await db`
    SELECT id::text AS id, so_doc_no, kind, to_char(month, 'YYYY-MM') AS ym, marked_by
      FROM scm.event_commission_marks WHERE company_id = ${CO} AND so_doc_no IN ${db(DOCS)} AND kind = ${KIND} ORDER BY so_doc_no`;
  return rows.filter((m) => (WHOLE ? m.ym == null : m.ym === MONTH));
};
const ctxOf = (db, id) => {
  const sb = pgrestShim(db, 'scm');
  return {
    req: { json: async () => ({ id }), path: '/api/scm/acc-events/commission/marks/undo' },
    get: (k) => (k === 'companyId' ? CO : k === 'supabase' ? sb : k === 'houzsUser' ? { name: ACTOR } : undefined),
    json: (body, status = 200) => ({ body, status }),
  };
};
/** Every mark taken away on `tx`; throws on the first refusal or if one is left. */
const takeAway = async (tx, marks) => {
  for (const m of marks) {
    const res = await unmarkCommissionOrderHandler(ctxOf(tx, m.id));
    if (res.status !== 200) throw new Error(`${m.so_doc_no}: the undo was refused (${res.status} ${res.body?.error ?? ''})`);
  }
  const left = await marksOf(tx);
  if (left.length > 0) throw new Error(`still marked after the undo: ${left.map((m) => m.so_doc_no).join(', ')}`);
};

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  if (DOCS.length === 0) { console.error('DOCS is required — nothing was written.'); process.exit(2); }
  if (!['exclude', 'exclude_change', 'defer'].includes(KIND)) { console.error('KIND is exclude, exclude_change or defer — nothing was written.'); process.exit(2); }
  if (!WHOLE && !/^\d{4}-(0[1-9]|1[0-2])$/.test(MONTH)) { console.error(`KIND=${KIND} needs MONTH=YYYY-MM — nothing was written.`); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    say(`unmark-commission-orders   company ${CO}   mode ${APPLY ? 'APPLY' : 'PLAN'}   ${WORDS}   ${DOCS.length} order(s)`);
    const marks = await marksOf(sql);
    const marked = new Set(marks.map((m) => m.so_doc_no));
    const none = DOCS.filter((d) => !marked.has(d));
    say(`   carrying the mark: ${marks.length}`);
    for (const m of marks) say(`      ${m.so_doc_no}   marked by ${m.marked_by ?? '-'}`);
    say(`   not carrying it (nothing to take away): ${none.length}${none.length ? ` (${none.join(', ')})` : ''}`);

    if (!APPLY) {
      const UNDO = Symbol('rehearsal');
      let rehearsal = marks.length === 0 ? 'nothing to take away' : 'not run';
      if (marks.length > 0) {
        try {
          await sql.begin(async (tx) => { await takeAway(tx, marks); rehearsal = `would go through — ${marks.length} mark(s) taken away`; throw UNDO; });
        } catch (e) {
          if (e !== UNDO) rehearsal = `FAILED (${String(e?.message ?? e).slice(0, 160)})`;
        }
      }
      say(`   rehearsal, rolled back: ${rehearsal}`);
      say(`   carrying the mark after the rehearsal: ${(await marksOf(sql)).length}`);
      say(`\nNothing written. To write: MODE=apply CONFIRM="${PHRASE}"`);
      return;
    }
    if (marks.length === 0) { say('\nNothing to take away — nothing written.'); return; }

    await sql.begin(async (tx) => { await takeAway(tx, marks); });
    say(`\n   taken away: ${marks.length} of ${marks.length}`);

    const check = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
    try {
      const left = await marksOf(check);
      say(`Verified on a fresh connection: ${marks.length - left.length} of ${marks.length} no longer marked ${WORDS}${left.length ? ` — STILL MARKED: ${left.map((m) => m.so_doc_no).join(', ')}` : ''}`);
      if (left.length > 0) process.exitCode = 1;
    } finally { await check.end(); }
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(String(e?.message ?? e).slice(0, 300)); process.exit(1); });
