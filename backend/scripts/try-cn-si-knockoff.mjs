#!/usr/bin/env node
// try-cn-si-knockoff.mjs — a ROLLED-BACK production trial of the customer credit
// note knock-off (migration 20261105T2000, owner 2026-11-03 「要」). It never
// keeps anything: every step runs inside ONE transaction that always rolls back,
// through the app's real routes over the database, then a fresh read proves the
// column is absent again.
//
// What it walks, per company, on a real open invoice: the new note's table, a
// draft with its plan, the post (one journal, nothing more), the invoice's lower
// outstanding on Money in, Outstanding and its page, the AR aging, untick, tick
// again, cancel. And the facts the design leans on: the deposit notes the list
// marks, and any invoice whose paid_sen is not the sum of its payments (a status
// roll rewrites paid_sen from the payments).
//
// MODE=plan only (an apply is refused). RE-RUN: any time; nothing persists.
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { Hono } from 'hono';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { pgSslMode } from './lib/pg-ssl-mode.mjs';
import { SCM_SYSTEM_STAFF_ID } from '../src/scm/middleware/auth.ts';
import { creditNotes } from '../src/scm/routes/credit-notes.ts';
import { arInvoices } from '../src/scm/routes/ar-invoices.ts';
import { outstanding } from '../src/scm/routes/outstanding.ts';
import { arAgingHandler } from '../src/scm/routes/accounting-aging.ts';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(2); }
if (process.env.APPLY === '1' || (process.env.MODE && process.env.MODE !== 'plan')) {
  console.error('This trial is plan-only: it always rolls back.'); process.exit(1);
}
const MIGRATION = new URL('../src/db/migrations-pg/20261105T2000_acc_credit_note_sales_invoice_target.sql', import.meta.url);
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const sql = postgres(url, { ssl: pgSslMode(url), max: 1, prepare: false, types: { dateText: asText(1082), tsText: asText(1114), tstzText: asText(1184) } });
const out = (s) => console.log(`ROW|${s}`);
const rm = (sen) => `RM ${(Number(sen ?? 0) / 100).toFixed(2)}`;
const bad = [];
const check = (ok, what) => { out(`${ok ? 'ok ' : 'BAD'} ${what}`); if (!ok) bad.push(what); };
const TODAY = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
class Rollback extends Error {}

function appFor(tx, co, code) {
  const sb = pgrestShim(tx, 'scm');
  const app = new Hono();
  app.onError((e, c) => c.json({ error: 'thrown', message: String(e?.stack ?? e) }, 500));
  app.use('*', async (c, next) => {
    c.set('supabase', sb);
    c.set('companyId', co);
    c.set('user', { id: SCM_SYSTEM_STAFF_ID });
    c.set('houzsUser', { id: 0, name: 'dry-run', permissions_set: new Set(['*']) });
    c.set('allowedCompanyIds', [co]);
    c.set('companies', [{ id: co, code }]);
    c.set('companyCode', code);
    await next();
  });
  app.route('/credit-notes', creditNotes);
  app.route('/ar-invoices', arInvoices);
  app.route('/outstanding', outstanding);
  app.get('/ar-aging', arAgingHandler);
  const req = async (path, method = 'GET', body) => {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 400) }; }
    return { status: res.status, body: json };
  };
  return { req, sb };
}

async function trial(tx, co, code) {
  out(`== company ${co} (${code})`);
  const { req, sb } = appFor(tx, co, code);

  const off = await tx`
    SELECT si.invoice_number, si.status, si.paid_sen, p.s AS payments_sen
      FROM scm.sales_invoices si
      LEFT JOIN LATERAL (SELECT coalesce(sum(amount_sen), 0)::bigint AS s FROM scm.sales_invoice_payments x WHERE x.sales_invoice_id = si.id) p ON true
     WHERE si.company_id = ${co} AND si.status NOT IN ('DRAFT', 'CANCELLED') AND si.paid_sen <> p.s
     ORDER BY si.invoice_number`;
  out(`invoices whose paid_sen is not the sum of their payments: ${off.length}`);
  for (const r of off.slice(0, 12)) out(`  ${r.invoice_number} ${r.status} paid_sen ${rm(r.paid_sen)} payments ${rm(r.payments_sen)}`);

  const list = await req('/credit-notes?side=AR');
  check(list.status === 200, `the AR notes list reads: ${list.status}`);
  const cns = (list.body.rows ?? []).filter((r) => r.kind === 'CN');
  const kinds = {};
  for (const r of cns) { const k = `${r.status}/${r.depositPaper ?? 'plain'}`; kinds[k] = (kinds[k] ?? 0) + 1; }
  out(`customer notes: ${JSON.stringify(kinds)}`);
  const closes = cns.find((r) => r.depositPaper === 'closes' && r.status === 'POSTED');
  if (closes) {
    const d = await req(`/credit-notes/${closes.id}`);
    const t = await req(`/credit-notes/${closes.id}/knock-off`);
    const put = await req(`/credit-notes/${closes.id}/allocations`, 'PUT', { targets: [] });
    check(d.status === 200 && d.body.leftSen === 0, `close-out ${closes.note_number}: nothing left to knock off; final invoice ${d.body.closedInvoice?.number ?? '-'}`);
    check(Boolean(t.body.refusal) && (t.body.rows ?? []).length === 0, `close-out's table says why: ${String(t.body.refusal ?? '').slice(0, 70)}`);
    check(put.status === 409 && put.body.error === 'deposit_note', `close-out's knock-off refused: ${put.status} ${put.body.error}`);
  }

  /* A real open invoice that owes something after its deposit. */
  const cands = await tx`
    SELECT id, invoice_number, so_doc_no, debtor_code, debtor_name, total_sen, paid_sen, status
      FROM scm.sales_invoices
     WHERE company_id = ${co} AND status IN ('SENT', 'PARTIALLY_PAID', 'OVERDUE') AND total_sen > paid_sen AND coalesce(debtor_name, '') <> ''
     ORDER BY invoice_date DESC, invoice_number DESC LIMIT 80`;
  let pick = null; let row = null;
  for (const s of cands) {
    const q = s.so_doc_no ? `so=${encodeURIComponent(s.so_doc_no)}` : `customer=${encodeURIComponent(s.debtor_name)}`;
    const t = await req(`/credit-notes/knock-off?${q}`);
    if (t.status !== 200) { check(false, `the table for ${s.invoice_number}: ${t.status} ${JSON.stringify(t.body).slice(0, 160)}`); continue; }
    const hit = (t.body.rows ?? []).find((r) => r.id === s.id && r.owedSen >= 1000);
    if (hit) {
      pick = s; row = hit;
      out(`the table for ${s.debtor_name} (${s.debtor_code ?? 'no code'}): ${t.body.rows.map((r) => `${r.number} ${rm(r.owedSen)}`).join(', ')}`);
      break;
    }
  }
  if (!pick) { out(`no open invoice owing RM 10 or more among ${cands.length} — nothing to walk here`); return; }
  const take = Math.min(row.owedSen, 10_000);
  const total = take + 500;
  out(`walking ${pick.invoice_number} ${pick.status}: total ${rm(pick.total_sen)}, paid_sen ${rm(pick.paid_sen)}, owes ${rm(row.owedSen)}; note ${rm(total)}, knock off ${rm(take)}`);

  const arRow = async () => ((await req('/ar-invoices?kind=SI')).body.rows ?? []).find((r) => r.id === pick.id);
  const agingOf = async () => {
    const a = await req(`/ar-aging?asOf=${TODAY}`);
    if (a.status !== 200) { check(false, `the aging: ${a.status} ${JSON.stringify(a.body).slice(0, 200)}`); return null; }
    const open = (a.body.rows ?? []).flatMap((r) => r.items ?? []).filter((i) => i.docNo === pick.invoice_number).reduce((n, i) => n + Number(i.openSen), 0);
    return { open, difference: a.body.differenceSen, total: a.body.totals?.balanceSen };
  };
  const ar0 = await arRow();
  const aging0 = await agingOf();
  out(`before: list outstanding ${rm(ar0?.outstandingSen)}, deposit ${rm(ar0?.depositAppliedSen)}, credit notes ${rm(ar0?.creditNotesSen)}; aging open ${rm(aging0?.open)}, total ${rm(aging0?.total)}, difference ${rm(aging0?.difference)}`);

  const made = await req('/credit-notes', 'POST', {
    kind: 'CN', ...(pick.so_doc_no ? { soDocNo: pick.so_doc_no } : { partyName: pick.debtor_name }), noteDate: TODAY, reason: 'DRY RUN',
    lines: [{ description: 'Dry run', amountSen: total }], allocations: [{ kind: 'SI', id: pick.id, amountSen: take }],
  });
  check(made.status === 201, `the draft with its plan: ${made.status} ${made.status === 201 ? made.body.note.note_number : JSON.stringify(made.body).slice(0, 200)}`);
  if (made.status !== 201) return;
  const note = made.body.note;
  const posted = await req(`/credit-notes/${note.id}/post`, 'POST');
  check(posted.status === 200 && (posted.body.applied ?? []).length === 1 && posted.body.applied[0].appliedSen === take && !posted.body.notApplied,
    `the post: ${posted.status} je ${posted.body.jeNo ?? '-'} applied ${JSON.stringify(posted.body.applied ?? [])}${posted.body.notApplied ? ` notApplied ${posted.body.notApplied}` : ''}`);

  const jes = await tx`SELECT id, je_no, source_type, total_debit_sen FROM scm.journal_entries WHERE company_id = ${co} AND source_doc_no = ${note.note_number}`;
  check(jes.length === 1 && Number(jes[0].total_debit_sen) === total, `one journal for the note's whole amount: ${jes.map((j) => `${j.je_no} ${j.source_type} ${rm(j.total_debit_sen)}`).join(', ')}`);
  for (const l of await tx`SELECT account_code, debit_sen, credit_sen, party_code, party_name FROM scm.journal_entry_lines WHERE journal_entry_id = ${jes[0]?.id ?? null} ORDER BY debit_sen DESC`) {
    out(`  ${l.account_code} Dr ${rm(l.debit_sen)} Cr ${rm(l.credit_sen)} ${l.party_code ?? ''} ${l.party_name ?? ''}`);
  }
  const [si1] = await tx`SELECT paid_sen, status FROM scm.sales_invoices WHERE id = ${pick.id}`;
  out(`after the post the invoice reads ${si1.status}, paid_sen ${rm(si1.paid_sen)}`);
  const [paidNow] = await tx`SELECT coalesce(sum(amount_sen), 0)::bigint AS s FROM scm.sales_invoice_payments WHERE sales_invoice_id = ${pick.id}`;
  check(Number(si1.paid_sen) === Number(paidNow.s), `paid_sen is still its payments: ${rm(si1.paid_sen)} = ${rm(paidNow.s)}`);

  const ar1 = await arRow();
  check(ar1?.creditNotesSen === take, `Money in reads the credit: ${rm(ar1?.creditNotesSen)}`);
  check(ar1?.outstandingSen === Math.max(0, ar0.outstandingSen - take), `Money in's outstanding: ${rm(ar0?.outstandingSen)} → ${rm(ar1?.outstandingSen)}`);
  const page = await req(`/ar-invoices/sales/${pick.id}/credit-notes`);
  check(page.status === 200 && (page.body.creditNotes ?? []).some((n) => n.number === note.note_number && n.amountSen === take), `the invoice's page lists it: ${JSON.stringify(page.body.creditNotes ?? []).slice(0, 170)}`);
  const outs = await req(`/outstanding/si?q=${encodeURIComponent(pick.invoice_number)}&search=${encodeURIComponent(pick.invoice_number)}&limit=2000`);
  const outRow = (outs.body.rows ?? []).find((r) => r.invoice_number === pick.invoice_number);
  if (outRow) check(outRow.credit_notes_sen === take && Number(outRow.outstanding_sen) === ar1.outstandingSen, `Outstanding reads the same: ${rm(outRow.outstanding_sen)}, credit notes ${rm(outRow.credit_notes_sen)}`);
  else out(`Outstanding: the invoice is not on the page read (${outs.status}, ${(outs.body.rows ?? []).length} rows)`);
  const aging1 = await agingOf();
  out(`after: aging open ${rm(aging1?.open)}, total ${rm(aging1?.total)}, difference ${rm(aging1?.difference)}`);
  check(aging1?.difference === aging0?.difference, 'the aging still ties to the control as it did');
  check(aging1?.total === aging0?.total - total, `the aging's total moved by the note: ${rm(aging0?.total)} → ${rm(aging1?.total)}`);
  check(aging1?.open <= aging0?.open, `the invoice's open figure did not grow: ${rm(aging0?.open)} → ${rm(aging1?.open)}`);

  const listed = ((await req('/credit-notes?side=AR')).body.rows ?? []).find((r) => r.id === note.id);
  check(listed?.appliedSen === take && listed?.unusedSen === 500, `the list's Knocks off: ${rm(listed?.appliedSen)}, left ${rm(listed?.unusedSen)}`);
  const detail = await req(`/credit-notes/${note.id}`);
  check(detail.status === 200 && (detail.body.allocations ?? [])[0]?.number === pick.invoice_number, `the note's detail names the invoice: ${(detail.body.allocations ?? [])[0]?.number ?? '-'} ${(detail.body.allocations ?? [])[0]?.docDate ?? ''}`);

  const over = await req(`/credit-notes/${note.id}/allocations`, 'PUT', { targets: [{ kind: 'SI', id: pick.id, amountSen: total + 1 }] });
  check(over.status === 409, `more than the note is refused: ${over.status} ${over.body.message ?? ''}`);
  const untick = await req(`/credit-notes/${note.id}/allocations`, 'PUT', { targets: [] });
  check(untick.status === 200, `untick: ${untick.status}`);
  const ar2 = await arRow();
  check(ar2?.outstandingSen === ar0.outstandingSen && !ar2?.creditNotesSen, `untick gives it back: ${rm(ar2?.outstandingSen)}`);
  const [si2] = await tx`SELECT status FROM scm.sales_invoices WHERE id = ${pick.id}`;
  out(`after untick the invoice reads ${si2.status}`);

  const again = await req(`/credit-notes/${note.id}/allocations`, 'PUT', { targets: [{ kind: 'SI', id: pick.id, amountSen: take }] });
  check(again.status === 200, `tick again: ${again.status}`);
  const cancel = await req(`/credit-notes/${note.id}/cancel`, 'POST');
  check(cancel.status === 200, `cancel: ${cancel.status} ${JSON.stringify(cancel.body).slice(0, 120)}`);
  const [{ n: rowsLeft }] = await tx`SELECT count(*)::int AS n FROM scm.acc_credit_note_allocations WHERE note_id = ${note.id}`;
  check(rowsLeft === 0, `the cancel gave the knock-off back: ${rowsLeft} rows left`);
  const ar3 = await arRow();
  check(ar3?.outstandingSen === ar0.outstandingSen, `the invoice owes it again: ${rm(ar3?.outstandingSen)}`);
  const aging3 = await agingOf();
  check(aging3?.total === aging0?.total && aging3?.open === aging0?.open, `the aging is back where it was: total ${rm(aging3?.total)}, open ${rm(aging3?.open)}`);
  const gaps = sb.__gaps ?? [];
  check(gaps.length === 0, `no shim gaps: ${JSON.stringify(gaps).slice(0, 200)}`);
}

try {
  await sql.begin(async (tx) => {
    await tx.unsafe('RESET search_path');
    const companies = await tx`SELECT id, code FROM public.companies ORDER BY id`;
    await tx.unsafe(readFileSync(MIGRATION, 'utf8'));
    await tx.unsafe(readFileSync(MIGRATION, 'utf8'));
    await tx.unsafe('RESET search_path');
    const [col] = await tx`SELECT data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'scm' AND table_name = 'acc_credit_note_allocations' AND column_name = 'sales_invoice_id'`;
    out(`the migration ran twice; sales_invoice_id ${col?.data_type} nullable=${col?.is_nullable}`);
    const checks = await tx`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'scm.acc_credit_note_allocations'::regclass AND contype = 'c'`;
    for (const k of checks) out(`  check ${k.conname}: ${k.def}`);
    const [{ n: existing }] = await tx`SELECT count(*)::int AS n FROM scm.acc_credit_note_allocations`;
    out(`existing allocation rows, all still valid under the new check: ${existing}`);
    for (const c of companies) await trial(tx, Number(c.id), String(c.code));
    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) { console.error(`FAILED: ${e?.stack ?? e?.message ?? e}`); bad.push('the trial threw'); }
}
const still = await sql`SELECT 1 FROM information_schema.columns WHERE table_schema = 'scm' AND table_name = 'acc_credit_note_allocations' AND column_name = 'sales_invoice_id'`;
out(`rolled back: sales_invoice_id ${still.length ? 'EXISTS (it should not!)' : 'is absent again'} on a fresh read`);
if (still.length) bad.push('the column exists after the rollback');
await sql.end();
if (bad.length) { for (const b of bad) console.error(`::error::${b}`); process.exit(1); }
out('TRIAL PASSED (rolled back).');
