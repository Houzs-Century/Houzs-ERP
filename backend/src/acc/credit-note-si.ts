// ----------------------------------------------------------------------------
// credit-note-si — a CUSTOMER's credit note knocking off the customer's SALES
// INVOICES (owner 2026-11-03: 「要」 — his design, "like AutoCount"; batch 5 spec
// c6 / f2). The reads credit-note-allocations.ts hands a customer note to.
//
// It posts nothing and settles nothing into the invoice. An allocation row
// names the invoice (sales_invoice_id, migration 20261105T2000), applied_sen
// what it took, and the invoice's outstanding — its total, less its receipts,
// its order's deposit and the credit notes knocked off it — is read through
// scm/lib/si-credit-notes.ts and si-order-deposit.ts wherever it is shown.
// paid_sen is left alone: the overpayment rule reads it (customer-credits.ts).
// The invoice's status follows (recomputeSiPaid counts the credit), so one
// knocked off in full reads Paid like one its deposit settled.
//
// WHOSE INVOICES. A note's customer is its AR party — the code its journal
// carries (the debtor code, else the order's customer id: acc/payments.ts
// customerPartyCode) and the name. A customer id is one customer; a debtor code
// may not be — Houzs's cash debtor 300-C002 sits on 424 live invoices of 384
// names (production, 2026-11-03) — so a code that is not a customer id matches
// only WITH the name, and a note with no code matches invoices with no code by
// the name. An invoice's party is read the way its revenue posting reads it
// (scm/lib/post-si-revenue.ts), so a knock-off never crosses two AR parties.
//
// WHICH NOTES. A deposit paper knocks nothing off: the note that closed a
// deposit invoice at the final invoice (the order's deposit lowers that invoice
// — the note counted too would count it twice), a refund's note (that money
// went back to the customer) and a move's (it went to another order).
// ----------------------------------------------------------------------------

import { customerPartyCode } from './payments';
import { chunkIn, paginateAll } from '../scm/lib/paginate-all';
import { OPEN_SI_STATUSES } from '../scm/lib/open-invoice-states';
import { recomputeSiPaid, recomputeSiPaidForOrder, stampOrderDeposit } from '../scm/lib/si-order-deposit';
import { creditNotesOf } from '../scm/lib/si-credit-notes';

/* eslint-disable @typescript-eslint/no-explicit-any -- PostgREST client, untyped throughout the acc layer */
type Db = any;
type Row = Record<string, any>;
type Read<T> = { ok: true; value: T } | { ok: false; reason: string };

const log = (...args: unknown[]): void => {
  // eslint-disable-next-line no-console
  console.error('[acc/credit-note-si]', ...args);
};

/** A customer as an AR line names one: the party code and the name. */
export type CustomerKey = { code: string | null; name: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const codeOf = (v: unknown): string | null => {
  const t = String(v ?? '').trim();
  return t === '' ? null : t;
};
const nameOf = (v: unknown): string => String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/** The customer a stored note credits. */
export const customerOfNote = (note: Row): CustomerKey => ({ code: codeOf(note.party_code), name: note.party_name ?? null });

/** One customer: the same party code, and — unless that code is a customer id — the same name. */
export function sameCustomer(a: CustomerKey, b: CustomerKey): boolean {
  const code = codeOf(a.code);
  if (code !== codeOf(b.code)) return false;
  if (code !== null && UUID.test(code)) return true;
  const name = nameOf(a.name);
  return name !== '' && name === nameOf(b.name);
}

const SI_COLS = 'id, invoice_number, so_doc_no, debtor_code, debtor_name, invoice_date, total_sen, paid_sen, status';

/** One sales invoice as a knock-off reads it. */
export type SiOwing = {
  id: string; number: string; soDocNo: string | null; date: string | null; totalSen: number; status: string;
  customer: CustomerKey;
  /** What it still owes: its total less its receipts, its order's deposit and every credit note knocked off it. */
  owedSen: number;
};

/** The invoices' customers and what each still owes — the deposit and the credit
    notes as every screen reads them (stampOrderDeposit). Fails closed: a figure
    that could not be read is never taken as what the invoice owes. */
async function owing(sb: Db, companyId: number, rows: Row[]): Promise<Read<Map<string, SiOwing>>> {
  const out = new Map<string, SiOwing>();
  if (rows.length === 0) return { ok: true, value: out };
  const docs = [...new Set(rows.filter((r) => !codeOf(r.debtor_code) && r.so_doc_no).map((r) => String(r.so_doc_no)))];
  const orders = new Map<string, Row>();
  if (docs.length > 0) {
    const read = await chunkIn<Row>(docs, (batch, from, to) => sb.from('mfg_sales_orders')
      .select('doc_no, debtor_code, customer_id').eq('company_id', companyId).in('doc_no', batch).order('doc_no').range(from, to));
    if (read.error) return { ok: false, reason: `orders: ${read.error.message}` };
    for (const o of read.data) orders.set(String(o.doc_no), o);
  }
  const stamped = rows.map((r) => ({ ...r }));
  await stampOrderDeposit(sb, stamped, companyId);
  for (const r of stamped) {
    if (r.so_deposit_applied_sen == null || r.credit_notes_sen == null) {
      return { ok: false, reason: `the deposit or the credit notes of ${String(r.invoice_number ?? 'an invoice')} could not be read` };
    }
    const order = r.so_doc_no ? orders.get(String(r.so_doc_no)) : undefined;
    const total = Number(r.total_sen ?? 0);
    out.set(String(r.id), {
      id: String(r.id), number: String(r.invoice_number ?? ''), soDocNo: r.so_doc_no ?? null, date: r.invoice_date ?? null,
      totalSen: total, status: String(r.status ?? ''),
      customer: { code: codeOf(r.debtor_code) ?? customerPartyCode(order?.debtor_code, order?.customer_id), name: r.debtor_name ?? null },
      owedSen: Math.max(0, total - Number(r.paid_sen ?? 0) - Number(r.so_deposit_applied_sen) - creditNotesOf(r)),
    });
  }
  return { ok: true, value: out };
}

/** Sales invoices by id — this company's — with what each still owes. */
export async function sisOwing(sb: Db, companyId: number, ids: readonly string[]): Promise<Read<Map<string, SiOwing>>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return { ok: true, value: new Map() };
  const read = await chunkIn<Row>(unique, (batch, from, to) => sb.from('sales_invoices').select(SI_COLS)
    .eq('company_id', companyId).in('id', batch).order('id').range(from, to));
  if (read.error) return { ok: false, reason: read.error.message };
  return owing(sb, companyId, read.data);
}

/** The customer's invoices still owing something — what a credit note can knock off. */
export async function customerOpenInvoices(sb: Db, companyId: number, key: CustomerKey): Promise<Read<SiOwing[]>> {
  const code = codeOf(key.code);
  const open = [...OPEN_SI_STATUSES];
  let found: Row[];
  if (code !== null && UUID.test(code)) {
    /* A customer id lives on the orders (2990 keeps no debtor codes). */
    const orders = await paginateAll<Row>((from, to) => sb.from('mfg_sales_orders').select('doc_no')
      .eq('company_id', companyId).eq('customer_id', code).order('doc_no').range(from, to));
    if (orders.error) return { ok: false, reason: `orders: ${orders.error.message}` };
    const sis = await chunkIn<Row>((orders.data ?? []).map((o) => String(o.doc_no)), (batch, from, to) => sb.from('sales_invoices')
      .select(SI_COLS).eq('company_id', companyId).in('so_doc_no', batch).in('status', open).order('id').range(from, to));
    if (sis.error) return { ok: false, reason: sis.error.message };
    found = sis.data;
  } else {
    const name = nameOf(key.name);
    if (name === '') return { ok: true, value: [] };
    const sis = await paginateAll<Row>((from, to) => {
      const q = sb.from('sales_invoices').select(SI_COLS).eq('company_id', companyId).in('status', open);
      return (code === null ? q.is('debtor_code', null) : q.eq('debtor_code', code)).order('id').range(from, to);
    });
    if (sis.error) return { ok: false, reason: sis.error.message };
    found = (sis.data ?? []).filter((r) => nameOf(r.debtor_name) === name);
  }
  const owed = await owing(sb, companyId, found);
  if (!owed.ok) return owed;
  const value = [...owed.value.values()].filter((s) => s.owedSen > 0 && sameCustomer(key, s.customer));
  value.sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')) || a.number.localeCompare(b.number));
  return { ok: true, value };
}

/** Why a customer note answers a deposit invoice instead of crediting the customer. */
export type DepositPaper = { kind: 'closes' | 'refund' | 'move'; di: string | null };

/** The customer notes that answer a deposit invoice — a final invoice's
    close-out, a refund's, a move's — by note id. None of them knocks off. */
export async function depositPapers(sb: Db, companyId: number, notes: readonly Row[]): Promise<Read<Map<string, DepositPaper>>> {
  const out = new Map<string, DepositPaper>();
  const cns = notes.filter((n) => n.kind === 'CN');
  if (cns.length === 0) return { ok: true, value: out };
  const refs = [...new Set(cns.map((n) => codeOf(n.source_doc_no)).filter((s): s is string => s !== null))];
  const [linked, named] = await Promise.all([
    chunkIn<Row>(cns.map((n) => String(n.id)), (batch, from, to) => sb.from('acc_deposit_invoices')
      .select('id, di_number, credit_note_id').eq('company_id', companyId).in('credit_note_id', batch).order('id').range(from, to)),
    chunkIn<Row>(refs, (batch, from, to) => sb.from('acc_deposit_invoices')
      .select('id, di_number').eq('company_id', companyId).in('di_number', batch).order('id').range(from, to)),
  ]);
  if (linked.error) return { ok: false, reason: `deposit invoices: ${linked.error.message}` };
  if (named.error) return { ok: false, reason: `deposit invoices: ${named.error.message}` };
  const closes = new Map(linked.data.map((d) => [String(d.credit_note_id), String(d.di_number)]));
  const dis = new Set(named.data.map((d) => String(d.di_number)));
  for (const n of cns) {
    const ref = codeOf(n.source_doc_no);
    const di = closes.get(String(n.id)) ?? (ref !== null && dis.has(ref) ? ref : null);
    if (n.refund_pv_id) out.set(String(n.id), { kind: 'refund', di });
    else if (n.converted_payment_id) out.set(String(n.id), { kind: 'move', di });
    else if (di) out.set(String(n.id), { kind: 'closes', di });
  }
  return { ok: true, value: out };
}

/** Why a deposit paper is refused a knock-off, in the words the note page shows. */
export const depositPaperRefusal = (noteNo: string, paper: DepositPaper): string => {
  if (paper.kind === 'refund') return `${noteNo} takes back a deposit for a refund — that money went back to the customer, so it knocks nothing off.`;
  if (paper.kind === 'move') return `${noteNo} moved a deposit to another order — it knocks nothing off.`;
  return `${noteNo} closes deposit invoice ${paper.di ?? ''} at the final invoice — the order's deposit lowers that invoice, so the note knocks nothing off.`;
};

/** Each touched invoice's status rolled again, and its order's other invoices
    with it — their share of the deposit moves with the credit. Best effort:
    never throws, a stale status is rolled by the next payment. */
export async function refreshSiStatuses(sb: Db, companyId: number, siIds: readonly string[]): Promise<void> {
  const ids = [...new Set(siIds.filter(Boolean))];
  if (ids.length === 0) return;
  try {
    const { data, error } = await sb.from('sales_invoices').select('id, so_doc_no').eq('company_id', companyId).in('id', ids);
    if (error) { log('invoice read failed — statuses left as they were:', error.message); return; }
    const orders = new Set<string>();
    for (const r of (data ?? []) as Row[]) {
      if (r.so_doc_no) orders.add(String(r.so_doc_no));
      else await recomputeSiPaid(sb, String(r.id));
    }
    for (const doc of orders) await recomputeSiPaidForOrder(sb, doc, companyId);
  } catch (e) {
    log('status roll threw — statuses left as they were:', e);
  }
}

/** When a sales invoice is CANCELLED: the credit notes knocked off it get their
    credit back — a cancelled invoice owes nothing — and a draft's plan on it
    goes. Best effort, the cancel stands either way. */
export async function releaseSalesInvoiceKnockOffs(sb: Db, p: { companyId: number | null; siId: string }): Promise<void> {
  if (p.companyId == null) return;
  const { error } = await sb.from('acc_credit_note_allocations').delete().eq('company_id', p.companyId).eq('sales_invoice_id', p.siId);
  if (error) log(`knock-offs on cancelled invoice ${p.siId} not given back:`, error.message);
}
