// ----------------------------------------------------------------------------
// payment-request.ts — the rules of a payment request (申请付款, owner
// 2026-09-29/30: 3a a new document, 4a a new permission). The routes are
// routes/payment-requests.ts; the voucher link is here because the voucher's
// create door (createPaymentVoucherCore) calls it.
//
// A request is the requester's half: who to pay, how much, by when, for which
// event, what for, the payee's bank details, and the bill (its files). Finance
// answers with a payment voucher through the untouched Draft → Prepared →
// Checked → Approved cycle. What the requester reads is DERIVED from that
// voucher, never copied onto the request, so the two cannot disagree:
//   Submitted        waiting for Finance
//   Processing       Finance made voucher N, not yet approved
//   Paid             the voucher is approved (posted) — owner: 已付 at Approve
//   Bank confirmed   the voucher's bank line is matched on a statement
//   Returned         Finance sent it back, with the why; the requester may fix
//                    it and send it again
//   Withdrawn        the requester took it back before Finance acted
//   Voucher cancelled  the voucher was cancelled — Finance makes the next one
// ----------------------------------------------------------------------------

import { hasHouzsPerm } from './houzs-perms';
import { requireActiveCompanyId, scopeToCompany } from './companyScope';
import { chunkIn } from './paginate-all';

type Row = Record<string, any>;

export const PAYMENT_REQUEST_KEY = 'scm.payment_request.create';

export type StoredStatus = 'SUBMITTED' | 'VOUCHERED' | 'REJECTED' | 'WITHDRAWN';
export type RequestStage = 'SUBMITTED' | 'PROCESSING' | 'PAID' | 'BANK_CONFIRMED' | 'RETURNED' | 'WITHDRAWN' | 'VOUCHER_CANCELLED';

/** Finance, for a request: whoever may raise the voucher that answers it. */
export const isRequestFinance = (c: any): boolean => hasHouzsPerm(c, 'scm.payment_voucher.create');

/** The caller as a requester: the Houzs user id (public.users.id). */
export const callerUserId = (c: any): number | null => {
  const id = Number(c.get('houzsUser')?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
};

export type VoucherFacts = { id: string; pv_number: string | null; status: string | null; approved_at: string | null; posted_at: string | null };

/** What the requester reads, from the stored status and the voucher's own state. */
export function requestStage(status: string, pv: VoucherFacts | null, bankConfirmed: boolean): RequestStage {
  if (status === 'WITHDRAWN') return 'WITHDRAWN';
  if (status === 'REJECTED') return 'RETURNED';
  if (status !== 'VOUCHERED' || !pv) return 'SUBMITTED';
  if (pv.status === 'CANCELLED') return 'VOUCHER_CANCELLED';
  if (pv.status === 'POSTED') return bankConfirmed ? 'BANK_CONFIRMED' : 'PAID';
  return 'PROCESSING';
}

/** Who may edit / withdraw: the requester, while Finance has not answered. */
export const requesterMayChange = (status: string): boolean => status === 'SUBMITTED' || status === 'REJECTED';

/* ── The bank's confirmation of a voucher ─────────────────────────────────
   A voucher is confirmed when its live journal entry (source PV, its number)
   is matched to a bank-statement line that is POSTED — the read every bank
   reconciliation screen keeps (a match on a line that is not POSTED is nobody's
   claim). Returns the voucher numbers that are. */
export async function bankConfirmedVoucherNumbers(sb: any, companyId: number, pvNumbers: string[]): Promise<{ ok: true; confirmed: Set<string> } | { ok: false; reason: string }> {
  const confirmed = new Set<string>();
  const nos = [...new Set(pvNumbers.filter(Boolean))];
  if (nos.length === 0) return { ok: true, confirmed };
  const jes = await chunkIn<{ je_no: string; source_doc_no: string; reversed: boolean | null }>(nos, (batch, lo, hi) =>
    sb.from('journal_entries').select('je_no, source_doc_no, reversed')
      .eq('company_id', companyId).eq('source_type', 'PV').in('source_doc_no', batch).order('je_no').range(lo, hi));
  if (jes.error) return { ok: false, reason: jes.error.message };
  const pvOfJe = new Map(jes.data.filter((j) => !j.reversed).map((j) => [j.je_no, j.source_doc_no]));
  if (pvOfJe.size === 0) return { ok: true, confirmed };
  const matches = await chunkIn<{ je_no: string; bank_line_id: string }>([...pvOfJe.keys()], (batch, lo, hi) =>
    sb.from('acc_bank_statement_matches').select('je_no, bank_line_id')
      .eq('company_id', companyId).in('je_no', batch).order('bank_line_id').range(lo, hi));
  if (matches.error) return { ok: false, reason: matches.error.message };
  const lineIds = [...new Set(matches.data.map((m) => String(m.bank_line_id)))];
  if (lineIds.length === 0) return { ok: true, confirmed };
  const lines = await chunkIn<{ id: string; state: string }>(lineIds, (batch, lo, hi) =>
    sb.from('acc_bank_statement_lines').select('id, state')
      .eq('company_id', companyId).in('id', batch).order('id').range(lo, hi));
  if (lines.error) return { ok: false, reason: lines.error.message };
  const posted = new Set(lines.data.filter((l) => l.state === 'POSTED').map((l) => String(l.id)));
  for (const m of matches.data) {
    if (posted.has(String(m.bank_line_id))) {
      const pvNo = pvOfJe.get(m.je_no);
      if (pvNo) confirmed.add(pvNo);
    }
  }
  return { ok: true, confirmed };
}

/* ── The voucher answering a request ──────────────────────────────────────
   Called by createPaymentVoucherCore. BEFORE the voucher is written: the
   request must be this company's and still waiting — a request with a live
   voucher is refused by name, so one bill is never paid twice from here. A
   request whose voucher was cancelled may take the next one. */
export async function paymentRequestLinkGuard(c: any, rawId: unknown): Promise<{ request: Row | null } | { resp: Response }> {
  const id = typeof rawId === 'string' ? rawId.trim() : '';
  if (!id) return { request: null };
  const sb = c.get('supabase');
  const { data: req, error } = await scopeToCompany(sb.from('acc_payment_requests')
    .select('id, company_id, request_no, status, pv_id').eq('id', id), c).maybeSingle();
  if (error) return { resp: c.json({ error: 'load_failed', reason: error.message }, 500) };
  if (!req) return { resp: c.json({ error: 'request_not_found', message: 'That payment request is not in the company you are working in.' }, 404) };
  if (req.status === 'WITHDRAWN' || req.status === 'REJECTED') {
    return { resp: c.json({ error: 'request_closed', message: `${req.request_no} was ${req.status === 'WITHDRAWN' ? 'withdrawn by the requester' : 'returned to the requester'} — it takes no voucher until it is sent again.` }, 409) };
  }
  if (req.status === 'VOUCHERED' && req.pv_id) {
    const { data: pv, error: pvErr } = await scopeToCompany(sb.from('payment_vouchers').select('id, pv_number, status').eq('id', req.pv_id), c).maybeSingle();
    if (pvErr) return { resp: c.json({ error: 'load_failed', reason: pvErr.message }, 500) };
    if (pv && pv.status !== 'CANCELLED') {
      return { resp: c.json({ error: 'request_has_voucher', message: `${req.request_no} is already answered by ${pv.pv_number} — open that voucher instead.` }, 409) };
    }
  }
  return { request: req };
}

/** AFTER the voucher's header and lines are in: claim the request for it (only
    if nobody claimed it in between — else the caller rolls the voucher back),
    then copy the request's files onto the voucher, best-effort. */
export async function linkPaymentRequest(
  c: any,
  req: Row,
  pv: { id: string; pvNumber: string },
): Promise<{ ok: true; filesCopied: number } | { ok: false; status: 409 | 500; body: Record<string, unknown> }> {
  const sb = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return { ok: false, status: 500, body: { error: 'no_company' } };
  let claim = sb.from('acc_payment_requests')
    .update({ status: 'VOUCHERED', pv_id: pv.id, updated_at: new Date().toISOString() })
    .eq('company_id', co.companyId).eq('id', req.id).eq('status', String(req.status));
  claim = req.pv_id ? claim.eq('pv_id', req.pv_id) : claim.is('pv_id', null);
  /* One row by id: UPDATE … RETURNING through maybeSingle — null means someone
     claimed or moved it first. */
  const { data: claimed, error } = await claim.select('id').maybeSingle();
  if (error) return { ok: false, status: 500, body: { error: 'link_failed', reason: error.message } };
  if (!claimed) {
    return { ok: false, status: 409, body: { error: 'request_taken', message: `${req.request_no} was answered by another voucher a moment ago — nothing was created.` } };
  }
  return { ok: true, filesCopied: await copyRequestFilesToVoucher(c, co.companyId, String(req.id), pv.id) };
}

/* The bill travels with the money: each request file is copied into the SLIPS
   bucket under the voucher's own prefix and indexed on scm.acc_pv_files, so the
   voucher's print bundle carries it. A copy that fails leaves the file where it
   was (still on the request) — the voucher is not undone for evidence. */
async function copyRequestFilesToVoucher(c: any, companyId: number, requestId: string, pvId: string): Promise<number> {
  const bucket = (c.env as { SLIPS?: { get: (k: string) => Promise<any>; put: (k: string, v: ArrayBuffer, o?: unknown) => Promise<unknown> } }).SLIPS;
  if (!bucket) return 0;
  const sb = c.get('supabase');
  const { data: files, error } = await sb.from('acc_payment_request_files')
    .select('file_key, file_name, mime, size_bytes, sort_no').eq('company_id', companyId).eq('request_id', requestId).order('sort_no');
  if (error || !files) return 0;
  let copied = 0;
  for (const f of files as Row[]) {
    try {
      const obj = await bucket.get(String(f.file_key));
      if (!obj) continue;
      /* R2ObjectBody reads with arrayBuffer(); a bare body stream reads through Response. */
      const bytes: ArrayBuffer = typeof obj.arrayBuffer === 'function' ? await obj.arrayBuffer() : await new Response(obj.body).arrayBuffer();
      const ext = String(f.file_key).split('.').pop() ?? 'bin';
      const key = `pv-files/${companyId}/${pvId}/${crypto.randomUUID()}.${ext}`;
      await bucket.put(key, bytes, { httpMetadata: { contentType: String(f.mime) } });
      const { error: insErr } = await sb.from('acc_pv_files').insert({
        company_id: companyId, pv_id: pvId, file_key: key, file_name: f.file_name, mime: f.mime,
        size_bytes: f.size_bytes, sort_no: Number(f.sort_no ?? copied + 1), created_by: 'payment-request',
      });
      if (!insErr) copied += 1;
    } catch {
      /* The file stays on the request; the next copy is tried. */
    }
  }
  return copied;
}

