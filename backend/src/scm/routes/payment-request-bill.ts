// ----------------------------------------------------------------------------
// payment-request-bill — the bill a payment request carries, READ when it is
// attached (owner 2026-10-01, payment-request item 1 → 做: 申请一定要有 the bill;
// a bill for an event needs its Event; 同一张单上传两次 is said out loud).
//
//   POST /payment-requests/read-bill     { files }      the bill being attached,
//                                         before the request exists
//                                         { requestId }  a request's stored bill
//   GET  /payment-requests/bill-matches?no=&date=[&excludeRequest=&excludePv=&excludeApInvoice=]
//
// The reader (acc/bill-extract.ts) reads what is PRINTED — the bill's number,
// date and total, and the event it is for when it names one. Plain code does the
// rest: which events those hints point at (lib/event-match.ts), and every OTHER
// live request, voucher or AP invoice carrying the same number and date
// (lib/bill-matches.ts — a warning, never a refusal). NOTHING here writes: the
// request keeps what was read when it is sent.
// ----------------------------------------------------------------------------

import { hasHouzsPerm } from '../lib/houzs-perms';
import { activeCompanySql, requireActiveCompanyId, scopeToCompany } from '../lib/companyScope';
import { companyHasEvents, loadEventsBetween } from '../lib/event-tags';
import { suggestEvents, type EventSuggestion } from '../lib/event-match';
import { findBillMatches, type BillProbe } from '../lib/bill-matches';
import { PAYMENT_REQUEST_KEY, callerUserId, isRequestFinance } from '../lib/payment-request';
import { todayMyt } from '../lib/my-time';
import { BILL_IMAGE_MIMES, MAX_BILL_FILE_BYTES, MAX_FILES_PER_BILL, extractOneBill, type BillFile } from '../../acc/bill-extract';
import { requestBill } from './pv-extract';

type Row = Record<string, any>;
const NO_PERM = { error: "You don't have permission to do that." };
const mayOpen = (c: any): boolean => hasHouzsPerm(c, PAYMENT_REQUEST_KEY) || isRequestFinance(c);

const shiftDay = (ymd: string, days: number): string => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** The files the body sends as ONE bill's pages — the extract door's own checks. */
function filesOf(body: Row): { files: BillFile[] } | { error: string; message: string } {
  const raw = Array.isArray(body.files) ? body.files : [];
  if (raw.length === 0) return { error: 'no_files', message: 'Attach the bill first.' };
  if (raw.length > MAX_FILES_PER_BILL) return { error: 'too_many_pages', message: `A bill has at most ${MAX_FILES_PER_BILL} pages.` };
  const files: BillFile[] = [];
  for (const [i, f] of raw.entries()) {
    const mime = String(f?.mime ?? '');
    if (!BILL_IMAGE_MIMES.has(mime) && mime !== 'application/pdf') {
      return { error: 'bad_file_type', message: `${mime || 'That file'} is not a photo or a PDF — JPEG / PNG / WebP / PDF only.` };
    }
    const data = String(f?.dataBase64 ?? '');
    if (!data || Math.floor(data.length * 0.75) > MAX_BILL_FILE_BYTES) {
      return { error: 'file_too_big', message: `A file is empty or over ${Math.round(MAX_BILL_FILE_BYTES / 1024 / 1024)}MB.` };
    }
    files.push({ name: String(f?.name ?? `page-${i + 1}`), mime, dataBase64: data });
  }
  return { files };
}

/* ── POST /read-bill ───────────────────────────────────────────────────────── */
export const readRequestBillHandler = async (c: any): Promise<Response> => {
  if (!mayOpen(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: Row;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const sb = c.get('supabase');

  let files: BillFile[];
  let exclude: BillProbe['exclude'] = {};
  const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : '';
  if (requestId) {
    /* A stored bill: the requester's own request, or any for Finance. */
    const { data: req, error } = await scopeToCompany(sb.from('acc_payment_requests')
      .select('id, requested_by, pv_id, ap_invoice_id').eq('id', requestId), c).maybeSingle();
    if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
    if (!req || (!isRequestFinance(c) && Number(req.requested_by) !== callerUserId(c))) {
      return c.json({ error: 'not_found', message: 'That payment request is not one you can open.' }, 404);
    }
    const got = await requestBill(c, requestId);
    if ('resp' in got) return got.resp;
    if (got.files.length === 0) return c.json({ error: 'no_files', message: 'This request carries no bill yet — attach it first.' }, 400);
    files = got.files;
    exclude = { requestIds: [requestId], pvIds: [req.pv_id], apInvoiceIds: [req.ap_invoice_id] };
  } else {
    const got = filesOf(body);
    if ('error' in got) return c.json(got, 400);
    files = got.files;
  }

  /* No reader here is not a refusal: the request still goes, and Finance reads
     the bill when it answers (pv-extract { fromRequest }). */
  const apiKey = c.env?.ANTHROPIC_API_KEY;
  if (!apiKey) return c.json({ ok: false, reason: 'The bill reader is not set up here — send the request; Finance reads the bill.' });
  const read = await extractOneBill(apiKey, files);
  if (!read.ok) return c.json({ ok: false, reason: read.reason });
  const ex = read.extraction;

  /* An event bill is one the reader says names an event — in a company that
     runs events at all. A failed events read asks for nothing: the requester is
     never stopped by our own outage. */
  const companySql = activeCompanySql(c, 'p.company_id');
  let hasEvents = false;
  try { hasEvents = await companyHasEvents(c.env.DB, companySql); } catch { hasEvents = false; }
  const eventBill = hasEvents && ex.event != null;
  let eventSuggestions: EventSuggestion[] = [];
  if (eventBill) {
    const from = ex.event?.dateFrom ?? ex.invoiceDate ?? todayMyt();
    const to = ex.event?.dateTo ?? ex.event?.dateFrom ?? ex.invoiceDate ?? todayMyt();
    try {
      const events = await loadEventsBetween(c.env.DB, companySql, shiftDay(from, -60), shiftDay(to, 180));
      eventSuggestions = suggestEvents({
        hint: ex.event,
        vendorName: ex.vendorName,
        lineText: ex.lines.map((l) => l.description ?? '').join(' '),
        billDate: ex.invoiceDate,
      }, events);
    } catch {
      eventSuggestions = [];
    }
  }

  const found = await findBillMatches(sb, co.companyId, [{ key: 'bill', billNo: ex.invoiceNumber, billDate: ex.invoiceDate, exclude }]);
  if (!found.ok) return c.json({ error: 'load_failed', reason: found.reason }, 500);
  return c.json({
    ok: true,
    bill: { billNo: ex.invoiceNumber, billDate: ex.invoiceDate, totalSen: ex.totalSen, vendorName: ex.vendorName },
    hasEvents,
    eventBill,
    event: ex.event,
    eventSuggestions: eventSuggestions.map((s) => ({ id: s.id, score: s.score, reasons: s.reasons, event: s.event })),
    matches: found.matches.get('bill') ?? [],
  });
};

/* ── GET /bill-matches ─────────────────────────────────────────────────────── */
export const billMatchesHandler = async (c: any): Promise<Response> => {
  if (!mayOpen(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const q = (k: string): string | null => {
    const v = c.req.query(k);
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  };
  const found = await findBillMatches(c.get('supabase'), co.companyId, [{
    key: 'q', billNo: q('no'), billDate: q('date'),
    exclude: { requestIds: [q('excludeRequest')], pvIds: [q('excludePv')], apInvoiceIds: [q('excludeApInvoice')] },
  }]);
  if (!found.ok) return c.json({ error: 'load_failed', reason: found.reason }, 500);
  return c.json({ matches: found.matches.get('q') ?? [] });
};
