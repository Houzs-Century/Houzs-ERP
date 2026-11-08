// ----------------------------------------------------------------------------
// AR Invoices — the Finance side's customer invoices, both kinds (AutoCount's
// A/R Invoice), the AP Invoices page's twin.
//
// The owner's design (2026-09-29): 可以把 sales invoice 和 other debtor bill 做
// 一个类似 ap invoice 这样让我 finance 这边看两个一起吗 → ONE table, a Kind
// column — the operational SALES INVOICES as a read-only MIRROR (raised and
// edited on Sales Order → Sales Invoices, which this page never touches; a row
// links there) beside the OTHER DEBTOR BILLS. Then, the same evening: 我希望
// other debtor 那边只是 maintain other debtor 就好, 开 other debtor 的 bill 就
// 直接在 ar invoice 页面 — the Other Debtors page keeps the registry alone; a
// bill is raised, edited, copied, cancelled and printed from AR Invoices, and
// the debtor's money is received on the Receipts page (its Other Debtor door,
// 2026-09-08). Deposit invoices stay on their own page (留着); credit and debit
// notes are not here (对).
//
//   GET /ar-invoices?kind=ALL|SI|ODB  → { rows }         both kinds, one list
//   GET /ar-invoices/bills/:billId    → { bill, debtor, receipts, creditNotes }
//                                       a debtor bill with its lines, its debtor,
//                                       the receipts and credit notes on it — its page
//   GET /ar-invoices/sales/:siId/credit-notes → { creditNotes }
//                                       the credit notes knocked off a sales
//                                       invoice, and those closing its deposits
//
// This router only READS. A debtor bill is raised, edited and cancelled through
// routes/other-debtors.ts (POST /other-debtors/:id/bills, PATCH
// /other-debtors/bills/:billId, POST …/cancel) — one write path, whichever page
// presses the button. A sales invoice's Outstanding is the Sales Invoices
// list's OWN figure — total − paid − the order's deposit applied
// (lib/si-order-deposit.ts stamps the slice) — so this page and that list can
// never disagree about the same invoice. Reads ride the finance area guard
// (GET → 'view'), as the AP list does.
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import { requireActiveCompanyId, scopeToCompany } from '../lib/companyScope';
import { stampOrderDeposit } from '../lib/si-order-deposit';
import { creditNotesOf } from '../lib/si-credit-notes';
import { DEBTOR_PARTY_COLS } from './other-debtors';

type Row = Record<string, any>;

export type ArKind = 'SI' | 'ODB';
const KINDS = new Set(['ALL', 'SI', 'ODB']);

/* The sales invoices the Finance side sees beside the bills: the LIVE ones.
   A DRAFT has posted no revenue and a CANCELLED one is dead — the purchase
   invoice mirror on the AP list draws the same line (POSTED / PARTIALLY_PAID /
   PAID / ON_HOLD, never DRAFT or CANCELLED). */
export const SI_MIRROR_STATUSES = ['SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE'] as const;

const SI_COLS = 'id, invoice_number, so_doc_no, debtor_code, debtor_name, invoice_date, due_date, currency, total_sen, local_total_sen, paid_sen, status, notes';
const BILL_COLS = 'id, bill_number, debtor_id, bill_date, total_sen, received_sen, status, notes, created_at, doc_kind';

/** One row of the list — a sales invoice (mirror) or a debtor bill; `kind` says which. */
export type ArListRow = {
  kind: ArKind;
  /** A debtor bill raised as a debit note (2026-10-28) reads 'DN'; every other row 'INV'. */
  docKind: 'INV' | 'DN';
  id: string;
  invoiceNumber: string;
  /** The party as the filter groups it: `C:<debtor code>` for a customer, `D:<debtor id>` for an other debtor. */
  partyKey: string;
  partyCode: string | null;
  partyName: string | null;
  /** The other debtor's registry id (a bill); null on a sales invoice. */
  debtorId: string | null;
  /** The sales order behind a sales invoice; a bill has none. */
  ref: string | null;
  description: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  currency: string;
  totalSen: number;
  /** Everything settling the document: an invoice's own receipts PLUS the order's deposit applied; a bill's money received. */
  paidSen: number;
  /** The slice of the order's deposit applied to a sales invoice (0 on a bill) — the "dep" marker the SI list draws. */
  depositAppliedSen: number;
  /** What customers' credit notes knocked off a sales invoice (0 on a bill, whose
      other-debtor credit notes already sit in its received) — si-credit-notes.ts. */
  creditNotesSen: number;
  outstandingSen: number;
  status: string;
};

function shapeSi(r: Row): ArListRow {
  const total = Number(r.total_sen ?? r.local_total_sen ?? 0);
  const own = Number(r.paid_sen ?? 0);
  /* null = the server could not resolve the order; it reads as 0, the LARGER
     outstanding — the one direction this may be wrong in (si-order-deposit.ts). */
  const depositRaw = Number(r.so_deposit_applied_sen ?? 0);
  const deposit = Number.isFinite(depositRaw) && depositRaw > 0 ? depositRaw : 0;
  /* Kept apart from paid (the overpayment rule reads paid_sen alone); unread, 0 — the larger outstanding. */
  const credit = creditNotesOf(r);
  const code = r.debtor_code ? String(r.debtor_code) : null;
  const name = r.debtor_name ? String(r.debtor_name) : null;
  return {
    kind: 'SI',
    docKind: 'INV',
    id: String(r.id),
    invoiceNumber: String(r.invoice_number ?? ''),
    partyKey: `C:${code ?? name ?? ''}`,
    partyCode: code,
    partyName: name,
    debtorId: null,
    ref: r.so_doc_no ? String(r.so_doc_no) : null,
    description: r.notes ? String(r.notes) : null,
    invoiceDate: r.invoice_date ?? null,
    dueDate: r.due_date ?? null,
    currency: String(r.currency ?? 'MYR'),
    totalSen: total,
    paidSen: own + deposit,
    depositAppliedSen: deposit,
    creditNotesSen: credit,
    outstandingSen: Math.max(0, total - own - deposit - credit),
    status: String(r.status ?? ''),
  };
}

function shapeBill(r: Row, debtorName: string | null, debtorCode: string | null): ArListRow {
  const total = Number(r.total_sen ?? 0);
  const received = Number(r.received_sen ?? 0);
  return {
    kind: 'ODB',
    /* 'DN' for a debit note to the debtor (2026-10-28) — a bill all the same. */
    docKind: r.doc_kind === 'DN' ? 'DN' : 'INV',
    id: String(r.id),
    invoiceNumber: String(r.bill_number ?? ''),
    partyKey: `D:${String(r.debtor_id ?? '')}`,
    partyCode: debtorCode,
    partyName: debtorName,
    debtorId: r.debtor_id ? String(r.debtor_id) : null,
    ref: null,
    description: r.notes ? String(r.notes) : null,
    invoiceDate: r.bill_date ?? null,
    dueDate: null,
    currency: 'MYR',
    totalSen: total,
    paidSen: received,
    depositAppliedSen: 0,
    creditNotesSen: 0,
    outstandingSen: Math.max(0, total - received),
    status: String(r.status ?? ''),
  };
}

/* ── GET / — both kinds, one list ─────────────────────────────────────────── */
export const listArInvoicesHandler = async (c: any): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const kind = String(c.req.query('kind') ?? 'ALL').toUpperCase();
  if (!KINDS.has(kind)) return c.json({ error: 'bad_kind', message: 'kind is ALL, SI or ODB.' }, 400);
  const sb = c.get('supabase');
  /* docKind=DN: the other debtors' debit notes alone (the CN / DN page's tab) — a
     sales invoice is never one; docKind=INV: the bills without them. */
  const docKind = String(c.req.query('docKind') ?? '').trim().toUpperCase();

  const rows: ArListRow[] = [];
  if (kind === 'ALL' || kind === 'ODB') {
    let q = scopeToCompany(sb.from('acc_debtor_bills').select(BILL_COLS), c);
    if (docKind === 'DN' || docKind === 'INV') q = q.eq('doc_kind', docKind);
    const { data, error } = await q.order('bill_date', { ascending: false }).limit(500);
    if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
    const bills = (data ?? []) as Row[];
    /* The debtor's name and account code off the registry — read whole, never
       assumed: a bill whose debtor cannot be read prints "(debtor)", not the
       wrong name. */
    const who = new Map<string, { name: string; code: string | null }>();
    const ids = [...new Set(bills.map((b) => String(b.debtor_id ?? '')).filter(Boolean))];
    if (ids.length > 0) {
      const { data: debtors, error: dErr } = await scopeToCompany(sb.from('acc_debtors').select('id, name, code').in('id', ids), c);
      if (dErr) return c.json({ error: 'load_failed', reason: dErr.message }, 500);
      for (const d of (debtors ?? []) as Row[]) who.set(String(d.id), { name: String(d.name ?? ''), code: d.code ? String(d.code) : null });
    }
    for (const b of bills) {
      const d = who.get(String(b.debtor_id ?? ''));
      rows.push(shapeBill(b, d?.name ?? null, d?.code ?? null));
    }
  }
  if ((kind === 'ALL' || kind === 'SI') && docKind !== 'DN') {
    /* The operational invoices, read-only here: the Sales side raises and
       edits them; this list only SHOWS them beside the bills so Finance sees
       every ringgit owed to the company in one place. */
    const { data, error } = await scopeToCompany(
      sb.from('sales_invoices').select(SI_COLS).in('status', [...SI_MIRROR_STATUSES]), c,
    ).order('invoice_date', { ascending: false }).limit(500);
    if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
    /* The order's deposit, the SI list's own stamp — the outstanding here IS
       that list's figure. */
    await stampOrderDeposit(sb, data, co.companyId);
    for (const r of (data ?? []) as Row[]) rows.push(shapeSi(r));
  }
  rows.sort((a, b) => String(b.invoiceDate ?? '').localeCompare(String(a.invoiceDate ?? '')) || b.invoiceNumber.localeCompare(a.invoiceNumber));
  return c.json({ rows });
};

/* ── GET /bills/:billId — a debtor bill with its lines and its debtor ─────── */
export const arBillDetailHandler = async (c: any): Promise<Response> => {
  const sb = c.get('supabase');
  const { data, error } = await scopeToCompany(sb.from('acc_debtor_bills').select(BILL_COLS).eq('id', c.req.param('billId')), c).maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_found', message: 'That bill is not in the company you are working in.' }, 404);
  const bill = data as Row;
  const [lines, debtor, receiptAllocs, noteAllocs] = await Promise.all([
    scopeToCompany(sb.from('acc_debtor_bill_lines').select('id, bill_id, line_no, description, credit_account_code, amount_sen, project_id').eq('bill_id', bill.id), c).order('line_no'),
    scopeToCompany(sb.from('acc_debtors').select(`id, name, phone, notes, is_active, ${DEBTOR_PARTY_COLS}`).eq('id', bill.debtor_id), c).maybeSingle(),
    /* What came in on it and what credited it (the owner's Claude Design, batch 5
       §8.3 c8): the debtor receipts that knock it off, and the other-debtor
       credit notes allocated to it. */
    scopeToCompany(sb.from('acc_debtor_receipt_allocations').select('receipt_id, amount_sen').eq('bill_id', bill.id), c),
    scopeToCompany(sb.from('acc_credit_note_allocations').select('note_id, amount_sen, applied_sen').eq('debtor_bill_id', bill.id), c),
  ]);
  if (lines.error) return c.json({ error: 'load_failed', reason: lines.error.message }, 500);
  if (debtor.error) return c.json({ error: 'load_failed', reason: debtor.error.message }, 500);
  if (receiptAllocs.error) return c.json({ error: 'load_failed', reason: receiptAllocs.error.message }, 500);
  if (noteAllocs.error) return c.json({ error: 'load_failed', reason: noteAllocs.error.message }, 500);
  const rAllocs = (receiptAllocs.data ?? []) as Row[];
  const nAllocs = (noteAllocs.data ?? []) as Row[];
  const [receiptRows, noteRows] = await Promise.all([
    rAllocs.length > 0
      ? scopeToCompany(sb.from('acc_debtor_receipts').select('id, receipt_number, receipt_date, status, submitted_at, checked_at, approved_at').in('id', [...new Set(rAllocs.map((a) => String(a.receipt_id)))]), c)
      : Promise.resolve({ data: [], error: null }),
    nAllocs.length > 0
      ? scopeToCompany(sb.from('acc_credit_notes').select('id, note_number, note_date, status, kind, reason').in('id', [...new Set(nAllocs.map((a) => String(a.note_id)))]), c)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (receiptRows.error) return c.json({ error: 'load_failed', reason: receiptRows.error.message }, 500);
  if (noteRows.error) return c.json({ error: 'load_failed', reason: noteRows.error.message }, 500);
  const receiptById = new Map(((receiptRows.data ?? []) as Row[]).map((r) => [String(r.id), r]));
  const noteById = new Map(((noteRows.data ?? []) as Row[]).map((n) => [String(n.id), n]));
  return c.json({
    bill: { ...bill, lines: lines.data ?? [] },
    debtor: debtor.data ?? null,
    receipts: rAllocs.flatMap((a) => {
      const r = receiptById.get(String(a.receipt_id));
      return r ? [{
        id: String(r.id), number: String(r.receipt_number ?? ''), date: r.receipt_date ?? null, status: String(r.status ?? ''),
        submittedAt: r.submitted_at ?? null, checkedAt: r.checked_at ?? null, approvedAt: r.approved_at ?? null, amountSen: Number(a.amount_sen ?? 0),
      }] : [];
    }),
    creditNotes: nAllocs.flatMap((a) => {
      const n = noteById.get(String(a.note_id));
      return n ? [{
        id: String(n.id), number: String(n.note_number ?? ''), date: n.note_date ?? null, status: String(n.status ?? ''), reason: n.reason ?? null,
        amountSen: Number(a.amount_sen ?? 0), appliedSen: Number(a.applied_sen ?? 0),
      }] : [];
    }),
  });
};

/* ── GET /sales/:siId/credit-notes — the credit notes on a sales invoice ─────
   Its page's Credit notes (batch 5 §8): the customers' credit notes knocked off
   it (owner 2026-11-03: 「要」; si-credit-notes.ts), and the notes that closed
   its order's deposit invoices at this final invoice — not knock-offs (the
   order's deposit already lowers the invoice; they are not counted twice), so
   each says which deposit invoice it closed. Posted notes only. */
export const arSalesInvoiceCreditNotesHandler = async (c: any): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const siId = c.req.param('siId');
  const { data: si, error } = await scopeToCompany(sb.from('sales_invoices').select('id').eq('id', siId), c).maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!si) return c.json({ error: 'not_found', message: 'That sales invoice is not in the company you are working in.' }, 404);
  const [allocs, named] = await Promise.all([
    scopeToCompany(sb.from('acc_credit_note_allocations').select('note_id, applied_sen').eq('sales_invoice_id', siId), c),
    scopeToCompany(sb.from('acc_credit_notes').select('id').eq('kind', 'CN').eq('sales_invoice_id', siId).eq('status', 'POSTED'), c),
  ]);
  if (allocs.error) return c.json({ error: 'load_failed', reason: allocs.error.message }, 500);
  if (named.error) return c.json({ error: 'load_failed', reason: named.error.message }, 500);
  const taken = ((allocs.data ?? []) as Row[]).filter((a) => Number(a.applied_sen ?? 0) > 0);
  const namedIds = ((named.data ?? []) as Row[]).map((n) => String(n.id));
  /* A note that names this invoice is its close-out only when a deposit invoice says so. */
  const closes = new Map<string, string>();
  if (namedIds.length > 0) {
    const { data: dis, error: diErr } = await scopeToCompany(sb.from('acc_deposit_invoices').select('di_number, credit_note_id').in('credit_note_id', namedIds), c);
    if (diErr) return c.json({ error: 'load_failed', reason: diErr.message }, 500);
    for (const d of (dis ?? []) as Row[]) closes.set(String(d.credit_note_id), String(d.di_number));
  }
  const ids = [...new Set([...taken.map((a) => String(a.note_id)), ...closes.keys()])];
  if (ids.length === 0) return c.json({ creditNotes: [] });
  const { data: notes, error: nErr } = await scopeToCompany(
    sb.from('acc_credit_notes').select('id, note_number, note_date, status, reason, total_sen').in('id', ids).eq('status', 'POSTED'), c,
  );
  if (nErr) return c.json({ error: 'load_failed', reason: nErr.message }, 500);
  const byId = new Map(((notes ?? []) as Row[]).map((n) => [String(n.id), n]));
  const row = (n: Row, what: string, amountSen: number, closesDeposit: boolean) => ({
    id: String(n.id), number: String(n.note_number ?? ''), date: n.note_date ?? null, what, amountSen, closesDeposit,
  });
  const creditNotes = [
    ...[...closes].flatMap(([id, di]) => { const n = byId.get(id); return n ? [row(n, `Closes deposit invoice ${di}`, Number(n.total_sen ?? 0), true)] : []; }),
    ...taken.flatMap((a) => { const n = byId.get(String(a.note_id)); return n ? [row(n, n.reason ? String(n.reason) : '—', Number(a.applied_sen), false)] : []; }),
  ].sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')) || a.number.localeCompare(b.number));
  return c.json({ creditNotes });
};

/* ── Router ───────────────────────────────────────────────────────────────── */

export const arInvoices = new Hono();
/* The SCM bridge is PER ROUTER (scm/index.ts mounts no global one): it stashes
   the real caller as houzsUser and hands out the service client. See
   docs/bugs/0648; tests/scmRouterBridge.test.ts pins it. */
arInvoices.use('*', supabaseAuth);
arInvoices.get('/', listArInvoicesHandler);
arInvoices.get('/bills/:billId', arBillDetailHandler);
arInvoices.get('/sales/:siId/credit-notes', arSalesInvoiceCreditNotesHandler);
