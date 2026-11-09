// ----------------------------------------------------------------------------
// payment-vouchers-describe — what a voucher is FOR and the bank it pays into
// (owner 2026-11-08: 「pv notes 我不想要全部挤在一排，然后把notes 换成description」,
// 「每天要过账的listing，就算pv号码，名字，description, purpose，包含bank account
// number」, 「purpose 可以」).
//
//   · purpose: the payment requests the voucher answers, each by its number and
//     purpose; else what its lines say, each once, in line order;
//   · the bank: the voucher's own three fields (pay_to_*). A voucher made before
//     them reads the bank its request asked for (several requests: only when they
//     all ask for the same), else its supplier's (Supplier maintenance).
//
// Read only, company-scoped; a failed read fails the request.
// ----------------------------------------------------------------------------

import { scopeToCompany, type CompanyScopeCtx } from '../lib/companyScope';
import { paginateAll } from '../lib/paginate-all';

export type Described = {
  purpose_text: string;
  pay_bank: string | null;
  pay_account_no: string | null;
  pay_account_name: string | null;
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
  /* A hundred vouchers a read, each read paged: a voucher may carry many lines. */
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const [rq, ln] = await Promise.all([
      paginateAll<Record<string, unknown>>((f, t) => scopeToCompany(sb.from('acc_payment_requests')
        .select('pv_id, request_no, purpose, bank_name, bank_account_no, bank_account_name'), c)
        .in('pv_id', batch).order('request_no').range(f, t)),
      paginateAll<Record<string, unknown>>((f, t) => scopeToCompany(sb.from('payment_voucher_lines')
        .select('pv_id, line_no, description'), c)
        .in('pv_id', batch).order('pv_id').order('line_no').range(f, t)),
    ]);
    if (rq.error) return { ok: false, reason: `requests: ${rq.error.message}` };
    if (ln.error) return { ok: false, reason: `lines: ${ln.error.message}` };
    requests.push(...(rq.data ?? []));
    lines.push(...(ln.data ?? []));
  }
  const group = (list: Rows) => {
    const out = new Map<string, Rows>();
    for (const r of list) out.set(String(r.pv_id), [...(out.get(String(r.pv_id)) ?? []), r]);
    return out;
  };
  const requestsOf = group(requests);
  const linesOf = group([...lines].sort((a, b) => Number(a.line_no ?? 0) - Number(b.line_no ?? 0)));

  for (const r of rows) {
    const asked = requestsOf.get(r.id) ?? [];
    const purpose = asked.length > 0
      ? asked.map((q) => [text(q.request_no), text(q.purpose)].filter(Boolean).join(' ')).join('; ')
      : [...new Set((linesOf.get(r.id) ?? []).map((l) => text(l.description)).filter((d): d is string => d != null))].join('; ');
    const own = bankOf(r, 'pay_to_bank_name', 'pay_to_account_no', 'pay_to_account_name');
    const banks = asked.map((q) => bankOf(q, 'bank_name', 'bank_account_no', 'bank_account_name')).filter(anyOf);
    const fromRequests = banks.length > 0 && banks.every((b) => JSON.stringify(b) === JSON.stringify(banks[0])) ? banks[0]! : null;
    const supplier = Array.isArray(r.supplier) ? r.supplier[0] : r.supplier;
    const fromSupplier = bankOf(supplier as Record<string, unknown> | null, 'bank_name', 'bank_account_no', 'bank_account_name');
    const pick = [own, fromRequests, fromSupplier].find((b): b is Bank => b != null && anyOf(b)) ?? { bank: null, accountNo: null, accountName: null };
    byId.set(r.id, { purpose_text: purpose, pay_bank: pick.bank, pay_account_no: pick.accountNo, pay_account_name: pick.accountName });
  }
  return { ok: true, byId };
}
