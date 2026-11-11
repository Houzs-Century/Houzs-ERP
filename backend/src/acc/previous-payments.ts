// ----------------------------------------------------------------------------
// previous-payments — a salesperson's payment record the owner has checked and
// marked as the previous system's (owner 2026-11-11: 我检查确定后，就直接说这个是
// 之前record，我哪里都不会take-in / 我说的是sales man 的收款记录（包括imported
// from autocount)).
//
// A marked payment shows up nowhere a reconciliation takes money in: not on
// Payments not matched yet, not in Merchant Recon's pools (its card payments
// not reported yet, a line's guesses, Find the sale, a QR line's Online pool),
// not in the Cash Flow's AutoCount line. It posts nothing and changes nothing on
// its order. The marks are scm.acc_previous_payment_records, a row a payment;
// Undo deletes the row. Payments not matched yet lists them as their own list —
// not Merchant Recon's or Bank Recon's Set aside, which hold report lines and
// statement lines (owner: 要分开，不然看不懂).
//
// What cannot be marked, each said in words:
//   • a payment a merchant report line holds (linked or matched) — release it
//     there first, or the line would point at a payment nobody can see;
//   • a payment whose entry counts in the books (dated on or after the books'
//     first day; any entry when the company's books have no first day) — that
//     money is in these books, not only in the previous system's.
// An entry dated before the books' first day is soft launch and never counts
// (acc/books-opening), so it does not stand in the way.
// ----------------------------------------------------------------------------

import { chunkIn, paginateAll } from '../scm/lib/paginate-all';
import { loadBooksOpening } from './books-opening';

export type PaymentSource = 'SOPAY' | 'SIPAY';
export type PaymentRef = { source: PaymentSource; id: string };
type Fail = { ok: false; reason: string };
type Rows = Array<Record<string, any>>;
type Sb = any; // eslint-disable-line @typescript-eslint/no-explicit-any -- PostgREST builders are chained structurally, as in paginate-all

export const TABLE = 'acc_previous_payment_records';
export const previousKey = (source: string, id: string): string => `${source}:${id}`;
const day = (v: unknown): string => String(v ?? '').slice(0, 10);

/** Every payment of the company marked a previous record, as `${source}:${id}`. Fails closed. */
export async function loadPreviousKeys(sb: Sb, companyId: number): Promise<{ ok: true; keys: Set<string> } | Fail> {
  const read = await paginateAll<Record<string, any>>((lo, hi) => sb.from(TABLE)
    .select('payment_source, payment_id').eq('company_id', companyId).order('id').range(lo, hi));
  if (read.error) return { ok: false, reason: `previous records: ${read.error.message}` };
  return { ok: true, keys: new Set((read.data ?? []).map((r) => previousKey(String(r.payment_source), String(r.payment_id)))) };
}

/** A filter for one payment table's rows: keeps those not marked a previous record. */
export const notPrevious = (keys: ReadonlySet<string>, source: PaymentSource) =>
  (r: { id?: unknown }): boolean => !keys.has(previousKey(source, String(r.id)));

/** Why a payment cannot be marked, in the words the screen shows. */
export type PreviousRefusal = PaymentRef & { docNo: string | null; reason: 'not_found' | 'merchant_line' | 'in_the_books'; message: string };

/** What decides a mark, per payment — pure, so a test reads the rule without a database. */
export function refusalOf(f: {
  found: boolean; docNo: string | null; merchantLine: boolean; bookedJeNo: string | null;
}): { reason: PreviousRefusal['reason']; message: string } | null {
  const doc = f.docNo ?? 'This payment';
  if (!f.found) return { reason: 'not_found', message: 'This payment is not on file for this company.' };
  if (f.merchantLine) {
    return { reason: 'merchant_line', message: `${doc}: a merchant report line holds it. Release it on Merchant Recon first.` };
  }
  if (f.bookedJeNo) {
    return { reason: 'in_the_books', message: `${doc}: its entry ${f.bookedJeNo} is in the books, so it is not only the previous system's.` };
  }
  return null;
}

type PaymentFacts = { docNo: string | null; paidOn: string; method: string; channel: string | null; amountSen: number; reference: string | null; customer: string | null };

/** The payments named, read from both tables, with the order's or invoice's customer. */
async function readPayments(sb: Sb, companyId: number, refs: readonly PaymentRef[]): Promise<{ ok: true; facts: Map<string, PaymentFacts> } | Fail> {
  const soIds = [...new Set(refs.filter((r) => r.source === 'SOPAY').map((r) => r.id))];
  const siIds = [...new Set(refs.filter((r) => r.source === 'SIPAY').map((r) => r.id))];
  const cols = 'id, paid_at, amount_sen, approval_code, method, merchant_provider, online_type';
  const [so, si] = await Promise.all([
    soIds.length === 0 ? { data: [] as Rows, error: null } : chunkIn<Record<string, any>>(soIds, (batch, lo, hi) => sb.from('mfg_sales_order_payments')
      .select(`${cols}, so_doc_no`).eq('company_id', companyId).in('id', batch).order('id').range(lo, hi)),
    siIds.length === 0 ? { data: [] as Rows, error: null } : chunkIn<Record<string, any>>(siIds, (batch, lo, hi) => sb.from('sales_invoice_payments')
      .select(`${cols}, sales_invoice_id`).eq('company_id', companyId).in('id', batch).order('id').range(lo, hi)),
  ]);
  if (so.error) return { ok: false, reason: `SO payments: ${so.error.message}` };
  if (si.error) return { ok: false, reason: `SI payments: ${si.error.message}` };

  const docs = [...new Set(so.data.map((r) => String(r.so_doc_no ?? '')).filter(Boolean))];
  const invoiceIds = [...new Set(si.data.map((r) => String(r.sales_invoice_id ?? '')).filter(Boolean))];
  const [orders, invoices] = await Promise.all([
    docs.length === 0 ? { data: [] as Rows, error: null } : chunkIn<Record<string, any>>(docs, (batch, lo, hi) => sb.from('mfg_sales_orders')
      .select('doc_no, debtor_name').eq('company_id', companyId).in('doc_no', batch).order('doc_no').range(lo, hi)),
    invoiceIds.length === 0 ? { data: [] as Rows, error: null } : chunkIn<Record<string, any>>(invoiceIds, (batch, lo, hi) => sb.from('sales_invoices')
      .select('id, invoice_number, debtor_name').eq('company_id', companyId).in('id', batch).order('id').range(lo, hi)),
  ]);
  if (orders.error) return { ok: false, reason: `orders: ${orders.error.message}` };
  if (invoices.error) return { ok: false, reason: `invoices: ${invoices.error.message}` };
  const customerOf = new Map(orders.data.map((o) => [String(o.doc_no), o.debtor_name == null ? null : String(o.debtor_name)]));
  const invoiceOf = new Map(invoices.data.map((i) => [String(i.id), i]));

  const facts = new Map<string, PaymentFacts>();
  const base = (r: Record<string, any>) => {
    const method = String(r.method ?? '');
    const card = method === 'merchant' || method === 'installment';
    return {
      paidOn: day(r.paid_at), method,
      channel: (card ? r.merchant_provider : r.online_type) == null ? null : String(card ? r.merchant_provider : r.online_type).trim() || null,
      amountSen: Number(r.amount_sen ?? 0),
      reference: r.approval_code == null || String(r.approval_code).trim() === '' ? null : String(r.approval_code),
    };
  };
  for (const r of so.data) {
    const doc = String(r.so_doc_no ?? '') || null;
    facts.set(previousKey('SOPAY', String(r.id)), { ...base(r), docNo: doc, customer: doc ? customerOf.get(doc) ?? null : null });
  }
  for (const r of si.data) {
    const inv = invoiceOf.get(String(r.sales_invoice_id ?? ''));
    facts.set(previousKey('SIPAY', String(r.id)), {
      ...base(r), docNo: inv?.invoice_number == null ? null : String(inv.invoice_number), customer: inv?.debtor_name == null ? null : String(inv.debtor_name),
    });
  }
  return { ok: true, facts };
}

/** Mark the payments a previous record — those the rule allows; the rest come back refused, each in words. */
export async function markPrevious(sb: Sb, companyId: number, refs: readonly PaymentRef[], by: string | null): Promise<{
  ok: true; marked: PaymentRef[]; refused: PreviousRefusal[];
} | Fail> {
  const payments = await readPayments(sb, companyId, refs);
  if (!payments.ok) return payments;
  const ids = [...new Set(refs.map((r) => r.id))];

  /* A merchant report line holding it, matched or only linked. */
  const links = await chunkIn<Record<string, any>>(ids, (batch, lo, hi) => sb.from('acc_settlement_matches')
    .select('payment_source, payment_id').eq('company_id', companyId).in('payment_id', batch).order('payment_id').range(lo, hi));
  if (links.error) return { ok: false, reason: `merchant links: ${links.error.message}` };
  const linked = new Set(links.data.map((l) => previousKey(String(l.payment_source), String(l.payment_id))));

  /* Its live entry, and whether the books count it: on or after their first day, or always when they have none. */
  const opening = await loadBooksOpening(sb, companyId);
  if (!opening.ok) return opening;
  const start = opening.opening?.booksStart ?? null;
  const entries = await chunkIn<Record<string, any>>(ids, (batch, lo, hi) => sb.from('journal_entries')
    .select('je_no, source_type, source_doc_no, entry_date, reversed')
    .eq('company_id', companyId).in('source_type', ['SOPAY', 'SIPAY']).in('source_doc_no', batch)
    .eq('posted', true).order('je_no').range(lo, hi));
  if (entries.error) return { ok: false, reason: `entries: ${entries.error.message}` };
  const booked = new Map<string, string>();
  /* `reversed` is read here, not filtered in the query (it is absent on a fresh fake row; acc/payment-reconciled). */
  for (const e of entries.data) {
    if (e.reversed) continue;
    if (start != null && day(e.entry_date) < start) continue;
    const key = previousKey(String(e.source_type), String(e.source_doc_no));
    if (!booked.has(key)) booked.set(key, String(e.je_no));
  }

  const marked: PaymentRef[] = [];
  const refused: PreviousRefusal[] = [];
  const seen = new Set<string>();
  for (const r of refs) {
    const key = previousKey(r.source, r.id);
    if (seen.has(key)) continue;
    seen.add(key);
    const f = payments.facts.get(key);
    const no = refusalOf({ found: f != null, docNo: f?.docNo ?? null, merchantLine: linked.has(key), bookedJeNo: booked.get(key) ?? null });
    if (no) refused.push({ ...r, docNo: f?.docNo ?? null, ...no });
    else marked.push(r);
  }
  /* Already marked is marked: a second press writes nothing. */
  const had = await marksAmong(sb, companyId, marked);
  if (!had.ok) return had;
  const fresh = marked.filter((r) => !had.keys.has(previousKey(r.source, r.id)));
  for (let i = 0; i < fresh.length; i += 200) {
    const { error } = await sb.from(TABLE).insert(fresh.slice(i, i + 200)
      .map((r) => ({ company_id: companyId, payment_source: r.source, payment_id: r.id, marked_by: by })));
    if (error) return { ok: false, reason: `marking: ${error.message}` };
  }
  return { ok: true, marked, refused };
}

/** Which of these payments carry a mark already. */
async function marksAmong(sb: Sb, companyId: number, refs: readonly PaymentRef[]): Promise<{ ok: true; keys: Set<string> } | Fail> {
  const ids = [...new Set(refs.map((r) => r.id))];
  if (ids.length === 0) return { ok: true, keys: new Set() };
  const read = await chunkIn<Record<string, any>>(ids, (batch, lo, hi) => sb.from(TABLE)
    .select('payment_source, payment_id').eq('company_id', companyId).in('payment_id', batch).order('payment_id').range(lo, hi));
  if (read.error) return { ok: false, reason: `previous records: ${read.error.message}` };
  return { ok: true, keys: new Set(read.data.map((r) => previousKey(String(r.payment_source), String(r.payment_id)))) };
}

/** Put the payments back: each shows up again wherever it did before. */
export async function undoPrevious(sb: Sb, companyId: number, refs: readonly PaymentRef[]): Promise<{ ok: true; undone: number } | Fail> {
  const had = await marksAmong(sb, companyId, refs);
  if (!had.ok) return had;
  const wanted = refs.filter((r) => had.keys.has(previousKey(r.source, r.id)));
  for (const source of ['SOPAY', 'SIPAY'] as const) {
    const ids = [...new Set(wanted.filter((r) => r.source === source).map((r) => r.id))];
    for (let i = 0; i < ids.length; i += 200) {
      const { error } = await sb.from(TABLE).delete()
        .eq('company_id', companyId).eq('payment_source', source).in('payment_id', ids.slice(i, i + 200));
      if (error) return { ok: false, reason: `undo: ${error.message}` };
    }
  }
  return { ok: true, undone: new Set(wanted.map((r) => previousKey(r.source, r.id))).size };
}

/** One marked payment as the list shows it. */
export type PreviousRow = PaymentRef & PaymentFacts & { markedBy: string | null; markedAt: string };

/** Every marked payment of the company, the last marked first. */
export async function listPrevious(sb: Sb, companyId: number): Promise<{ ok: true; rows: PreviousRow[] } | Fail> {
  const read = await paginateAll<Record<string, any>>((lo, hi) => sb.from(TABLE)
    .select('payment_source, payment_id, marked_by, marked_at').eq('company_id', companyId).order('id').range(lo, hi));
  if (read.error) return { ok: false, reason: `previous records: ${read.error.message}` };
  const marks = read.data ?? [];
  const refs: PaymentRef[] = marks.map((m) => ({ source: String(m.payment_source) as PaymentSource, id: String(m.payment_id) }));
  const payments = await readPayments(sb, companyId, refs);
  if (!payments.ok) return payments;
  const rows: PreviousRow[] = [];
  for (const m of marks) {
    const ref = { source: String(m.payment_source) as PaymentSource, id: String(m.payment_id) };
    const f = payments.facts.get(previousKey(ref.source, ref.id));
    /* A payment deleted since it was marked has nothing to show; its mark is harmless. */
    if (!f) continue;
    rows.push({ ...ref, ...f, markedBy: m.marked_by == null ? null : String(m.marked_by), markedAt: String(m.marked_at ?? '') });
  }
  return { ok: true, rows: rows.sort((a, b) => b.markedAt.localeCompare(a.markedAt) || (a.docNo ?? '').localeCompare(b.docNo ?? '')) };
}
