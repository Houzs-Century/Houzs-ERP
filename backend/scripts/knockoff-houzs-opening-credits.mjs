#!/usr/bin/env node
// knockoff-houzs-opening-credits.mjs — Houzs (company 1): the 85 AutoCount
// supplier payments that were never knocked off (the opening credits of 31/08,
// RM 3,039,418.64 — AutoCount's own Creditor Aging lists the same 85) knocked
// off each supplier's opening bills, OLDEST BILL FIRST, so both close and each
// supplier shows only what it is really owed.
//
// WHY. Owner 2026-10-28 on the Supplier & Other Creditor CN / DN page: 感觉不太对，
// 有这么多cn吗? — they are payments, not credit notes: HOOKKA 23 payments
// RM 903,853.53 against 198 unpaid bills RM 906,597.00 (owes RM 2,743.47), and
// the same for OHANA STUDIO, DORSETTLOFT, ARMANI SOFA. Then 「可以，但是明天才做」;
// 2026-10-29 「可以开始做了」 — the trial Excel first, apply on his word.
//
// HOW. The app's own knock-off, driven over DATABASE_URL through
// lib/pgrest-shim.mjs: acc/credit-note-allocations.ts applyCreditNote — what
// ticking an invoice under Knock off on a posted supplier note runs (the
// allocation row, the bill's paid_sen through scm.settle_api_paid_sen,
// applied_sen = what the settle moved). No journal is written: each payment's
// money is already in the books; this is the documents' side of it.
//   - Credits: the supplier's opening notes "AutoCount payment not knocked off",
//     oldest payment first; bills: the supplier's opening AP invoices still
//     owing, oldest first. A payment fills bills until it is used up; what no
//     bill takes stays with the supplier as its advance.
//   - PICKS (optional JSON file, scripts/data/<name>): the owner's re-pointing —
//     [{ "payment": "HC-SCN-…", "bill": "HC-API-…", "amountSen": n }] — taken
//     first, then oldest-first fills the rest.
// MODE=plan (default) runs it all in ONE transaction and rolls it back; KO| and
// SUM| lines carry the picture for the Excel. MODE=apply with CONFIRM="KNOCK OFF
// HOUZS OPENING CREDITS" keeps it. Verified inside the transaction (and again on
// a fresh connection after apply): every bill's paid_sen moved by exactly its
// picks, every payment's applied_sen is its picks, each supplier's net
// (bills owing − credit left) unchanged, no journal written, no shim gap.
//
// RE-RUN: harmless — a payment already knocked off has no credit left to place.
//
// Env: DATABASE_URL, COMPANY_ID (1), PICKS (optional file name in scripts/data).

import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { applyCreditNote } from '../src/acc/credit-note-allocations.ts';
import { CREDIT_NOTE_HEADER } from '../src/acc/credit-notes.ts';

const MODE = String(process.env.MODE || 'plan').trim().toLowerCase();
const APPLY = MODE === 'apply' || process.env.APPLY === '1';
const PHRASE = 'KNOCK OFF HOUZS OPENING CREDITS';
const CO = Number(process.env.COMPANY_ID || 1);
const PICKS_FILE = String(process.env.PICKS || '').trim();
const WHO = 'Opening credits knocked off, oldest bill first (owner 2026-10-29)';
/* `date` as PostgREST's 'YYYY-MM-DD' text, not a JS Date — the app code reads text. */
const DB_OPTIONS = { max: 1, prepare: false, types: { dateText: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } } };

const stop = (msg, code = 1) => { console.error(msg); process.exit(code); };
if (CO !== 1) stop('This is Houzs\'s opening — COMPANY_ID must be 1.', 2);
if (APPLY && (process.env.CONFIRM ?? '').trim() !== PHRASE) stop(`CONFIRM must be exactly "${PHRASE}" to apply. Nothing was written.`, 2);
if (!process.env.DATABASE_URL) stop('DATABASE_URL is not set.', 2);
if (PICKS_FILE && !/^[A-Za-z0-9._-]+\.json$/.test(PICKS_FILE)) stop('PICKS names a .json file in scripts/data.', 2);

const rm = (sen) => `RM ${(Number(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const out = (s) => console.log(`ROW|${s}`);
const emit = (tag, o) => console.log(`${tag}|${JSON.stringify(o)}`);
class Rollback extends Error {}

/* The shim answers an rpc as `SELECT f(...) AS result`: right for a scalar, but a
   RETURNS TABLE settle comes back as one record string and would read 0 applied.
   The settle functions go through `SELECT * FROM`, answering with their rows as
   PostgREST does. */
const TABLE_RPCS = new Set(['settle_api_paid_sen', 'settle_pi_paid_sen', 'settle_odb_received_sen']);
function withTableRpc(tx, base) {
  return {
    ...base,
    async rpc(name, args = {}) {
      if (!TABLE_RPCS.has(name)) return base.rpc(name, args);
      const keys = Object.keys(args);
      if (!keys.every((k) => /^p_[a-z_]+$/.test(k))) return { data: null, error: { message: `unexpected argument names for ${name}` } };
      try {
        const rows = await tx.unsafe(`SELECT * FROM scm.${name}(${keys.map((k, i) => `${k} := $${i + 1}`).join(', ')})`, keys.map((k) => args[k]));
        return { data: rows.map((r) => ({ ...r })), error: null };
      } catch (e) {
        return { data: null, error: { message: e instanceof Error ? e.message : String(e) } };
      }
    },
  };
}

/* AutoCount's own number, as the opening import wrote it into the note:
   "… AutoCount PI-007883 — supplier invoice …", "… AutoCount payment not knocked
   off HPV-2506-072 (CNY …)", "… AutoCount debit note <ref>"; an exchange-
   difference paper names none. */
const acDocOf = (notes) => {
  const s = String(notes ?? '');
  if (/exchange difference/i.test(s)) return 'exchange difference';
  return /AutoCount (?:payment not knocked off |debit note )?([^\s(—,;]+)/.exec(s.replace(/^.*?from AutoCount:\s*/, ''))?.[1] ?? null;
};

/** Every supplier's opening payments and opening bills, read the same way before and after. */
async function readOpening(db) {
  const credits = await db`
    SELECT n.id, n.note_number, n.note_date, n.total_sen, n.supplier_id, n.notes, n.reason,
           coalesce((SELECT sum(applied_sen) FROM scm.acc_credit_note_allocations a WHERE a.note_id = n.id), 0)::bigint AS applied
      FROM scm.acc_credit_notes n
     WHERE n.company_id = ${CO} AND n.kind = 'SCN' AND n.opening AND n.status = 'POSTED'
       AND coalesce(n.notes, n.reason, '') LIKE '%payment not knocked off%'
     ORDER BY n.note_date, n.note_number`;
  const bills = await db`
    SELECT id, invoice_number, invoice_date, supplier_invoice_ref, notes, total_sen, paid_sen, status, supplier_id
      FROM scm.ap_invoices
     WHERE company_id = ${CO} AND opening AND status IN ('POSTED', 'PARTIALLY_PAID') AND total_sen > paid_sen
     ORDER BY invoice_date, invoice_number`;
  const suppliers = await db`SELECT id, code, name FROM scm.suppliers WHERE company_id = ${CO} AND id = ANY(${[...new Set(credits.map((c) => String(c.supplier_id)))]}::uuid[])`;
  return { credits, bills, supplierById: new Map(suppliers.map((s) => [String(s.id), s])) };
}

/** Oldest bill first, after the owner's picks. Returns [{ credit, bill, sen }]. */
function plan(credits, bills, picks) {
  const left = new Map(credits.map((c) => [String(c.id), Number(c.total_sen) - Number(c.applied)]));
  const owing = new Map(bills.map((b) => [String(b.id), Number(b.total_sen) - Number(b.paid_sen)]));
  const creditByNo = new Map(credits.map((c) => [c.note_number, c]));
  const billByNo = new Map(bills.map((b) => [b.invoice_number, b]));
  const moves = [];
  const take = (c, b, sen) => {
    if (sen <= 0) return;
    moves.push({ credit: c, bill: b, sen });
    left.set(String(c.id), left.get(String(c.id)) - sen);
    owing.set(String(b.id), owing.get(String(b.id)) - sen);
  };
  for (const p of picks) {
    const c = creditByNo.get(p.payment); const b = billByNo.get(p.bill);
    if (!c || !b) throw new Error(`pick ${p.payment} → ${p.bill}: ${!c ? 'no such open payment' : 'no such open bill'}`);
    if (String(c.supplier_id) !== String(b.supplier_id)) throw new Error(`pick ${p.payment} → ${p.bill}: not the same supplier`);
    const sen = Number(p.amountSen);
    if (!Number.isInteger(sen) || sen <= 0 || sen > left.get(String(c.id)) || sen > owing.get(String(b.id))) throw new Error(`pick ${p.payment} → ${p.bill}: ${p.amountSen} does not fit`);
    take(c, b, sen);
  }
  const billsBySupplier = new Map();
  for (const b of bills) {
    const k = String(b.supplier_id);
    if (!billsBySupplier.has(k)) billsBySupplier.set(k, []);
    billsBySupplier.get(k).push(b);
  }
  for (const c of credits) {
    for (const b of billsBySupplier.get(String(c.supplier_id)) ?? []) {
      const room = Math.min(left.get(String(c.id)), owing.get(String(b.id)));
      if (room > 0) take(c, b, room);
      if (left.get(String(c.id)) === 0) break;
    }
  }
  return { moves, left, owing };
}

/** Each supplier's figures: bills owing, credit left, the net. */
function bySupplier(credits, bills) {
  const s = new Map();
  const row = (id) => { if (!s.has(id)) s.set(id, { credits: 0, creditSen: 0, creditLeft: 0, bills: 0, billOwing: 0 }); return s.get(id); };
  for (const c of credits) { const r = row(String(c.supplier_id)); r.credits += 1; r.creditSen += Number(c.total_sen); r.creditLeft += Number(c.total_sen) - Number(c.applied); }
  for (const b of bills) { if (!s.has(String(b.supplier_id))) continue; const r = row(String(b.supplier_id)); r.bills += 1; r.billOwing += Number(b.total_sen) - Number(b.paid_sen); }
  return s;
}

const sql = postgres(process.env.DATABASE_URL, DB_OPTIONS);
out(`mode ${APPLY ? 'APPLY' : 'plan (rolled back)'}, company ${CO}${PICKS_FILE ? `, picks ${PICKS_FILE}` : ''}`);
let done;
try {
  done = await sql.begin(async (tx) => {
    const sb = withTableRpc(tx, pgrestShim(tx, 'scm'));
    const before = await readOpening(tx);
    const [{ n: jeBefore }] = await tx`SELECT count(*)::int AS n FROM scm.journal_entries WHERE company_id = ${CO}`;
    const picks = PICKS_FILE ? JSON.parse(readFileSync(new URL(`./data/${PICKS_FILE}`, import.meta.url), 'utf8')) : [];
    const { moves, left } = plan(before.credits, before.bills, picks);
    const sumBefore = bySupplier(before.credits, before.bills);
    out(`${before.credits.length} opening payments ${rm(before.credits.reduce((t, c) => t + Number(c.total_sen) - Number(c.applied), 0))} open; ${before.bills.length} opening bills owing; ${moves.length} knock-offs planned`);

    /* One applyCreditNote per payment — its whole picture at once, as the page's Save does. */
    const byCredit = new Map();
    for (const m of moves) {
      const k = String(m.credit.id);
      if (!byCredit.has(k)) byCredit.set(k, []);
      byCredit.get(k).push(m);
    }
    for (const [creditId, ms] of byCredit) {
      const { data: note, error } = await sb.from('acc_credit_notes').select(CREDIT_NOTE_HEADER).eq('company_id', CO).eq('id', creditId).single();
      if (error || !note) throw new Error(`read ${ms[0].credit.note_number}: ${error?.message ?? 'missing'}`);
      const r = await applyCreditNote(sb, { companyId: CO, note, targets: ms.map((m) => ({ kind: 'API', id: String(m.bill.id), amountSen: m.sen })), actor: WHO });
      if (!r.ok) throw new Error(`${ms[0].credit.note_number}: ${r.refusal.error} — ${r.refusal.message}`);
      for (const a of r.applied) {
        const m = ms.find((x) => String(x.bill.id) === a.id);
        if (!m || a.appliedSen !== m.sen) throw new Error(`${ms[0].credit.note_number} → ${a.number}: applied ${a.appliedSen}, planned ${m?.sen}`);
      }
    }
    if (sb.__gaps.length > 0) throw new Error(`the shim met a method it does not implement: ${sb.__gaps.join(' | ')}`);

    /* The picture for the Excel. */
    for (const m of moves) {
      const s = before.supplierById.get(String(m.credit.supplier_id));
      emit('KO', {
        supplier: s?.code ?? '', supplierName: s?.name ?? '',
        payment: m.credit.note_number, acPayment: acDocOf(m.credit.notes ?? m.credit.reason), paymentDate: m.credit.note_date, paymentSen: Number(m.credit.total_sen),
        bill: m.bill.invoice_number, acBill: acDocOf(m.bill.notes), supplierRef: m.bill.supplier_invoice_ref, billDate: m.bill.invoice_date,
        billSen: Number(m.bill.total_sen), billOwingBefore: Number(m.bill.total_sen) - Number(m.bill.paid_sen), sen: m.sen,
      });
    }
    for (const c of before.credits) {
      const l = left.get(String(c.id));
      if (l > 0) {
        const s = before.supplierById.get(String(c.supplier_id));
        emit('LEFT', { supplier: s?.code ?? '', supplierName: s?.name ?? '', payment: c.note_number, acPayment: acDocOf(c.notes ?? c.reason), paymentDate: c.note_date, paymentSen: Number(c.total_sen), leftSen: l });
      }
    }

    /* Read it all back. */
    const after = await readOpening(tx);
    const sumAfter = bySupplier(after.credits, after.bills);
    const problems = [];
    for (const [id, b] of sumBefore) {
      const a = sumAfter.get(id) ?? { creditLeft: 0, billOwing: 0, bills: 0 };
      const s = before.supplierById.get(id);
      const netB = b.billOwing - b.creditLeft; const netA = a.billOwing - a.creditLeft;
      if (netA !== netB) problems.push(`${s?.code}: net ${rm(netB)} → ${rm(netA)}`);
      emit('SUM', { supplier: s?.code ?? '', supplierName: s?.name ?? '', credits: b.credits, creditSen: b.creditSen, bills: b.bills, billOwingBefore: b.billOwing,
        knockedOff: b.creditLeft - a.creditLeft, creditLeftAfter: a.creditLeft, billsOwingAfter: a.bills, billOwingAfter: a.billOwing, net: netA });
    }
    const paid = new Map();
    for (const m of moves) paid.set(String(m.bill.id), (paid.get(String(m.bill.id)) ?? 0) + m.sen);
    const touched = await tx`SELECT id, invoice_number, total_sen, paid_sen, status FROM scm.ap_invoices WHERE company_id = ${CO} AND id = ANY(${[...paid.keys()]}::uuid[])`;
    for (const t of touched) {
      const b = before.bills.find((x) => String(x.id) === String(t.id));
      const want = Number(b.paid_sen) + paid.get(String(t.id));
      const status = want >= Number(t.total_sen) ? 'PAID' : 'PARTIALLY_PAID';
      if (Number(t.paid_sen) !== want || t.status !== status) problems.push(`${t.invoice_number}: paid ${t.paid_sen} ${t.status}, want ${want} ${status}`);
    }
    const [{ n: jeAfter }] = await tx`SELECT count(*)::int AS n FROM scm.journal_entries WHERE company_id = ${CO}`;
    if (jeAfter !== jeBefore) problems.push(`journals ${jeBefore} → ${jeAfter} — a knock-off writes none`);
    if (problems.length > 0) throw new Error(`the result is not the expected shape:\n  ${problems.join('\n  ')}`);
    const knocked = moves.reduce((t, m) => t + m.sen, 0);
    const paidOff = touched.filter((t) => t.status === 'PAID').length;
    out(`knocked off ${rm(knocked)} across ${paid.size} bills (${paidOff} now PAID); payments still open ${[...left.values()].filter((v) => v > 0).length} (${rm([...left.values()].reduce((t, v) => t + v, 0))}); every supplier's net unchanged; no journal written`);
    if (!APPLY) throw new Rollback('plan');
    return { knocked, bills: paid.size };
  });
} catch (e) {
  await sql.end();
  if (e instanceof Rollback) { out('PLAN — every check passed; rolled back, nothing written.'); process.exit(0); }
  stop(`ROLLED BACK — nothing was written. ${String(e?.message ?? e)}`);
}
await sql.end();
out(`APPLIED — ${rm(done.knocked)} knocked off across ${done.bills} bills.`);
