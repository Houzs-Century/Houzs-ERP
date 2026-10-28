#!/usr/bin/env node
// import-houzs-ocn-2609-025.mjs — Houzs (company 1): AutoCount's CN-2609-025,
// the RM 2,000.00 discount to EASTERN DECORATOR SDN. BHD. on the exhibition-
// rental bill (HOMES LIVING 9-12 JUL KLCC), as an other-debtor credit note.
//
// WHY. The one paper of the September import that waited for the note to
// exist (owner 2026-10-28: Customer & Other Debtor CN / DN —「可以」; then
// import CN-2609-025). AutoCount booked it 02/09/2026: Dr 520-0000 DISCOUNT
// ALLOWED 2,000.00 / Cr 305-E003 EASTERN DECORATOR SDN. BHD. 2,000.00 — the
// ERP keeps ONE other-debtor control (305-0000, the debtor as party), where
// the debtor's bills already sit. It knocks off HC-ODB-2608-005 (owes
// 69,200.00 → 67,200.00).
//
// HOW. The app's own code, driven over DATABASE_URL through lib/pgrest-shim.mjs,
// so no row and no entry is hand-made — what Save + Post to ledger on the
// Customer & Other Debtor CN / DN page run:
//   - acc/credit-notes.ts insertCreditNote — the draft, numbered HC-OCN-2609-NNN;
//   - acc/credit-note-allocations.ts writePlan — the tick on the bill;
//   - acc/credit-notes.ts postCreditNote — Dr 520-0000 / Cr 305-0000 (ODEBTOR);
//   - acc/credit-note-allocations.ts carryOutPlan — the bill's received_sen
//     through scm.settle_odb_received_sen.
// The line takes the bill's event when the bill's money lines carry exactly one.
// MODE=plan (the default) runs all of it in ONE transaction and rolls it back,
// printing what it wrote; MODE=apply with CONFIRM="IMPORT HOUZS CN-2609-025"
// keeps it. Verified inside the transaction (any shim gap, refusal or wrong
// shape throws and nothing is written) and again on a FRESH connection after
// the commit: the journal as AutoCount booked it and balanced, the bill and
// the debtor's balance down by exactly RM 2,000.00, the books still balanced.
//
// RE-RUN: refused — a live note with reference CN-2609-025 is already there.
//
// REHEARSAL before the migration is live: MODE=plan with WITH_MIGRATION=1 runs
// 20261029T0900 inside the same rolled-back transaction first, so the whole
// import is tried on today's data with the code that will ship. Never on apply.
//
// Dates: postgres.js hands a `date` column back as a JS Date; the app code reads
// PostgREST's 'YYYY-MM-DD' text (postCreditNote dates the journal with
// String(note.note_date)), so this connection parses `date` as that text.
//
// Env: DATABASE_URL, COMPANY_ID (1), WITH_MIGRATION (0).
//   COMPANY_ID=1 npx tsx scripts/import-houzs-ocn-2609-025.mjs                                              # plan
//   COMPANY_ID=1 MODE=apply CONFIRM="IMPORT HOUZS CN-2609-025" npx tsx scripts/import-houzs-ocn-2609-025.mjs

import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { insertCreditNote, postCreditNote } from '../src/acc/credit-notes.ts';
import { carryOutPlan, writePlan } from '../src/acc/credit-note-allocations.ts';
import { resolveRoles } from '../src/acc/rules.ts';
import { docPrefixForCode } from '../src/scm/lib/companyScope.ts';

const MODE = String(process.env.MODE || 'plan').trim().toLowerCase();
const APPLY = MODE === 'apply' || process.env.APPLY === '1';
const PHRASE = 'IMPORT HOUZS CN-2609-025';
const COMPANY_ID = Number(process.env.COMPANY_ID || 1);
const WITH_MIGRATION = String(process.env.WITH_MIGRATION || '0') === '1';
const MIGRATION = new URL('../src/db/migrations-pg/20261029T0900_acc_other_debtor_credit_notes.sql', import.meta.url);
const WHO = 'AutoCount September import (owner 2026-10-28)';
/* `date` as PostgREST's text, not a JS Date (see the header). */
const DB_OPTIONS = { max: 1, prepare: false, types: { dateText: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } } };

/* AutoCount's CN-2609-025, as its GL holds it. */
const AC = {
  doc: 'CN-2609-025',
  date: '2026-09-02',
  debtorLike: 'EASTERN DECORATOR%',
  bill: 'HC-ODB-2608-005',
  account: '520-0000',
  amountSen: 200_000,
  description: 'DISCOUNT FOR EXHIBITION RENTAL FOR HOMES LIVING 9-12 JUL KLCC',
};

const stop = (msg, code = 1) => { console.error(msg); process.exit(code); };
if (COMPANY_ID !== 1) stop('This is Houzs\'s paper — COMPANY_ID must be 1.', 2);
if (APPLY && (process.env.CONFIRM ?? '').trim() !== PHRASE) stop(`CONFIRM must be exactly "${PHRASE}" to apply. Nothing was written.`, 2);
if (APPLY && WITH_MIGRATION) stop('WITH_MIGRATION is for a plan rehearsal only — the deploy applies the migration.', 2);
if (!process.env.DATABASE_URL) stop('DATABASE_URL is not set.', 2);

const rm = (sen) => `RM ${(Number(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const out = (s) => console.log(`ROW|${s}`);
class Rollback extends Error {}

/** What the import starts from — read the same way inside the transaction and before it. */
async function readStart(db) {
  const debtors = await db`
    SELECT id, name, is_active FROM scm.acc_debtors
    WHERE company_id = ${COMPANY_ID} AND name ILIKE ${AC.debtorLike}`;
  if (debtors.length !== 1) throw new Error(`expected ONE debtor like ${AC.debtorLike}, found ${debtors.length}: ${debtors.map((d) => d.name).join(', ')}`);
  const debtor = debtors[0];
  if (debtor.is_active === false) throw new Error(`${debtor.name} is deactivated.`);
  const [bill] = await db`
    SELECT id, bill_number, debtor_id, bill_date, total_sen, received_sen, status FROM scm.acc_debtor_bills
    WHERE company_id = ${COMPANY_ID} AND bill_number = ${AC.bill}`;
  if (!bill) throw new Error(`${AC.bill} is not a bill of company ${COMPANY_ID}.`);
  if (String(bill.debtor_id) !== String(debtor.id)) throw new Error(`${AC.bill} is not ${debtor.name}'s.`);
  if (bill.status !== 'POSTED') throw new Error(`${AC.bill} is ${bill.status}, not POSTED (owing).`);
  const owed = Number(bill.total_sen) - Number(bill.received_sen);
  if (owed < AC.amountSen) throw new Error(`${AC.bill} owes ${rm(owed)} — less than the note's ${rm(AC.amountSen)}.`);
  const events = await db`
    SELECT DISTINCT project_id FROM scm.acc_debtor_bill_lines
    WHERE company_id = ${COMPANY_ID} AND bill_id = ${bill.id} AND amount_sen > 0 AND project_id IS NOT NULL`;
  const [account] = await db`
    SELECT account_code, account_name, special_type FROM scm.accounts
    WHERE company_id = ${COMPANY_ID} AND account_code = ${AC.account}`;
  if (!account) throw new Error(`${AC.account} is not in company ${COMPANY_ID}'s chart.`);
  const kids = await db`SELECT 1 FROM scm.accounts WHERE company_id = ${COMPANY_ID} AND parent_code = ${AC.account} LIMIT 1`;
  if (kids.length > 0) throw new Error(`${AC.account} is a header with sub-accounts.`);
  if (account.special_type) throw new Error(`${AC.account} is a control account (${account.special_type}).`);
  const live = await db`
    SELECT note_number, status FROM scm.acc_credit_notes
    WHERE company_id = ${COMPANY_ID} AND source_doc_no = ${AC.doc} AND status <> 'CANCELLED'`;
  if (live.length > 0) throw new Error(`already imported: ${live.map((n) => `${n.note_number} (${n.status})`).join(', ')} — refusing a second run.`);
  return { debtor, bill, owed, projectId: events.length === 1 ? Number(events[0].project_id) : null, eventCount: events.length, account };
}

/* The shim answers an rpc as `SELECT f(...) AS result` — right for a scalar
   (scm.next_doc_no_n, the numbers), but a RETURNS TABLE function comes back as
   one record string, so the bill's settle would read 0 applied. That one goes
   through `SELECT * FROM`, answering with its rows as PostgREST does. */
function withTableRpc(tx, base) {
  return {
    ...base,
    async rpc(name, args = {}) {
      if (name !== 'settle_odb_received_sen') return base.rpc(name, args);
      try {
        const rows = await tx`SELECT * FROM scm.settle_odb_received_sen(p_id := ${args.p_id}::uuid, p_delta := ${args.p_delta}::bigint)`;
        return { data: rows.map((r) => ({ ...r })), error: null };
      } catch (e) {
        return { data: null, error: { message: e instanceof Error ? e.message : String(e) } };
      }
    },
  };
}

/** The debtor's balance on the other-debtor control, and the company's whole books. */
async function readBalances(db, control, debtorName) {
  const [d] = await db`
    SELECT COALESCE(SUM(debit_sen - credit_sen), 0)::bigint AS bal FROM scm.v_gl_entries
    WHERE company_id = ${COMPANY_ID} AND account_code = ${control} AND party_type = 'ODEBTOR' AND party_name = ${debtorName}`;
  const [b] = await db`
    SELECT COALESCE(SUM(debit_sen), 0)::bigint AS dr, COALESCE(SUM(credit_sen), 0)::bigint AS cr FROM scm.v_gl_entries
    WHERE company_id = ${COMPANY_ID}`;
  return { debtorSen: Number(d.bal), dr: Number(b.dr), cr: Number(b.cr) };
}

/** Everything the imported note must look like — as values, not counts. */
async function shapeProblems(db, done) {
  const p = [];
  const [n] = await db`
    SELECT id, note_number, kind, party_type, party_name, debtor_id, source_doc_no, note_date, total_sen, status, je_no
    FROM scm.acc_credit_notes WHERE company_id = ${COMPANY_ID} AND id = ${done.noteId}`;
  if (!n) return [`the note ${done.noteId} is missing`];
  const day = n.note_date instanceof Date ? n.note_date.toISOString().slice(0, 10) : String(n.note_date).slice(0, 10);
  if (n.kind !== 'OCN' || n.party_type !== 'ODEBTOR' || String(n.debtor_id) !== String(done.debtor.id) || n.party_name !== done.debtor.name
    || n.source_doc_no !== AC.doc || day !== AC.date || Number(n.total_sen) !== AC.amountSen || n.status !== 'POSTED' || n.je_no !== done.jeNo
    || !/^HC-OCN-2609-\d{3}$/.test(n.note_number)) {
    p.push(`the note reads ${JSON.stringify({ ...n, note_date: day })}`);
  }
  const legs = await db`
    SELECT account_code, debit_sen, credit_sen, party_type, party_name, entry_date, source_type FROM scm.v_gl_entries
    WHERE company_id = ${COMPANY_ID} AND je_no = ${done.jeNo} ORDER BY line_no`;
  const dr = legs.find((g) => g.account_code === AC.account && Number(g.debit_sen) === AC.amountSen && Number(g.credit_sen) === 0);
  const cr = legs.find((g) => g.account_code === done.control && Number(g.credit_sen) === AC.amountSen && Number(g.debit_sen) === 0
    && g.party_type === 'ODEBTOR' && g.party_name === done.debtor.name);
  const legDay = legs[0]?.entry_date instanceof Date ? legs[0].entry_date.toISOString().slice(0, 10) : String(legs[0]?.entry_date ?? '').slice(0, 10);
  if (legs.length !== 2 || !dr || !cr || legDay !== AC.date || legs.some((g) => g.source_type !== 'OCN')) {
    p.push(`${done.jeNo}: legs read ${JSON.stringify(legs)}`);
  }
  const [bill] = await db`SELECT received_sen, status FROM scm.acc_debtor_bills WHERE company_id = ${COMPANY_ID} AND id = ${done.bill.id}`;
  const expectReceived = Number(done.bill.received_sen) + AC.amountSen;
  const expectStatus = Number(done.bill.total_sen) === expectReceived ? 'PAID' : 'POSTED';
  if (!bill || Number(bill.received_sen) !== expectReceived || bill.status !== expectStatus) {
    p.push(`${AC.bill}: reads ${JSON.stringify(bill)}, expected received ${expectReceived} / ${expectStatus}`);
  }
  const allocs = await db`
    SELECT debtor_bill_id, amount_sen, applied_sen FROM scm.acc_credit_note_allocations
    WHERE company_id = ${COMPANY_ID} AND note_id = ${done.noteId}`;
  if (allocs.length !== 1 || String(allocs[0].debtor_bill_id) !== String(done.bill.id)
    || Number(allocs[0].amount_sen) !== AC.amountSen || Number(allocs[0].applied_sen) !== AC.amountSen) {
    p.push(`the knock-off reads ${JSON.stringify(allocs)}`);
  }
  const after = await readBalances(db, done.control, done.debtor.name);
  if (after.debtorSen !== done.before.debtorSen - AC.amountSen) {
    p.push(`${done.debtor.name} on ${done.control}: ${rm(done.before.debtorSen)} → ${rm(after.debtorSen)}, expected down by ${rm(AC.amountSen)}`);
  }
  /* Balanced only — other postings may land in the company while this runs. */
  if (after.dr !== after.cr) p.push(`the books: Dr ${rm(after.dr)} / Cr ${rm(after.cr)} do not balance`);
  return p;
}

const sql = postgres(process.env.DATABASE_URL, DB_OPTIONS);
out(`mode ${APPLY ? 'APPLY' : 'plan (rolled back)'}${WITH_MIGRATION ? ' — REHEARSAL with migration 20261029T0900' : ''}, company ${COMPANY_ID}, ${AC.doc}`);
let done;
try {
  done = await sql.begin(async (tx) => {
    if (WITH_MIGRATION) {
      await tx.unsafe(readFileSync(MIGRATION, 'utf8'));
      out('rehearsal: migration 20261029T0900 run inside this transaction (rolled back with it)');
    }
    const sb = withTableRpc(tx, pgrestShim(tx, 'scm'));
    const start = await readStart(tx);
    const roles = await resolveRoles(sb, COMPANY_ID);
    const control = roles.AR_OTHER;
    const before = await readBalances(tx, control, start.debtor.name);
    out(`debtor ${start.debtor.name} (${start.debtor.id}) — on ${control} ${rm(before.debtorSen)}`);
    out(`bill ${AC.bill} ${String(start.bill.bill_date instanceof Date ? start.bill.bill_date.toISOString().slice(0, 10) : start.bill.bill_date).slice(0, 10)}: total ${rm(start.bill.total_sen)}, received ${rm(start.bill.received_sen)}, owes ${rm(start.owed)}`);
    out(`account ${start.account.account_code} ${start.account.account_name}; event ${start.projectId ?? (start.eventCount > 1 ? `none (the bill carries ${start.eventCount})` : 'none')}`);

    const raised = await insertCreditNote(sb, {
      companyId: COMPANY_ID,
      docPrefix: docPrefixForCode('HOUZS'),
      kind: 'OCN',
      party: { code: null, name: start.debtor.name },
      debtorId: String(start.debtor.id),
      sourceDocNo: AC.doc,
      noteDate: AC.date,
      reason: `AutoCount ${AC.doc} — ${AC.description}`,
      notes: `Imported from AutoCount ${AC.doc} (books from 01/09/2026).`,
      lines: [{ description: AC.description, code: AC.account, amountSen: AC.amountSen, projectId: start.projectId }],
      createdBy: WHO,
    });
    if (!raised.ok) throw new Error(`insertCreditNote refused: ${raised.reason}`);
    const noteId = String(raised.note.id);
    const planned = await writePlan(sb, { companyId: COMPANY_ID, noteId, targets: [{ kind: 'ODB', id: String(start.bill.id), amountSen: AC.amountSen }], actor: WHO });
    if (!planned.ok) throw new Error(`writePlan refused: ${planned.reason}`);
    const posted = await postCreditNote(sb, { companyId: COMPANY_ID, note: raised.note, actor: WHO });
    if (!posted.ok || posted.status !== 'posted') throw new Error(`postCreditNote: ${JSON.stringify(posted)}`);
    const carried = await carryOutPlan(sb, { companyId: COMPANY_ID, note: { ...raised.note, status: 'POSTED' } });
    if (!carried.ok) throw new Error(`carryOutPlan refused: ${carried.reason}`);
    if (carried.notApplied.length > 0 || carried.applied.length !== 1 || carried.applied[0].appliedSen !== AC.amountSen) {
      throw new Error(`the knock-off did not go as planned: ${JSON.stringify(carried)}`);
    }
    if (sb.__gaps.length > 0) throw new Error(`the shim met a method it does not implement: ${sb.__gaps.join(' | ')}`);
    const result = { noteId, noteNumber: String(raised.note.note_number), jeNo: posted.jeNo, debtor: start.debtor, bill: start.bill, control, before };
    const inside = await shapeProblems(tx, result);
    if (inside.length > 0) throw new Error(`the result is not the expected shape:\n  ${inside.join('\n  ')}`);
    out(`${result.noteNumber} POSTED as ${result.jeNo}: Dr ${AC.account} ${rm(AC.amountSen)} / Cr ${control} ${rm(AC.amountSen)} (${start.debtor.name})`);
    out(`${AC.bill}: owes ${rm(start.owed)} → ${rm(start.owed - AC.amountSen)}; ${start.debtor.name} on ${control} ${rm(before.debtorSen)} → ${rm(before.debtorSen - AC.amountSen)}`);
    if (!APPLY) throw new Rollback('plan');
    return result;
  });
} catch (e) {
  await sql.end();
  if (e instanceof Rollback) { out('PLAN — every check passed; rolled back, nothing written. Re-run with MODE=apply and the CONFIRM phrase.'); process.exit(0); }
  stop(`ROLLED BACK — nothing was written. ${String(e?.message ?? e)}`);
}
await sql.end();

// ── Verify, on a FRESH connection ────────────────────────────────────────────
const check = postgres(process.env.DATABASE_URL, DB_OPTIONS);
let problems;
try {
  problems = await shapeProblems(check, done);
} finally {
  await check.end();
}
if (problems.length > 0) stop(`VERIFY FAILED after commit:\n  ${problems.join('\n  ')}`);
out(`APPLIED — ${done.noteNumber} (${done.jeNo}) verified on a fresh connection.`);
