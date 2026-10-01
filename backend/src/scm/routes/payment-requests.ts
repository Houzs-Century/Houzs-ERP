// /payment-requests — 申请付款 (owner 2026-09-29/30: 3a a new document, 4a a new
// permission; Event 的 rental 要还的要相关负责人 upload，然后我 finance 这里负责做
// payment，慢慢接下来全部 payment 都会需要).
//
//   GET    /                    requests: a requester's own; Finance's all
//   GET    /event-options       the event picker, for a requester too
//   GET    /:id                 one request, its voucher and where it stands
//   POST   /                    raise a request (SUBMITTED)
//   PATCH  /:id                 the requester changes it — or sends a returned one again
//   POST   /:id/withdraw        the requester takes it back
//   POST   /:id/return          Finance sends it back, saying why
//   POST|GET /:id/files, GET|DELETE /:id/files/:fileId — the bill
//   POST   /read-bill, GET /bill-matches — the bill READ as it is attached
//                                (routes/payment-request-bill.ts)
//
// The bill (owner 2026-10-01, item 1 → 做: 申请一定要有): a request keeps its
// last file, and Finance cannot answer one that has none. What the reader read
// off it — number, date, total, whether it is for an event — rides the request
// (bill_no, bill_date, bill_total_sen, event_bill); an event bill goes with its
// Event or the requester's reason why there is none; and every other live
// request, voucher or AP invoice carrying the same number and date is named on
// it (lib/bill-matches.ts — said out loud, never refused).
//
// Finance answers a request with a voucher raised on PV New (?fromRequest=), or
// with an AP invoice raised on AP Invoices (?fromRequest=, owner 2026-09-30
// 6.1); each create door links the two (lib/payment-request.ts). The stage the
// requester reads — Processing, Booked, Partly paid, Paid, Bank confirmed — is
// read off that document on every request, never stored here.
//
// NO area guard (scm/index.ts): a sales PIC has no SCM area, only the flat key
// scm.payment_request.create, which requireScmAccess admits for this prefix
// alone. Every handler checks the key or Finance's own (scm.payment_voucher.create)
// against the real caller, and a requester sees their own requests only.

import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { activeCompanySql, companyDocPrefix, requireActiveCompanyId, scopeToCompany } from '../lib/companyScope';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { docMonthTag, mintMonthlyDocNo } from '../lib/doc-no';
import { dateOrNull } from '../lib/date-coerce';
import { todayMyt } from '../lib/my-time';
import { assertAuditWritable, auditUnavailableBody, compactChanges, fieldChange, recordEntityAudit } from '../lib/entity-audit';
import { makeDocFileHandlers, type DocFilesSpec } from '../lib/doc-files';
import { companyHasEvents, parseEventId, unknownEventRefusal } from '../lib/event-tags';
import { eventBillRefusal, findBillMatches, readBillFacts, type BillMatch, type RequestBillFacts } from '../lib/bill-matches';
import { eventOptionsHandler } from './acc-events';
import { billMatchesHandler, readRequestBillHandler } from './payment-request-bill';
import {
  PAYMENT_REQUEST_KEY, bankConfirmedVoucherNumbers, callerUserId, isRequestFinance, liveAnswerOf, requestStage,
  requesterMayChange, type InvoiceFacts, type VoucherFacts,
} from '../lib/payment-request';

type Row = Record<string, any>;

export const paymentRequests = new Hono<{ Bindings: Env; Variables: Variables }>();
paymentRequests.use('*', supabaseAuth);

const COLS = 'id, company_id, request_no, requested_by, requested_by_name, payee_name, amount_sen, due_date, purpose, project_id, bank_name, bank_account_no, bank_account_name, status, pv_id, ap_invoice_id, finance_note, decided_by, decided_at, created_at, updated_at, bill_no, bill_date, bill_total_sen, event_bill, no_event_reason';
const NO_PERM = { error: "You don't have permission to do that." };

const mayRequest = (c: any): boolean => hasHouzsPerm(c, PAYMENT_REQUEST_KEY);
const mayOpen = (c: any): boolean => mayRequest(c) || isRequestFinance(c);

const text = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s : null;
};

/** The request under the active company that the caller may see — the
    requester's own, or any for Finance — else a 404 that names nothing. */
async function loadVisible(c: any, id: string): Promise<{ req: Row } | { resp: Response }> {
  const sb = c.get('supabase');
  const { data, error } = await scopeToCompany(sb.from('acc_payment_requests').select(COLS).eq('id', id), c).maybeSingle();
  if (error) return { resp: c.json({ error: 'load_failed', reason: error.message }, 500) };
  const me = callerUserId(c);
  if (!data || (!isRequestFinance(c) && Number(data.requested_by) !== me)) {
    return { resp: c.json({ error: 'not_found', message: 'That payment request is not one you can open.' }, 404) };
  }
  return { req: data as Row };
}

/** Each request with its answering document's facts — the voucher's, or the
    AP invoice's and the AP Payments' that paid it — and the stage they say. */
async function withStages(c: any, companyId: number, rows: Row[]): Promise<{ rows: Row[] } | { resp: Response }> {
  const sb = c.get('supabase');
  const pvIds = [...new Set(rows.map((r) => r.pv_id).filter(Boolean))] as string[];
  let vouchers = new Map<string, VoucherFacts>();
  if (pvIds.length > 0) {
    const { data, error } = await sb.from('payment_vouchers').select('id, pv_number, status, approved_at, posted_at')
      .eq('company_id', companyId).in('id', pvIds);
    if (error) return { resp: c.json({ error: 'load_failed', reason: error.message }, 500) };
    vouchers = new Map(((data ?? []) as VoucherFacts[]).map((v) => [v.id, v]));
  }
  const invoiceIds = [...new Set(rows.map((r) => r.ap_invoice_id).filter(Boolean))] as string[];
  let invoices = new Map<string, InvoiceFacts>();
  /* An invoice's payers: the posted AP Payments with an allocation on it. */
  const payersOf = new Map<string, string[]>();
  if (invoiceIds.length > 0) {
    const { data, error } = await sb.from('ap_invoices').select('id, invoice_number, status, total_sen, paid_sen')
      .eq('company_id', companyId).in('id', invoiceIds);
    if (error) return { resp: c.json({ error: 'load_failed', reason: error.message }, 500) };
    invoices = new Map(((data ?? []) as InvoiceFacts[]).map((v) => [v.id, v]));
    const { data: allocs, error: aErr } = await sb.from('pv_allocations').select('pv_id, ap_invoice_id')
      .eq('company_id', companyId).in('ap_invoice_id', invoiceIds);
    if (aErr) return { resp: c.json({ error: 'load_failed', reason: aErr.message }, 500) };
    const payerIds = [...new Set(((allocs ?? []) as Row[]).map((a) => String(a.pv_id)))];
    if (payerIds.length > 0) {
      const { data: payers, error: pErr } = await sb.from('payment_vouchers').select('id, pv_number, status')
        .eq('company_id', companyId).in('id', payerIds);
      if (pErr) return { resp: c.json({ error: 'load_failed', reason: pErr.message }, 500) };
      const postedNo = new Map(((payers ?? []) as Row[]).filter((p) => p.status === 'POSTED' && p.pv_number).map((p) => [String(p.id), String(p.pv_number)]));
      for (const a of (allocs ?? []) as Row[]) {
        const no = postedNo.get(String(a.pv_id));
        if (!no) continue;
        const list = payersOf.get(String(a.ap_invoice_id)) ?? [];
        if (!list.includes(no)) list.push(no);
        payersOf.set(String(a.ap_invoice_id), list);
      }
    }
  }
  const postedNos = [
    ...[...vouchers.values()].filter((v) => v.status === 'POSTED' && v.pv_number).map((v) => String(v.pv_number)),
    ...[...payersOf.values()].flat(),
  ];
  const bank = await bankConfirmedVoucherNumbers(sb, companyId, postedNos);
  if (!bank.ok) return { resp: c.json({ error: 'load_failed', reason: bank.reason }, 500) };
  return {
    rows: rows.map((r) => {
      const inv = r.ap_invoice_id ? invoices.get(String(r.ap_invoice_id)) ?? null : null;
      if (inv) {
        const payers = payersOf.get(inv.id) ?? [];
        /* Bank-confirmed once EVERY AP Payment that paid it is on a statement. */
        const confirmed = payers.length > 0 && payers.every((no) => bank.confirmed.has(no));
        return {
          ...r,
          stage: requestStage(String(r.status), null, confirmed, inv),
          voucher: null,
          invoice: {
            id: inv.id, invoiceNumber: inv.invoice_number, status: inv.status,
            totalSen: Number(inv.total_sen ?? 0), paidSen: Number(inv.paid_sen ?? 0), paidBy: payers, bankConfirmed: confirmed,
          },
        };
      }
      const pv = r.pv_id ? vouchers.get(String(r.pv_id)) ?? null : null;
      const confirmed = !!pv?.pv_number && bank.confirmed.has(String(pv.pv_number));
      return {
        ...r,
        stage: requestStage(String(r.status), pv, confirmed),
        voucher: pv ? { id: pv.id, pvNumber: pv.pv_number, status: pv.status, approvedAt: pv.approved_at, postedAt: pv.posted_at, bankConfirmed: confirmed } : null,
        invoice: null,
      };
    }),
  };
}

/** Each request with the OTHER live documents carrying its bill's number and
    date (lib/bill-matches.ts) — said out loud on the list and on the request,
    never refused. A request is never a match of its own answer. */
async function withBillMatches(c: any, companyId: number, rows: Row[]): Promise<{ rows: Row[] } | { resp: Response }> {
  const found = await findBillMatches(c.get('supabase'), companyId, rows.map((r) => ({
    key: String(r.id), billNo: r.bill_no, billDate: r.bill_date,
    exclude: { requestIds: [String(r.id)], pvIds: [r.pv_id], apInvoiceIds: [r.ap_invoice_id] },
  })));
  if (!found.ok) return { resp: c.json({ error: 'load_failed', reason: found.reason }, 500) };
  return { rows: rows.map((r) => ({ ...r, billMatches: found.matches.get(String(r.id)) ?? ([] as BillMatch[]) })) };
}

/** Whether the company runs events (2990 does not): the form hides the Event
    field without them. Unreadable reads as "yes" — a field shown in vain beats
    one hidden from a company that needs it. */
async function hasEventsOf(c: any): Promise<boolean> {
  try { return await companyHasEvents(c.env.DB, activeCompanySql(c, 'p.company_id')); } catch { return true; }
}

/* ── GET / ─────────────────────────────────────────────────────────────────── */
export const listPaymentRequestsHandler = async (c: any): Promise<Response> => {
  if (!mayOpen(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const finance = isRequestFinance(c);
  const me = callerUserId(c);
  if (!finance && me == null) return c.json(NO_PERM, 403);
  const sb = c.get('supabase');
  let q = scopeToCompany(sb.from('acc_payment_requests').select(COLS), c);
  if (!finance || c.req.query('mine') === '1') q = q.eq('requested_by', me);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(500);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const staged = await withStages(c, co.companyId, (data ?? []) as Row[]);
  if ('resp' in staged) return staged.resp;
  const matched = await withBillMatches(c, co.companyId, staged.rows);
  if ('resp' in matched) return matched.resp;
  return c.json({ requests: matched.rows, finance, hasEvents: await hasEventsOf(c) });
};
paymentRequests.get('/', listPaymentRequestsHandler);

/* ── GET /event-options — the picker for a requester, who has no Finance area ── */
paymentRequests.get('/event-options', async (c) => {
  if (!mayOpen(c)) return c.json(NO_PERM, 403);
  return eventOptionsHandler(c);
});

/* ── The bill read as it is attached, and its matches (before GET /:id) ────── */
paymentRequests.post('/read-bill', readRequestBillHandler);
paymentRequests.get('/bill-matches', billMatchesHandler);

/* ── The bill — the factory's four handlers, fed this document's rules ────── */
export const PAYMENT_REQUEST_FILES: DocFilesSpec = {
  table: 'acc_payment_request_files',
  fkColumn: 'request_id',
  keyPrefix: 'payment-request-files',
  writePerms: [PAYMENT_REQUEST_KEY, 'scm.payment_voucher.create'],
  load: async (c: any) => {
    const found = await loadVisible(c, c.req.param('id'));
    if ('resp' in found) return found;
    const r = found.req;
    /* The bill stays once Finance has answered: its voucher carries a copy. */
    return { doc: { id: String(r.id), closed: r.status === 'WITHDRAWN', locked: r.status === 'VOUCHERED' } };
  },
  closedRefusal: { error: 'request_withdrawn', message: 'A withdrawn request takes no more files.' },
  lockedRefusal: { error: 'request_answered', message: 'Finance has answered this request — its bill stays.' },
  /* 申请一定要有 (owner 2026-10-01): the last file stays — a wrong bill is
     replaced by attaching the right one first. */
  keepOne: { error: 'bill_required', message: 'A request keeps its bill — attach the right file first, then remove this one.' },
};
const fileHandlers = makeDocFileHandlers(PAYMENT_REQUEST_FILES);
export const uploadPaymentRequestFileHandler = fileHandlers.upload;
export const listPaymentRequestFilesHandler = fileHandlers.list;
export const streamPaymentRequestFileHandler = fileHandlers.stream;
export const deletePaymentRequestFileHandler = fileHandlers.remove;
paymentRequests.post('/:id/files', uploadPaymentRequestFileHandler);
paymentRequests.get('/:id/files', listPaymentRequestFilesHandler);
paymentRequests.get('/:id/files/:fileId', streamPaymentRequestFileHandler);
paymentRequests.delete('/:id/files/:fileId', deletePaymentRequestFileHandler);

/* ── GET /:id ──────────────────────────────────────────────────────────────── */
export const getPaymentRequestHandler = async (c: any): Promise<Response> => {
  if (!mayOpen(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const found = await loadVisible(c, c.req.param('id'));
  if ('resp' in found) return found.resp;
  const staged = await withStages(c, co.companyId, [found.req]);
  if ('resp' in staged) return staged.resp;
  const matched = await withBillMatches(c, co.companyId, staged.rows);
  if ('resp' in matched) return matched.resp;
  return c.json({ request: matched.rows[0], finance: isRequestFinance(c) });
};
paymentRequests.get('/:id', getPaymentRequestHandler);

/* ── The requester's fields, as the body sends them ───────────────────────── */
type Fields = {
  payee_name: string; amount_sen: number; due_date: string | null; purpose: string;
  project_id: number | null; bank_name: string | null; bank_account_no: string | null; bank_account_name: string | null;
} & RequestBillFacts;
function readFields(body: Row): { fields: Fields } | { error: string; message: string } {
  const payee = text(body.payeeName);
  if (!payee) return { error: 'payee_required', message: 'Who is to be paid?' };
  const amount = Number(body.amountSen);
  if (!Number.isInteger(amount) || amount <= 0) return { error: 'amount_invalid', message: 'The amount must be more than zero.' };
  const purpose = text(body.purpose);
  if (!purpose) return { error: 'purpose_required', message: 'Say what the payment is for.' };
  const project = parseEventId(body.projectId);
  if (project === 'invalid') return { error: 'bad_event', message: 'projectId must be an event id.' };
  const bill = readBillFacts(body);
  if ('error' in bill) return bill;
  return {
    fields: {
      payee_name: payee, amount_sen: amount, due_date: dateOrNull(body.dueDate), purpose, project_id: project,
      bank_name: text(body.bankName), bank_account_no: text(body.bankAccountNo), bank_account_name: text(body.bankAccountName),
      ...bill.facts,
      /* With its Event picked, the reason why there is none is moot. */
      ...(project != null ? { no_event_reason: null } : {}),
    },
  };
}

/** An event bill goes to Finance with its Event, or with the requester's reason
    why there is none (lib/bill-matches.ts) — asked only of a company that runs
    events; anywhere else the flag is dropped. */
async function eventBillCheck(c: any, f: Fields): Promise<{ error: string; message: string } | null> {
  if (!f.event_bill) return null;
  if (!(await hasEventsOf(c))) { f.event_bill = false; return null; }
  return eventBillRefusal(f);
}

/* ── POST / ────────────────────────────────────────────────────────────────── */
export const createPaymentRequestHandler = async (c: any): Promise<Response> => {
  if (!mayOpen(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const me = callerUserId(c);
  if (me == null) return c.json({ error: 'no_user', message: 'Sign in again — the request needs to know who is asking.' }, 409);
  let body: Row;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const read = readFields(body);
  if ('error' in read) return c.json(read, 400);
  const eventErr = await unknownEventRefusal(c, [read.fields.project_id]);
  if (eventErr) return eventErr;
  const billErr = await eventBillCheck(c, read.fields);
  if (billErr) return c.json(billErr, 400);

  const sb = c.get('supabase');
  const pf = await assertAuditWritable(sb, { entityType: 'PAYMENT_REQUEST', action: 'CREATE', companyId: co.companyId });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);
  const requestNo = await mintMonthlyDocNo(sb, 'acc_payment_requests', 'request_no', `${companyDocPrefix(c)}PRQ-${docMonthTag(todayMyt())}`);
  const houzsUser = c.get('houzsUser') as { name?: string | null; email?: string | null } | undefined;
  const { data: row, error } = await sb.from('acc_payment_requests').insert({
    company_id: co.companyId,
    request_no: requestNo,
    requested_by: me,
    requested_by_name: houzsUser?.name ?? houzsUser?.email ?? null,
    ...read.fields,
    status: 'SUBMITTED',
  }).select(COLS).single();
  if (error || !row) return c.json({ error: 'save_failed', reason: error?.message ?? 'insert returned nothing' }, 500);
  await recordEntityAudit(sb, {
    entityType: 'PAYMENT_REQUEST', entityId: String(row.id), entityDocNo: requestNo, action: 'CREATE',
    actor: c.get('houzsUser'), companyId: co.companyId, statusSnapshot: 'SUBMITTED',
    fieldChanges: compactChanges([fieldChange('payeeName', null, read.fields.payee_name), fieldChange('amountSen', null, read.fields.amount_sen), fieldChange('projectId', null, read.fields.project_id), fieldChange('billNo', null, read.fields.bill_no)]),
  });
  return c.json({ ok: true, request: { ...row, stage: 'SUBMITTED', voucher: null } }, 201);
};
paymentRequests.post('/', createPaymentRequestHandler);

/* ── PATCH /:id — the requester's change; a returned request goes back in ─── */
export const updatePaymentRequestHandler = async (c: any): Promise<Response> => {
  if (!mayOpen(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const found = await loadVisible(c, c.req.param('id'));
  if ('resp' in found) return found.resp;
  const before = found.req;
  if (Number(before.requested_by) !== callerUserId(c)) {
    return c.json({ error: 'not_yours', message: 'Only the person who asked can change a request — Finance returns it instead.' }, 403);
  }
  if (!requesterMayChange(String(before.status))) {
    return c.json({ error: 'request_locked', message: `${before.request_no} is ${before.status === 'WITHDRAWN' ? 'withdrawn' : 'answered by Finance'} — it can no longer change.` }, 409);
  }
  let body: Row;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const read = readFields({
    payeeName: body.payeeName ?? before.payee_name, amountSen: body.amountSen ?? before.amount_sen,
    dueDate: body.dueDate !== undefined ? body.dueDate : before.due_date, purpose: body.purpose ?? before.purpose,
    projectId: body.projectId !== undefined ? body.projectId : before.project_id,
    bankName: body.bankName !== undefined ? body.bankName : before.bank_name,
    bankAccountNo: body.bankAccountNo !== undefined ? body.bankAccountNo : before.bank_account_no,
    bankAccountName: body.bankAccountName !== undefined ? body.bankAccountName : before.bank_account_name,
    billNo: body.billNo !== undefined ? body.billNo : before.bill_no,
    billDate: body.billDate !== undefined ? body.billDate : before.bill_date,
    billTotalSen: body.billTotalSen !== undefined ? body.billTotalSen : before.bill_total_sen,
    eventBill: body.eventBill !== undefined ? body.eventBill : before.event_bill,
    noEventReason: body.noEventReason !== undefined ? body.noEventReason : before.no_event_reason,
  });
  if ('error' in read) return c.json(read, 400);
  const eventErr = await unknownEventRefusal(c, [read.fields.project_id]);
  if (eventErr) return eventErr;
  const billErr = await eventBillCheck(c, read.fields);
  if (billErr) return c.json(billErr, 400);
  const sb = c.get('supabase');
  const pf = await assertAuditWritable(sb, { entityType: 'PAYMENT_REQUEST', entityId: String(before.id), action: 'UPDATE', companyId: co.companyId });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);
  const resubmit = before.status === 'REJECTED';
  const { data: row, error } = await sb.from('acc_payment_requests')
    .update({ ...read.fields, ...(resubmit ? { status: 'SUBMITTED' } : {}), updated_at: new Date().toISOString() })
    .eq('company_id', co.companyId).eq('id', before.id).eq('status', String(before.status)).select(COLS).maybeSingle();
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  if (!row) return c.json({ error: 'request_moved', message: `${before.request_no} changed a moment ago — open it again.` }, 409);
  await recordEntityAudit(sb, {
    entityType: 'PAYMENT_REQUEST', entityId: String(before.id), entityDocNo: before.request_no, action: resubmit ? 'SUBMIT_FOR_APPROVAL' : 'UPDATE',
    actor: c.get('houzsUser'), companyId: co.companyId, statusSnapshot: String(row.status),
    fieldChanges: compactChanges((Object.keys(read.fields) as Array<keyof Fields>).map((k) => fieldChange(k, before[k] ?? null, read.fields[k] ?? null))),
  });
  const staged = await withStages(c, co.companyId, [row as Row]);
  if ('resp' in staged) return staged.resp;
  return c.json({ ok: true, request: staged.rows[0] });
};
paymentRequests.patch('/:id', updatePaymentRequestHandler);

/* ── POST /:id/withdraw ────────────────────────────────────────────────────── */
export const withdrawPaymentRequestHandler = async (c: any): Promise<Response> => {
  if (!mayOpen(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const found = await loadVisible(c, c.req.param('id'));
  if ('resp' in found) return found.resp;
  const r = found.req;
  if (Number(r.requested_by) !== callerUserId(c)) return c.json({ error: 'not_yours', message: 'Only the person who asked can withdraw a request.' }, 403);
  if (r.status === 'WITHDRAWN') return c.json({ ok: true, already: true });
  if (!requesterMayChange(String(r.status))) {
    return c.json({ error: 'request_answered', message: `Finance has answered ${r.request_no} with a voucher or AP invoice — ask Finance to cancel it instead.` }, 409);
  }
  const sb = c.get('supabase');
  const pf = await assertAuditWritable(sb, { entityType: 'PAYMENT_REQUEST', entityId: String(r.id), action: 'CANCEL', companyId: co.companyId });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);
  const { data: row, error } = await sb.from('acc_payment_requests').update({ status: 'WITHDRAWN', updated_at: new Date().toISOString() })
    .eq('company_id', co.companyId).eq('id', r.id).eq('status', String(r.status)).select('id').maybeSingle();
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  if (!row) return c.json({ error: 'request_moved', message: `${r.request_no} changed a moment ago — open it again.` }, 409);
  await recordEntityAudit(sb, {
    entityType: 'PAYMENT_REQUEST', entityId: String(r.id), entityDocNo: r.request_no, action: 'CANCEL',
    actor: c.get('houzsUser'), companyId: co.companyId, statusSnapshot: 'WITHDRAWN',
  });
  return c.json({ ok: true });
};
paymentRequests.post('/:id/withdraw', withdrawPaymentRequestHandler);

/* ── POST /:id/return — Finance sends it back, with the why ────────────────── */
export const returnPaymentRequestHandler = async (c: any): Promise<Response> => {
  if (!isRequestFinance(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: Row;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const note = text(body.note);
  if (!note) return c.json({ error: 'note_required', message: 'Say why it goes back — the requester reads it.' }, 400);
  const found = await loadVisible(c, c.req.param('id'));
  if ('resp' in found) return found.resp;
  const r = found.req;
  const sb = c.get('supabase');
  if (r.status === 'VOUCHERED') {
    const live = await liveAnswerOf(c, r);
    if ('resp' in live) return live.resp;
    if (live.answer) {
      return c.json({ error: 'request_has_voucher', message: `${r.request_no} is answered by ${live.answer.number} — cancel that ${live.answer.kind === 'PV' ? 'voucher' : 'AP invoice'} first.` }, 409);
    }
  } else if (r.status !== 'SUBMITTED') {
    return c.json({ error: 'request_closed', message: `${r.request_no} is ${String(r.status).toLowerCase()} — there is nothing to return.` }, 409);
  }
  const pf = await assertAuditWritable(sb, { entityType: 'PAYMENT_REQUEST', entityId: String(r.id), action: 'REJECT', companyId: co.companyId });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);
  const decider = String(c.get('houzsUser')?.name ?? c.get('houzsUser')?.email ?? '');
  const { data: row, error } = await sb.from('acc_payment_requests')
    .update({ status: 'REJECTED', finance_note: note, decided_by: decider, decided_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('company_id', co.companyId).eq('id', r.id).eq('status', String(r.status)).select('id').maybeSingle();
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  if (!row) return c.json({ error: 'request_moved', message: `${r.request_no} changed a moment ago — open it again.` }, 409);
  await recordEntityAudit(sb, {
    entityType: 'PAYMENT_REQUEST', entityId: String(r.id), entityDocNo: r.request_no, action: 'REJECT',
    actor: c.get('houzsUser'), companyId: co.companyId, statusSnapshot: 'REJECTED',
    fieldChanges: compactChanges([fieldChange('financeNote', r.finance_note ?? null, note)]),
  });
  return c.json({ ok: true });
};
paymentRequests.post('/:id/return', returnPaymentRequestHandler);
