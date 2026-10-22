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
//   GET /ar-invoices/bills/:billId    → { bill, debtor }  a debtor bill with its
//                                       lines and its debtor, for the pop-out
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
import { DEBTOR_PARTY_FIELDS } from './other-debtors';

type Row = Record<string, any>;

export type ArKind = 'SI' | 'ODB';
const KINDS = new Set(['ALL', 'SI', 'ODB']);

/* The sales invoices the Finance side sees beside the bills: the LIVE ones.
   A DRAFT has posted no revenue and a CANCELLED one is dead — the purchase
   invoice mirror on the AP list draws the same line (POSTED / PARTIALLY_PAID /
   PAID / ON_HOLD, never DRAFT or CANCELLED). */
export const SI_MIRROR_STATUSES = ['SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE'] as const;

const SI_COLS = 'id, invoice_number, so_doc_no, debtor_code, debtor_name, invoice_date, due_date, currency, total_sen, local_total_sen, paid_sen, status, notes';
const BILL_COLS = 'id, bill_number, debtor_id, bill_date, total_sen, received_sen, status, notes, created_at';
const DEBTOR_PARTY_COLS = DEBTOR_PARTY_FIELDS.map(([, col]) => col).join(', ');

/** One row of the list — a sales invoice (mirror) or a debtor bill; `kind` says which. */
export type ArListRow = {
  kind: ArKind;
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
  const code = r.debtor_code ? String(r.debtor_code) : null;
  const name = r.debtor_name ? String(r.debtor_name) : null;
  return {
    kind: 'SI',
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
    outstandingSen: Math.max(0, total - own - deposit),
    status: String(r.status ?? ''),
  };
}

function shapeBill(r: Row, debtorName: string | null): ArListRow {
  const total = Number(r.total_sen ?? 0);
  const received = Number(r.received_sen ?? 0);
  return {
    kind: 'ODB',
    id: String(r.id),
    invoiceNumber: String(r.bill_number ?? ''),
    partyKey: `D:${String(r.debtor_id ?? '')}`,
    partyCode: null,
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

  const rows: ArListRow[] = [];
  if (kind === 'ALL' || kind === 'ODB') {
    const { data, error } = await scopeToCompany(sb.from('acc_debtor_bills').select(BILL_COLS), c)
      .order('bill_date', { ascending: false }).limit(500);
    if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
    const bills = (data ?? []) as Row[];
    /* The debtor's name off the registry — read whole, never assumed: a bill
       whose debtor cannot be read prints "(debtor)", not the wrong name. */
    const names = new Map<string, string>();
    const ids = [...new Set(bills.map((b) => String(b.debtor_id ?? '')).filter(Boolean))];
    if (ids.length > 0) {
      const { data: debtors, error: dErr } = await scopeToCompany(sb.from('acc_debtors').select('id, name').in('id', ids), c);
      if (dErr) return c.json({ error: 'load_failed', reason: dErr.message }, 500);
      for (const d of (debtors ?? []) as Row[]) names.set(String(d.id), String(d.name ?? ''));
    }
    for (const b of bills) rows.push(shapeBill(b, names.get(String(b.debtor_id ?? '')) ?? null));
  }
  if (kind === 'ALL' || kind === 'SI') {
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
  const [lines, debtor] = await Promise.all([
    scopeToCompany(sb.from('acc_debtor_bill_lines').select('id, bill_id, line_no, description, credit_account_code, amount_sen, project_id').eq('bill_id', bill.id), c).order('line_no'),
    scopeToCompany(sb.from('acc_debtors').select(`id, name, phone, notes, is_active, ${DEBTOR_PARTY_COLS}`).eq('id', bill.debtor_id), c).maybeSingle(),
  ]);
  if (lines.error) return c.json({ error: 'load_failed', reason: lines.error.message }, 500);
  if (debtor.error) return c.json({ error: 'load_failed', reason: debtor.error.message }, 500);
  return c.json({ bill: { ...bill, lines: lines.data ?? [] }, debtor: debtor.data ?? null });
};

/* ── Router ───────────────────────────────────────────────────────────────── */

export const arInvoices = new Hono();
/* The SCM bridge is PER ROUTER (scm/index.ts mounts no global one): it stashes
   the real caller as houzsUser and hands out the service client. See
   docs/bugs/0648; tests/scmRouterBridge.test.ts pins it. */
arInvoices.use('*', supabaseAuth);
arInvoices.get('/', listArInvoicesHandler);
arInvoices.get('/bills/:billId', arBillDetailHandler);
