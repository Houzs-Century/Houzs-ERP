// ----------------------------------------------------------------------------
// refund-request — a Sales Order's refund, asked of Finance as a payment
// request (owner 2026-10-14: 「sales order 的 refund request 可以让他跑去 payment
// request，而不是直接去 draft pv 吗？因为我可能还会拒绝 … 同时也要确定他在申请人的
// payment request」 → A, 做).
//
// The order's Refund button (routes/so-money-routes.ts) no longer raises a
// Customer Refund voucher draft: it raises a REQUEST — the customer as the
// payee, the customer's bank, the reason, and the order it refunds
// (refund_source_type 'SO', refund_source_doc_no). The bank and the reason are
// required, a file is not (owner: 退款申请不一定要附件 … 一定要填顾客银行户口号码，
// 名字等等，原因也必填). It is the requester's own, whoever pressed the button: a
// salesperson holds no 申请付款 key, yet reads it on Payment Requests (their own
// only) and on the order's money panel.
//
// Finance answers it the way it answers any request, with one difference: the
// answer is a Customer Refund voucher on THAT order (lib/payment-request.ts
// paymentRequestLinkGuard refuses anything else). Finance's Return is the
// refusal: the money goes back to the order and the requester reads why. A
// refund request is never edited and takes no balance; withdrawn or returned,
// another is raised from the order.
//
// THE MONEY IT HOLDS. While a refund request WAITS — submitted, or answered by a
// voucher since cancelled — its amount is spoken for on the order, the way a
// refund voucher draft is (lib/so-money.ts ordersMoney, lib/pv-refund.ts
// loadRefundSource): neither a second refund nor a conversion can take it. Once
// a live voucher answers it, the voucher holds the money instead; returned or
// withdrawn, it holds nothing.
// ----------------------------------------------------------------------------

import { chunkIn } from './paginate-all';
import { mytDateOf, todayMyt } from './my-time';
import { companyDocPrefix } from './companyScope';
import { docMonthTag, mintMonthlyDocNo } from './doc-no';
import { assertAuditWritable, auditUnavailableBody, compactChanges, fieldChange, recordEntityAudit } from './entity-audit';
import { callerUserId } from './payment-request';

/* eslint-disable @typescript-eslint/no-explicit-any -- PostgREST client, untyped throughout the acc layer */
type Db = any;
type Row = Record<string, any>;

/** WAITING — Finance has not answered it (or cancelled the voucher that did):
    it holds its money. ANSWERED — a live refund voucher answers it; the voucher
    holds the money. RETURNED — Finance said no, with why; the money is back on
    the order. WITHDRAWN — the requester took it back. */
export type RefundRequestState = 'WAITING' | 'ANSWERED' | 'RETURNED' | 'WITHDRAWN';

export type MoneyRefundRequest = {
  id: string;
  requestNo: string;
  amountSen: number;
  state: RefundRequestState;
  /** Why the money goes back, as the requester said it. */
  reason: string;
  /** Finance's why, when it returned the request. */
  financeNote: string | null;
  requestedBy: string | null;
  requestedOn: string;
  /** The refund voucher answering it, while one stands. */
  pvNumber: string | null;
};

/** One request's state, from its stored status and whether a voucher that was
    not cancelled answers it — pure, so a test reads it without a database. */
export function refundRequestState(status: string, liveVoucher: boolean): RefundRequestState {
  if (status === 'WITHDRAWN') return 'WITHDRAWN';
  if (status === 'REJECTED') return 'RETURNED';
  if (status === 'VOUCHERED' && liveVoucher) return 'ANSWERED';
  return 'WAITING';
}

/** What the waiting ones hold. */
export const heldSen = (requests: readonly MoneyRefundRequest[]): number =>
  requests.filter((r) => r.state === 'WAITING').reduce((s, r) => s + r.amountSen, 0);

/**
 * The refund requests on these orders, oldest first, each with its state —
 * two batched reads whatever the number of orders. `excludeRequestId` leaves
 * one out: the request a refund voucher is being raised to answer, whose own
 * amount must not stand in its way.
 */
export async function refundRequestsOn(
  sb: Db, companyId: number, docNosRaw: readonly unknown[], excludeRequestId: string | null = null,
): Promise<{ ok: true; byDoc: Map<string, MoneyRefundRequest[]> } | { ok: false; reason: string }> {
  const byDoc = new Map<string, MoneyRefundRequest[]>();
  const docs = [...new Set(docNosRaw.map((d) => String(d ?? '').trim()).filter(Boolean))];
  if (docs.length === 0) return { ok: true, byDoc };
  const reqs = await chunkIn<Row>(docs, (batch, f, t) => sb.from('acc_payment_requests')
    .select('id, request_no, amount_sen, status, pv_id, purpose, finance_note, requested_by_name, created_at, refund_source_doc_no')
    .eq('company_id', companyId).in('refund_source_doc_no', batch)
    .order('created_at').order('id').range(f, t));
  if (reqs.error) return { ok: false, reason: reqs.error.message };
  const rows = reqs.data.filter((r) => String(r.id) !== excludeRequestId);
  const pvIds = [...new Set(rows.filter((r) => r.status === 'VOUCHERED' && r.pv_id).map((r) => String(r.pv_id)))];
  const vouchers = new Map<string, Row>();
  if (pvIds.length > 0) {
    const got = await chunkIn<Row>(pvIds, (batch, f, t) => sb.from('payment_vouchers')
      .select('id, pv_number, status').eq('company_id', companyId).in('id', batch).order('id').range(f, t));
    if (got.error) return { ok: false, reason: got.error.message };
    for (const v of got.data) vouchers.set(String(v.id), v);
  }
  for (const r of rows) {
    const pv = r.pv_id ? vouchers.get(String(r.pv_id)) ?? null : null;
    const live = pv != null && String(pv.status) !== 'CANCELLED';
    const doc = String(r.refund_source_doc_no);
    const list = byDoc.get(doc) ?? [];
    list.push({
      id: String(r.id), requestNo: String(r.request_no), amountSen: Number(r.amount_sen ?? 0),
      state: refundRequestState(String(r.status), live),
      reason: String(r.purpose ?? ''), financeNote: r.finance_note ?? null, requestedBy: r.requested_by_name ?? null,
      requestedOn: r.created_at ? mytDateOf(String(r.created_at)) : '',
      pvNumber: live ? (pv.pv_number ?? null) : null,
    });
    byDoc.set(doc, list);
  }
  return { ok: true, byDoc };
}

/* ── Raising one ──────────────────────────────────────────────────────────── */

/** The reason is a sentence or two to Finance, not a document. */
export const REFUND_REASON_MAX = 500;

export type RefundAsk = { amountSen: number; reason: string; bankName: string; bankAccountNo: string; bankAccountName: string };

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** What the Refund button sends, checked: an amount, the reason, and the
    customer's bank — the bank, the account number (its digits) and the name on
    the account. `note` is what an older screen sends for the reason. */
export function readRefundAsk(body: Row): { ok: true; ask: RefundAsk } | { ok: false; error: string; message: string } {
  const amountSen = Number(body.amountSen);
  if (!Number.isInteger(amountSen) || amountSen <= 0) return { ok: false, error: 'refund_amount_required', message: 'How much is refunded? An amount above zero, in sen.' };
  const reason = text(body.reason) || text(body.note);
  if (!reason) return { ok: false, error: 'refund_reason_required', message: 'Why does the money go back? Finance reads the reason before it approves.' };
  if (reason.length > REFUND_REASON_MAX) return { ok: false, error: 'refund_reason_too_long', message: `Keep the reason to ${REFUND_REASON_MAX} characters.` };
  const bankName = text(body.bankName);
  const bankAccountNo = text(body.bankAccountNo);
  const bankAccountName = text(body.bankAccountName);
  if (!bankName || !bankAccountNo || !bankAccountName) {
    return { ok: false, error: 'refund_bank_required', message: "Where does the money go? The customer's bank, account number and the name on the account." };
  }
  if ((bankAccountNo.match(/\d/g) ?? []).length < 6) {
    return { ok: false, error: 'refund_account_no_invalid', message: `${bankAccountNo} is not an account number — type its digits.` };
  }
  return { ok: true, ask: { amountSen, reason, bankName, bankAccountNo, bankAccountName } };
}

/**
 * The request itself: SUBMITTED, numbered on the company's PRQ series, the
 * caller as the requester, the customer as the payee. The caller's own right to
 * the order was checked by the door (the order's guard); the amount against the
 * order's money by the caller of this.
 */
export async function raiseRefundRequest(
  c: any,
  p: { companyId: number; docNo: string; customerName: string | null; ask: RefundAsk },
): Promise<{ ok: true; request: Row } | { ok: false; status: 409 | 500; body: Record<string, unknown> }> {
  const me = callerUserId(c);
  if (me == null) return { ok: false, status: 409, body: { error: 'no_user', message: 'Sign in again — the request needs to know who is asking.' } };
  const sb = c.get('supabase');
  const pf = await assertAuditWritable(sb, { entityType: 'PAYMENT_REQUEST', action: 'CREATE', companyId: p.companyId });
  if (!pf.ok) return { ok: false, status: 409, body: auditUnavailableBody() };
  const requestNo = await mintMonthlyDocNo(sb, 'acc_payment_requests', 'request_no', `${companyDocPrefix(c)}PRQ-${docMonthTag(todayMyt())}`);
  const who = c.get('houzsUser') as { name?: string | null; email?: string | null } | undefined;
  const { data: row, error } = await sb.from('acc_payment_requests').insert({
    company_id: p.companyId,
    request_no: requestNo,
    requested_by: me,
    requested_by_name: who?.name ?? who?.email ?? null,
    payee_name: p.customerName?.trim() || p.docNo,
    amount_sen: p.ask.amountSen,
    purpose: p.ask.reason,
    bank_name: p.ask.bankName,
    bank_account_no: p.ask.bankAccountNo,
    bank_account_name: p.ask.bankAccountName,
    status: 'SUBMITTED',
    refund_source_type: 'SO',
    refund_source_doc_no: p.docNo,
  }).select('id, request_no, payee_name, amount_sen, purpose, status, refund_source_doc_no, created_at').single();
  if (error || !row) return { ok: false, status: 500, body: { error: 'save_failed', reason: error?.message ?? 'insert returned nothing' } };
  await recordEntityAudit(sb, {
    entityType: 'PAYMENT_REQUEST', entityId: String(row.id), entityDocNo: requestNo, action: 'CREATE',
    actor: c.get('houzsUser'), companyId: p.companyId, statusSnapshot: 'SUBMITTED',
    fieldChanges: compactChanges([
      fieldChange('refundOf', null, p.docNo), fieldChange('payeeName', null, row.payee_name), fieldChange('amountSen', null, p.ask.amountSen),
    ]),
  });
  return { ok: true, request: row as Row };
}
