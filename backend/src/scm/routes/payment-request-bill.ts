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
// date and total, and the event it is for when it names one; since 2026-10-02
// also who issued it, its due date, a one-line summary and the bank account it
// asks to be paid into, which the form fills in where empty. Plain code does the
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
import { DOC_FILE_MIMES, MAX_DOC_FILE_BYTES, decodeBase64, type DocFilesSpec } from '../lib/doc-files';
import { compareOfficial, officialActor } from '../lib/official-doc';
import { PV_FILES } from './pv-files';
import { AP_INVOICE_FILES } from './ap-invoice-files';

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
  /* Everything the form can fill from the paper (owner 2026-10-02: upload 后很多
     资料都没有填) — who to pay, by when, what for and into which account. The
     form fills only what is still empty; what the requester typed stays. */
  return c.json({
    ok: true,
    bill: {
      billNo: ex.invoiceNumber, billDate: ex.invoiceDate, totalSen: ex.totalSen, vendorName: ex.vendorName,
      dueDate: ex.dueDate, summary: ex.summary,
      bankName: ex.payTo?.bankName ?? null, bankAccountNo: ex.payTo?.accountNo ?? null, bankAccountName: ex.payTo?.accountName ?? null,
    },
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

/* ── POST /:id/official-doc — 补正式单 (owner 2026-10-01, item 3) ──────────────
   The official invoice for a bill paid on a proforma or a quotation, uploaded
   AFTER the payment — on any request of the bill, by its requester (or by
   Finance). It stays on the request as an 'official' file, is copied to every
   live payment of the bill (each instalment's voucher or AP invoice), and each
   one Finance marked as owing moves to RECEIVED — to check — with what the
   reader found against the proforma (lib/official-doc.ts compareOfficial).
   Nothing in the ledger moves. */
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
type Bucket = { put: (k: string, v: ArrayBuffer, o?: unknown) => Promise<unknown> };

async function putIndexed(c: any, bucket: Bucket, spec: Pick<DocFilesSpec, 'table' | 'fkColumn' | 'keyPrefix'>, companyId: number, docId: string, file: { name: string; mime: string; bytes: Uint8Array }): Promise<Row | null> {
  const sb = c.get('supabase');
  const { data: existing, error: exErr } = await sb.from(spec.table).select('sort_no').eq('company_id', companyId).eq(spec.fkColumn, docId);
  /* An unreadable index is not "no files yet": nothing is stored on a guess. */
  if (exErr) return null;
  const sortNo = ((existing ?? []) as Row[]).reduce((m, r) => Math.max(m, Number(r.sort_no ?? 0)), 0) + 1;
  const key = `${spec.keyPrefix}/${companyId}/${docId}/${crypto.randomUUID()}.${EXT[file.mime] ?? 'bin'}`;
  await bucket.put(key, file.bytes.buffer as ArrayBuffer, { httpMetadata: { contentType: file.mime } });
  const { data: row, error } = await sb.from(spec.table).insert({
    company_id: companyId, [spec.fkColumn]: docId, file_key: key, file_name: file.name, mime: file.mime,
    size_bytes: file.bytes.byteLength, sort_no: sortNo, created_by: String(c.get('user')?.id ?? 'payment-request'), kind: 'official',
  }).select('id, file_name, mime, size_bytes, sort_no, kind').single();
  return error ? null : (row as Row);
}

export const uploadOfficialDocHandler = async (c: any): Promise<Response> => {
  if (!mayOpen(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const { data: req, error } = await scopeToCompany(sb.from('acc_payment_requests')
    .select('id, request_no, requested_by, status, parent_request_id').eq('id', c.req.param('id')), c).maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!req || (!isRequestFinance(c) && Number(req.requested_by) !== callerUserId(c))) {
    return c.json({ error: 'not_found', message: 'That payment request is not one you can open.' }, 404);
  }
  if (req.status === 'WITHDRAWN') return c.json({ error: 'request_withdrawn', message: `${req.request_no} was withdrawn — it takes no more files.` }, 409);
  let body: Row;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const mime = String(body.mime ?? '').trim().toLowerCase();
  if (!DOC_FILE_MIMES.has(mime)) return c.json({ error: 'bad_mime', message: `${mime || '(none)'} is not an image or a PDF.` }, 400);
  const dataBase64 = String(body.dataBase64 ?? '');
  const bytes = dataBase64 ? decodeBase64(dataBase64) : null;
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_DOC_FILE_BYTES) {
    return c.json({ error: 'bad_size', message: `Files are capped at ${MAX_DOC_FILE_BYTES / 1024 / 1024}MB.` }, 400);
  }
  const bucket = (c.env as { SLIPS?: Bucket }).SLIPS;
  if (!bucket) return c.json({ error: 'r2_not_configured', reason: 'R2 binding SLIPS not configured' }, 500);
  const file = { name: String(body.fileName ?? '').trim() || 'official-invoice', mime, bytes };

  /* On the request itself, as the official invoice. */
  const kept = await putIndexed(c, bucket, { table: 'acc_payment_request_files', fkColumn: 'request_id', keyPrefix: 'payment-request-files' }, co.companyId, String(req.id), file);
  if (!kept) return c.json({ error: 'save_failed', reason: 'The file could not be indexed on the request.' }, 500);

  /* The bill's live payments: every instalment's answer. */
  const rootId = String(req.parent_request_id ?? req.id);
  const { data: kin, error: kErr } = await sb.from('acc_payment_requests').select('id, pv_id, ap_invoice_id, bill_no, bill_total_sen, parent_request_id')
    .eq('company_id', co.companyId).or(`id.eq.${rootId},parent_request_id.eq.${rootId}`);
  if (kErr) return c.json({ error: 'load_failed', reason: kErr.message }, 500);
  const family = (kin ?? []) as Row[];
  const root = family.find((r) => String(r.id) === rootId) ?? null;
  const pvIds = [...new Set(family.map((r) => r.pv_id).filter(Boolean).map(String))];
  const apiIds = [...new Set(family.map((r) => r.ap_invoice_id).filter(Boolean).map(String))];
  const [pvs, apis] = await Promise.all([
    pvIds.length > 0 ? sb.from('payment_vouchers').select('id, pv_number, status, official_doc').eq('company_id', co.companyId).in('id', pvIds) : Promise.resolve({ data: [], error: null }),
    apiIds.length > 0 ? sb.from('ap_invoices').select('id, invoice_number, status, official_doc').eq('company_id', co.companyId).in('id', apiIds) : Promise.resolve({ data: [], error: null }),
  ]);
  const dErr = pvs.error ?? apis.error;
  if (dErr) return c.json({ error: 'load_failed', reason: dErr.message }, 500);

  /* What the reader reads off it against the proforma — said, never decided. */
  let note: string | null = null;
  const apiKey = c.env?.ANTHROPIC_API_KEY;
  if (apiKey) {
    const read = await extractOneBill(apiKey, [{ name: file.name, mime, dataBase64 }]);
    if (read.ok) {
      note = compareOfficial(
        { invoiceNumber: read.extraction.invoiceNumber, totalSen: read.extraction.totalSen },
        { billNo: root?.bill_no ?? null, totalSen: root?.bill_total_sen == null ? null : Number(root.bill_total_sen) },
      );
    }
  }

  const received: Array<{ kind: 'PV' | 'API'; number: string | null }> = [];
  const stamp = { official_doc: 'RECEIVED', official_doc_note: note, official_doc_at: new Date().toISOString(), official_doc_by: officialActor(c) };
  for (const [kind, rows, spec, table, numberCol] of [
    ['PV', (pvs.data ?? []) as Row[], PV_FILES, 'payment_vouchers', 'pv_number'],
    ['API', (apis.data ?? []) as Row[], AP_INVOICE_FILES, 'ap_invoices', 'invoice_number'],
  ] as const) {
    for (const d of rows) {
      if (d.status === 'CANCELLED') continue;
      /* The file travels with the money, marked or not. */
      await putIndexed(c, bucket, spec, co.companyId, String(d.id), file);
      if (d.official_doc !== 'OWED' && d.official_doc !== 'RECEIVED') continue;
      const { error: upErr } = await sb.from(table).update(stamp).eq('company_id', co.companyId).eq('id', d.id);
      if (!upErr) received.push({ kind, number: d[numberCol] ?? null });
    }
  }
  return c.json({ ok: true, file: kept, received, note }, 201);
};
