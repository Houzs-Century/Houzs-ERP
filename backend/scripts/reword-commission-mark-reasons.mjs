#!/usr/bin/env node
// reword-commission-mark-reasons.mjs — the reason written with Finance's Event
// Commission marks, put into other words: every mark carrying exactly FROM gets
// TO, and so does the note of the History line that mark wrote on its order (the
// two are the same text, written together by POST /commission/marks).
//
// Owner 2026-11-13 (「这个要英文哦」, on the Reason column of "Marked — not paid
// here"): the reasons on the marks put for him by mark-commission-orders.mjs
// that day were written in Chinese. What the system stores and shows is English.
// Only the words change: which order is marked, how, by whom and when stay.
//
// MODE=plan (default) counts the marks and History lines carrying FROM and lists
// the orders; nothing is written. MODE=apply with
// CONFIRM="REWORD COMMISSION MARKS" rewrites them in one transaction — refusing,
// and writing nothing, if the count moved since it was read — then re-reads on a
// fresh connection: no mark and no History line may still carry FROM, and as
// many as were rewritten must carry TO; else it exits 1.
// Prints doc numbers and counts only (the Actions log is public).
//
// RE-RUN: once rewritten nothing carries FROM, so a second run writes nothing.
// Env: DATABASE_URL, FROM, TO, COMPANY_ID (default 1).
import './lib/public-log-guard.mjs';
import postgres from 'postgres';

const PHRASE = 'REWORD COMMISSION MARKS';
const MODE = String(process.env.MODE || 'plan').trim().toLowerCase();
const APPLY = MODE === 'apply';
if (APPLY && (process.env.CONFIRM ?? '').trim() !== PHRASE) {
  console.error(`MODE=apply requires CONFIRM="${PHRASE}" — refusing, nothing was written.`);
  process.exit(2);
}
const CO = Number(process.env.COMPANY_ID || 1);
const FROM = String(process.env.FROM ?? '').trim();
const TO = String(process.env.TO ?? '').trim();
const say = (s) => console.log(s);

/** The marks and the History lines carrying `text`. */
async function carrying(sql, text) {
  const marks = await sql`
    SELECT id, so_doc_no, kind, to_char(month, 'YYYY-MM') AS ym
      FROM scm.event_commission_marks WHERE company_id = ${CO} AND reason = ${text} ORDER BY kind, month, so_doc_no`;
  const history = await sql`
    SELECT id, so_doc_no FROM scm.mfg_so_audit_log
     WHERE company_id = ${CO} AND action = 'COMMISSION_MARK' AND source = 'event-commission' AND note = ${text} ORDER BY so_doc_no`;
  return { marks, history };
}

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  if (!FROM || !TO) { console.error('FROM and TO are required — nothing was written.'); process.exit(2); }
  if (FROM === TO) { console.error('FROM and TO are the same — nothing to do.'); process.exit(2); }
  if (TO.length > 500) { console.error('TO is longer than a reason may be (500) — nothing was written.'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    say(`reword-commission-mark-reasons   company ${CO}   mode ${APPLY ? 'APPLY' : 'PLAN'}`);
    const before = await carrying(sql, FROM);
    const already = await carrying(sql, TO);
    const groups = new Map();
    for (const m of before.marks) { const k = `${m.kind}${m.ym ? ` ${m.ym}` : ''}`; groups.set(k, [...(groups.get(k) ?? []), m.so_doc_no]); }
    say(`   marks carrying the old reason: ${before.marks.length}`);
    for (const [k, docs] of groups) say(`      ${k}: ${docs.length} — ${docs.join(', ')}`);
    say(`   History lines carrying it: ${before.history.length}`);
    say(`   already carrying the new reason: ${already.marks.length} mark(s), ${already.history.length} History line(s)`);
    if (!APPLY) { say(`\nNothing written. To write: MODE=apply CONFIRM="${PHRASE}"`); return; }
    if (before.marks.length === 0 && before.history.length === 0) { say('\nNothing carries the old reason — nothing written.'); return; }

    const done = await sql.begin(async (tx) => {
      const marks = await tx`UPDATE scm.event_commission_marks SET reason = ${TO} WHERE company_id = ${CO} AND reason = ${FROM} RETURNING id`;
      const history = await tx`
        UPDATE scm.mfg_so_audit_log SET note = ${TO}
         WHERE company_id = ${CO} AND action = 'COMMISSION_MARK' AND source = 'event-commission' AND note = ${FROM} RETURNING id`;
      if (marks.length !== before.marks.length || history.length !== before.history.length) {
        throw new Error(`the count moved since it was read (marks ${before.marks.length} -> ${marks.length}, History ${before.history.length} -> ${history.length}) — nothing written`);
      }
      return { marks: marks.length, history: history.length };
    });
    say(`\n   rewritten: ${done.marks} mark(s), ${done.history} History line(s)`);

    const check = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
    try {
      const left = await carrying(check, FROM);
      const now = await carrying(check, TO);
      const ok = left.marks.length === 0 && left.history.length === 0
        && now.marks.length === already.marks.length + done.marks && now.history.length === already.history.length + done.history;
      say(`Verified on a fresh connection: old reason left on ${left.marks.length} mark(s) and ${left.history.length} History line(s); new reason on ${now.marks.length} mark(s) and ${now.history.length} History line(s)${ok ? '' : ' — NOT AS EXPECTED'}`);
      if (!ok) process.exitCode = 1;
    } finally { await check.end(); }
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(String(e?.message ?? e).slice(0, 300)); process.exit(1); });
