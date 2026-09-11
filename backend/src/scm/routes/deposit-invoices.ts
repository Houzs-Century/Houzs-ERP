// ----------------------------------------------------------------------------
// Deposit invoices — /scm/deposit-invoices (owner 2026-09-12; docs/bugs/0828).
// The invoices themselves are BORN in acc/deposit-invoices.ts off the payment
// hook; this router is Finance's window on them: the list, one invoice with
// its payment, the per-company switch (on/off + start date), the backlog
// button (issue what the start date left behind), cancel with a reason, and
// post again for an invoice whose journal was refused at birth.
//
// Keys: the PV family, like the notes and receipts beside it — the switch,
// the backlog and a re-post on `scm.payment_voucher.post`; cancel on
// `.cancel`; reading needs the finance area alone.
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId, scopeToCompany } from '../lib/companyScope';
import { dateOrNull } from '../lib/date-coerce';
import { supabaseAuth } from '../middleware/auth';
import {
  DI_COLS, cancelDepositInvoice, issueMissingDepositInvoices, loadDepositInvoiceSettings, missingDepositInvoices,
  postDepositInvoice, saveDepositInvoiceSettings, type DepositInvoiceRow,
} from '../../acc/deposit-invoices';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;
type Row = Record<string, unknown>;

const NO_PERM = (what: string) => ({ error: `You don't have permission to ${what}.` });
const who = (c: Ctx): string => String((c.get('houzsUser') as { name?: string } | undefined)?.name ?? (c.get('user') as { id?: string } | undefined)?.id ?? '');

async function loadInvoice(c: Ctx, id: string): Promise<{ di: DepositInvoiceRow } | { resp: Response }> {
  const sb = c.get('supabase');
  const { data, error } = await scopeToCompany(sb.from('acc_deposit_invoices').select(DI_COLS).eq('id', id), c).maybeSingle();
  if (error) return { resp: c.json({ error: 'load_failed', reason: error.message }, 500) };
  if (!data) return { resp: c.json({ error: 'not_found', message: 'That deposit invoice is not in the company you are working in.' }, 404) };
  return { di: data as DepositInvoiceRow };
}

export const listDepositInvoicesHandler = async (c: Ctx): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const status = String(c.req.query('status') ?? '').trim().toUpperCase();
  const so = String(c.req.query('so') ?? '').trim();
  const sb = c.get('supabase');
  let q = sb.from('acc_deposit_invoices').select(DI_COLS).eq('company_id', co.companyId);
  if (status === 'ISSUED' || status === 'CANCELLED') q = q.eq('status', status);
  if (so) q = q.eq('so_doc_no', so);
  const { data, error } = await q.order('invoice_date', { ascending: false }).order('di_number', { ascending: false }).limit(500);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const rows = (Array.isArray(data) ? data : []) as Row[];
  const numbered = await withNoteNumbers(c, rows);
  if ('resp' in numbered) return numbered.resp;
  return c.json({ rows: numbered.rows });
};

/** The number of the credit note that closed each invoice (docs/bugs/0831),
    read once for the page — the row carries only the id. */
async function withNoteNumbers(c: Ctx, rows: Row[]): Promise<{ rows: Row[] } | { resp: Response }> {
  const ids = [...new Set(rows.map((r) => r.credit_note_id).filter((x): x is string => typeof x === 'string' && x !== ''))];
  const numberOf = new Map<string, string>();
  if (ids.length > 0) {
    const co = requireActiveCompanyId(c);
    if (!co.ok) return { resp: c.json(co.refusal, 409) };
    const { data, error } = await c.get('supabase').from('acc_credit_notes').select('id, note_number').eq('company_id', co.companyId).in('id', ids);
    if (error) return { resp: c.json({ error: 'load_failed', reason: error.message }, 500) };
    for (const n of (Array.isArray(data) ? data : []) as Array<{ id: string; note_number: string }>) numberOf.set(String(n.id), String(n.note_number));
  }
  return { rows: rows.map((r) => ({ ...r, credit_note_number: typeof r.credit_note_id === 'string' ? numberOf.get(r.credit_note_id) ?? null : null })) };
}

export const depositInvoiceDetailHandler = async (c: Ctx): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const found = await loadInvoice(c, String(c.req.param('id') ?? ''));
  if ('resp' in found) return found.resp;
  const sb = c.get('supabase');
  const { data: payment, error } = await scopeToCompany(sb.from('mfg_sales_order_payments')
    .select('id, paid_at, method, merchant_provider, online_type, amount_sen, is_deposit, collected_by')
    .eq('id', found.di.payment_id), c)
    .maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const numbered = await withNoteNumbers(c, [found.di as unknown as Row]);
  if ('resp' in numbered) return numbered.resp;
  return c.json({ invoice: numbered.rows[0], payment: (payment as Row | null) ?? null });
};

/** The switch, and how many payments since the start still have no invoice. */
export const depositInvoiceSettingsHandler = async (c: Ctx): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const st = await loadDepositInvoiceSettings(sb, co.companyId);
  if (!st.ok) return c.json({ error: 'load_failed', reason: st.reason }, 500);
  const missing = await missingDepositInvoices(sb, co.companyId);
  if (!missing.ok) return c.json({ error: 'load_failed', reason: missing.reason }, 500);
  return c.json({ settings: st.settings, missingCount: missing.payments.length });
};

export const saveDepositInvoiceSettingsHandler = async (c: Ctx): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  if (!hasHouzsPerm(c, 'scm.payment_voucher.post')) return c.json(NO_PERM('change the deposit invoice switch'), 403);
  let body: { enabled?: unknown; fromDate?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (typeof body.enabled !== 'boolean') return c.json({ error: 'invalid_body', message: 'enabled must be true or false.' }, 400);
  /* The start is a calendar DAY — a payment's paid_at is compared to it as
     text, so anything but YYYY-MM-DD would compare wrongly and silently. */
  const fromDate = dateOrNull(body.fromDate);
  if (fromDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) return c.json({ error: 'bad_from_date', message: 'The start date must be a calendar day (YYYY-MM-DD).' }, 400);
  if (body.enabled && fromDate == null) return c.json({ error: 'from_date_required', message: 'Pick the day deposit invoices start from before switching them on.' }, 400);
  const sb = c.get('supabase');
  const saved = await saveDepositInvoiceSettings(sb, co.companyId, { enabled: body.enabled, fromDate }, who(c));
  if (!saved.ok) return c.json({ error: 'save_failed', reason: saved.reason }, 500);
  const missing = await missingDepositInvoices(sb, co.companyId);
  return c.json({ ok: true, settings: { enabled: body.enabled, fromDate }, missingCount: missing.ok ? missing.payments.length : null });
};

export const issueMissingDepositInvoicesHandler = async (c: Ctx): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  if (!hasHouzsPerm(c, 'scm.payment_voucher.post')) return c.json(NO_PERM('issue deposit invoices'), 403);
  const r = await issueMissingDepositInvoices(c.get('supabase'), co.companyId, who(c));
  if (!r.ok) return c.json({ error: 'issue_failed', reason: r.reason }, 500);
  return c.json({ ok: true, issued: r.issued, skipped: r.skipped });
};

export const cancelDepositInvoiceHandler = async (c: Ctx): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  if (!hasHouzsPerm(c, 'scm.payment_voucher.cancel')) return c.json(NO_PERM('cancel a deposit invoice'), 403);
  const found = await loadInvoice(c, String(c.req.param('id') ?? ''));
  if ('resp' in found) return found.resp;
  let body: { reason?: unknown };
  try { body = await c.req.json(); } catch { body = {}; }
  const reason = String(body.reason ?? '').trim();
  if (!reason) return c.json({ error: 'reason_required', message: 'Say why this deposit invoice is cancelled — it stays on file with the reason.' }, 400);
  const r = await cancelDepositInvoice(c.get('supabase'), { companyId: co.companyId, id: found.di.id, reason, actor: who(c) });
  if (!r.ok) return c.json({ error: 'cancel_failed', reason: r.reason }, r.status === 'not_found' ? 404 : 500);
  return c.json({ ok: true, status: r.status, contraJeNo: r.status === 'cancelled' ? r.contraJeNo : null });
};

/** Post again an invoice whose journal was refused at birth (the page shows
    it with no journal number). An already-posted invoice echoes. */
export const postDepositInvoiceHandler = async (c: Ctx): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  if (!hasHouzsPerm(c, 'scm.payment_voucher.post')) return c.json(NO_PERM('post to the general ledger'), 403);
  const found = await loadInvoice(c, String(c.req.param('id') ?? ''));
  if ('resp' in found) return found.resp;
  const di = found.di;
  if (di.status === 'CANCELLED') return c.json({ error: 'cancelled', message: `${di.di_number} is cancelled; a cancelled deposit invoice is not posted.` }, 409);
  const r = await postDepositInvoice(c.get('supabase'), {
    id: di.id, companyId: co.companyId, diNumber: di.di_number, soDocNo: di.so_doc_no,
    partyCode: di.party_code, partyName: di.party_name, amountSen: Number(di.amount_sen), invoiceDate: String(di.invoice_date).slice(0, 10),
  });
  if (!r.ok) return c.json({ error: 'post_failed', reason: r.reason }, 409);
  return c.json({ ok: true, jeNo: r.jeNo, status: r.status });
};

export const depositInvoices = new Hono<{ Bindings: Env; Variables: Variables }>();
depositInvoices.use('*', supabaseAuth);
depositInvoices.get('/', listDepositInvoicesHandler);
depositInvoices.get('/settings', depositInvoiceSettingsHandler);
depositInvoices.post('/settings', saveDepositInvoiceSettingsHandler);
depositInvoices.post('/issue-missing', issueMissingDepositInvoicesHandler);
depositInvoices.get('/:id', depositInvoiceDetailHandler);
depositInvoices.post('/:id/cancel', cancelDepositInvoiceHandler);
depositInvoices.post('/:id/post', postDepositInvoiceHandler);
