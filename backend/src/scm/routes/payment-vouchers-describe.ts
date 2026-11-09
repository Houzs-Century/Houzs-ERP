// ----------------------------------------------------------------------------
// payment-vouchers-describe — what a voucher is FOR and the bank it pays into
// (owner 2026-11-08: 「每天要过账的listing，就算pv号码，名字，description, purpose，
// 包含bank account number」; 2026-11-09: 「对我来说 description 就是 purpose」,
// 「我只想显示单上的费用，不要像之前一样显示bill no. 等等」).
//
//   · the Description: what is paid for, as the bills say it, each once, in order —
//       1. an AP payment: the lines of the AP invoices it pays (an AutoCount opening
//          invoice is skipped: its line is the import's words, numbers only) and the
//          items of the goods invoices it pays;
//       2. else the voucher's own lines, less the lines the system writes (Settle n
//          invoice(s) / prepay / Internal transfer / Refund on …) and less the
//          numbers of the requests they were made from;
//       3. else what its payment requests ask for, without their numbers;
//       4. else the voucher's remark (notes) — a prepayment, a transfer.
//     Never the bill number or date: the bill has its own fields (bill_ref, bill_date).
//   · the bank: the voucher's own three fields (pay_to_*). A voucher made before
//     them reads the bank its request asked for (several requests: only when they
//     all ask for the same), else its supplier's (Supplier maintenance).
//
// Read only, company-scoped; a failed read fails the request.
// ----------------------------------------------------------------------------

import { scopeToCompany, type CompanyScopeCtx } from '../lib/companyScope';
import { paginateAll } from '../lib/paginate-all';

export type Described = {
  description_text: string;
  pay_bank: string | null;
  pay_account_no: string | null;
  pay_account_name: string | null;
};

/* The lines the system writes on a voucher (PaymentVoucherNew's AP payment and
   transfer lines, pv-refund.ts's refund line): they say how, not what for. */
const SYSTEM_LINE = /^(settle \d+ invoice\(s\)|prepay [\d.,]+|internal transfer\b|refund on )/i;
const isSystemLine = (d: string): boolean => SYSTEM_LINE.test(d);
/** A line made from a request starts with the request's number: what is paid for follows it. */
const withoutRequestNo = (d: string, requestNos: readonly string[]): string => {
  for (const no of requestNos) {
    if (no && d.toUpperCase().startsWith(no.toUpperCase())) return d.slice(no.length).replace(/^[\s:—–-]+/, '');
  }
  return d;
};
/** Each text once, trimmed and with its spaces closed, in the order first seen. */
const once = (texts: readonly unknown[]): string[] => {
  const out: string[] = [];
  for (const t of texts) {
    const s = String(t ?? '').replace(/\s+/g, ' ').trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
};
type Bank = { bank: string | null; accountNo: string | null; accountName: string | null };
type Rows = Array<Record<string, unknown>>;

const text = (v: unknown): string | null => {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
};
const bankOf = (r: Record<string, unknown> | null | undefined, bank: string, no: string, name: string): Bank =>
  ({ bank: text(r?.[bank]), accountNo: text(r?.[no]), accountName: text(r?.[name]) });
const anyOf = (b: Bank): boolean => Boolean(b.bank || b.accountNo || b.accountName);

/* The three fields as a voucher is given them (create), and as an edit changes them. */
const PAY_TO: Array<[string, string]> = [
  ['payToBankName', 'pay_to_bank_name'],
  ['payToAccountNo', 'pay_to_account_no'],
  ['payToAccountName', 'pay_to_account_name'],
];
export const payToFields = (body: Record<string, unknown>): Record<string, string | null> =>
  Object.fromEntries(PAY_TO.map(([key, col]) => [col, text(body[key])]));
export const payToUpdates = (body: Record<string, unknown>): Record<string, string | null> =>
  Object.fromEntries(PAY_TO.filter(([key]) => body[key] !== undefined).map(([key, col]) => [col, text(body[key])]));
export const PAY_TO_AUDIT_FIELDS: Array<[string, string]> = PAY_TO;

/** Each voucher's purpose and bank, by id. `rows` carry the header and the supplier embed. */
export async function describeVouchers(
  sb: any, c: CompanyScopeCtx, rows: Array<Record<string, unknown> & { id: string }>,
): Promise<{ ok: true; byId: Map<string, Described> } | { ok: false; reason: string }> {
  const byId = new Map<string, Described>();
  if (rows.length === 0) return { ok: true, byId };
  const ids = rows.map((r) => r.id);
  const requests: Rows = [];
  const lines: Rows = [];
  const allocations: Rows = [];
  /* A hundred vouchers a read, each read paged: a voucher may carry many lines. */
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const [rq, ln, al] = await Promise.all([
      paginateAll<Record<string, unknown>>((f, t) => scopeToCompany(sb.from('acc_payment_requests')
        .select('pv_id, request_no, purpose, bank_name, bank_account_no, bank_account_name'), c)
        .in('pv_id', batch).order('request_no').range(f, t)),
      paginateAll<Record<string, unknown>>((f, t) => scopeToCompany(sb.from('payment_voucher_lines')
        .select('pv_id, line_no, description'), c)
        .in('pv_id', batch).order('pv_id').order('line_no').range(f, t)),
      paginateAll<Record<string, unknown>>((f, t) => scopeToCompany(sb.from('pv_allocations')
        .select('pv_id, ap_invoice_id, pi_id, created_at'), c)
        .in('pv_id', batch).order('created_at').range(f, t)),
    ]);
    if (rq.error) return { ok: false, reason: `requests: ${rq.error.message}` };
    if (ln.error) return { ok: false, reason: `lines: ${ln.error.message}` };
    if (al.error) return { ok: false, reason: `allocations: ${al.error.message}` };
    requests.push(...(rq.data ?? []));
    lines.push(...(ln.data ?? []));
    allocations.push(...(al.data ?? []));
  }

  /* The invoices an AP payment pays: their lines (AP invoices, less the opening ones)
     and their items (goods invoices). */
  const idsOf = (key: string): string[] => once(allocations.map((a) => a[key]));
  const apIds = idsOf('ap_invoice_id');
  const piIds = idsOf('pi_id');
  const opening = new Set<string>();
  const apLines: Rows = [];
  const piItems: Rows = [];
  for (let i = 0; i < apIds.length; i += 100) {
    const batch = apIds.slice(i, i + 100);
    const [inv, il] = await Promise.all([
      paginateAll<Record<string, unknown>>((f, t) => scopeToCompany(sb.from('ap_invoices').select('id, opening'), c)
        .in('id', batch).order('id').range(f, t)),
      paginateAll<Record<string, unknown>>((f, t) => scopeToCompany(sb.from('ap_invoice_lines')
        .select('invoice_id, line_no, description'), c)
        .in('invoice_id', batch).order('invoice_id').order('line_no').range(f, t)),
    ]);
    if (inv.error) return { ok: false, reason: `AP invoices: ${inv.error.message}` };
    if (il.error) return { ok: false, reason: `AP invoice lines: ${il.error.message}` };
    for (const v of inv.data ?? []) if (v.opening === true) opening.add(String(v.id));
    apLines.push(...(il.data ?? []));
  }
  for (let i = 0; i < piIds.length; i += 100) {
    const batch = piIds.slice(i, i + 100);
    const it = await paginateAll<Record<string, unknown>>((f, t) => scopeToCompany(sb.from('purchase_invoice_items')
      .select('purchase_invoice_id, description, created_at'), c)
      .in('purchase_invoice_id', batch).order('purchase_invoice_id').order('created_at').range(f, t));
    if (it.error) return { ok: false, reason: `purchase invoice items: ${it.error.message}` };
    piItems.push(...(it.data ?? []));
  }

  const group = (list: Rows, key = 'pv_id') => {
    const out = new Map<string, Rows>();
    for (const r of list) out.set(String(r[key]), [...(out.get(String(r[key])) ?? []), r]);
    return out;
  };
  const requestsOf = group(requests);
  const linesOf = group([...lines].sort((a, b) => Number(a.line_no ?? 0) - Number(b.line_no ?? 0)));
  const allocationsOf = group(allocations);
  const apLinesOf = group([...apLines].sort((a, b) => Number(a.line_no ?? 0) - Number(b.line_no ?? 0)), 'invoice_id');
  const piItemsOf = group(piItems, 'purchase_invoice_id');

  for (const r of rows) {
    const asked = requestsOf.get(r.id) ?? [];
    const paid = allocationsOf.get(r.id) ?? [];
    const requestNos = asked.map((q) => String(q.request_no ?? ''));
    const billItems = once([
      ...once(paid.map((a) => a.ap_invoice_id)).filter((id) => !opening.has(id)).flatMap((id) => (apLinesOf.get(id) ?? []).map((l) => l.description)),
      ...once(paid.map((a) => a.pi_id)).flatMap((id) => (piItemsOf.get(id) ?? []).map((l) => l.description)),
    ]);
    const ownItems = once((linesOf.get(r.id) ?? []).map((l) => withoutRequestNo(String(l.description ?? '').trim(), requestNos)))
      .filter((d) => !isSystemLine(d));
    const asks = once(asked.map((q) => q.purpose));
    const description = [billItems, ownItems, asks, once([r.notes])].find((xs) => xs.length > 0)?.join('; ') ?? '';
    const own = bankOf(r, 'pay_to_bank_name', 'pay_to_account_no', 'pay_to_account_name');
    const banks = asked.map((q) => bankOf(q, 'bank_name', 'bank_account_no', 'bank_account_name')).filter(anyOf);
    const fromRequests = banks.length > 0 && banks.every((b) => JSON.stringify(b) === JSON.stringify(banks[0])) ? banks[0]! : null;
    const supplier = Array.isArray(r.supplier) ? r.supplier[0] : r.supplier;
    const fromSupplier = bankOf(supplier as Record<string, unknown> | null, 'bank_name', 'bank_account_no', 'bank_account_name');
    const pick = [own, fromRequests, fromSupplier].find((b): b is Bank => b != null && anyOf(b)) ?? { bank: null, accountNo: null, accountName: null };
    byId.set(r.id, { description_text: description, pay_bank: pick.bank, pay_account_no: pick.accountNo, pay_account_name: pick.accountName });
  }
  return { ok: true, byId };
}
