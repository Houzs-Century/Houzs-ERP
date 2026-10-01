// POST /payment-vouchers/extract — the bill reader behind 📷 Scan bills (PV and
// AP invoice alike). Moved out of payment-vouchers.ts unchanged on 2026-09-30,
// when that file reached its 2000-line ceiling; payment-vouchers.ts still
// registers the route and re-exports the handler.

import { hasHouzsPerm } from '../lib/houzs-perms';
import { activeCompanySql, requireActiveCompanyId, scopeToCompany } from '../lib/companyScope';
import { loadEventsBetween, type EventRow } from '../lib/event-tags';
import { suggestEvents } from '../lib/event-match';
import { todayMyt } from '../lib/my-time';
import { extractOneBill, matchSupplier, normalizeVendor, BILL_IMAGE_MIMES, MAX_BILLS_PER_CALL, MAX_FILES_PER_BILL, MAX_BILL_FILE_BYTES } from '../../acc/bill-extract';
import { toBase64 } from '../lib/scan-ocr';

/* ── Bill OCR — read incoming bills into voucher pre-fills (2026-09-02) ──────
   我想要把ocr 功能放去payment 那边. Each `bills` entry is ONE document (its
   files are its pages — the human said so at upload; the server never guesses
   whether two files are one bill). One vision call per bill, supplier matched
   server-side, and NOTHING written: the answer pre-fills a form a person
   still checks, saves, and sends through the untouched approval cycle. */
export const extractBillsHandler = async (c: any) => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.create')) {
    return c.json({ error: "You don't have permission to do that." }, 403);
  }
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const apiKey = c.env?.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return c.json({ error: 'anthropic_key_missing', reason: 'Run: npx wrangler secret put ANTHROPIC_API_KEY' }, 503);
  }

  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  /* { fromRequest } — the bill a payment request carries, read when Finance
     opens the voucher or AP invoice that answers it (owner 2026-09-30, 6.2).
     The request's files are the pages of ONE bill; a request with none reads
     as no bill at all, and the form keeps what the request said. */
  let bills: any[];
  if (typeof body.fromRequest === 'string' && body.fromRequest.trim()) {
    const got = await requestBill(c, body.fromRequest.trim());
    if ('resp' in got) return got.resp;
    if (got.files.length === 0) return c.json({ bills: [] });
    bills = [{ files: got.files }];
  } else {
    bills = Array.isArray(body.bills) ? body.bills : [];
  }
  if (bills.length === 0) return c.json({ error: 'no_bills', message: 'Send at least one bill.' }, 400);
  if (bills.length > MAX_BILLS_PER_CALL) {
    return c.json({ error: 'too_many_bills', message: `At most ${MAX_BILLS_PER_CALL} bills per batch — split the pile.` }, 400);
  }
  for (const [i, b] of bills.entries()) {
    const files = Array.isArray(b?.files) ? b.files : [];
    if (files.length === 0) return c.json({ error: 'empty_bill', message: `Bill ${i + 1} has no files.` }, 400);
    if (files.length > MAX_FILES_PER_BILL) {
      return c.json({ error: 'too_many_pages', message: `Bill ${i + 1} has more than ${MAX_FILES_PER_BILL} pages.` }, 400);
    }
    for (const f of files) {
      const mime = String(f?.mime ?? '');
      if (!BILL_IMAGE_MIMES.has(mime) && mime !== 'application/pdf') {
        return c.json({ error: 'bad_file_type', message: `Bill ${i + 1}: ${mime || 'unknown type'} — JPEG / PNG / WebP / PDF only.` }, 400);
      }
      const size = Math.floor(String(f?.dataBase64 ?? '').length * 0.75);
      if (size > MAX_BILL_FILE_BYTES) {
        return c.json({ error: 'file_too_big', message: `Bill ${i + 1}: a file is over ${Math.round(MAX_BILL_FILE_BYTES / 1024 / 1024)}MB.` }, 400);
      }
    }
  }

  /* Suppliers once for the whole batch — matching is per bill, in code. */
  const sb = c.get('supabase');
  const { data: supRaw, error: supErr } = await scopeToCompany(
    sb.from('suppliers').select('id, code, name').eq('status', 'ACTIVE'), c,
  );
  if (supErr) return c.json({ error: 'load_failed', reason: supErr.message }, 500);
  const suppliers = (supRaw ?? []) as Array<{ id: string; code: string | null; name: string }>;

  /* Vendor memory (0341), once for the batch — what the operator saved the
     last time each vendor was paid. Small by construction: one row per
     distinct vendor per company. */
  const { data: memRaw, error: memErr } = await scopeToCompany(
    sb.from('acc_vendor_memory').select('vendor_key, payee_name, debit_account_code, purpose, times_seen'), c,
  );
  if (memErr) return c.json({ error: 'load_failed', reason: memErr.message }, 500);
  type MemRow = { vendor_key: string; payee_name: string | null; debit_account_code: string | null; purpose: string | null; times_seen: number };
  const memByKey = new Map(((memRaw ?? []) as MemRow[]).map((m) => [m.vendor_key, m]));
  /* The printed name first; the MATCHED supplier's name second — a bill
     reading "TENAGA NASIONAL" still finds the habit saved under "TNB" when
     both normalize onto the supplier the matcher agreed on. */
  const memoryFor = (vendorName: string | null, matchedName: string | null): MemRow | null => {
    for (const raw of [vendorName, matchedName]) {
      if (!raw) continue;
      const hit = memByKey.get(normalizeVendor(raw));
      if (hit) return hit;
    }
    return null;
  };

  const read: Array<Awaited<ReturnType<typeof extractOneBill>>> = [];
  for (const [i, b] of bills.entries()) {
    const files = (b.files as Array<{ name?: unknown; mime?: unknown; dataBase64?: unknown }>).map((f) => ({
      name: String(f.name ?? `file-${i}`), mime: String(f.mime ?? ''), dataBase64: String(f.dataBase64 ?? ''),
    }));
    read.push(await extractOneBill(apiKey, files));
  }

  /* The events the bills could be for (owner 2026-09-30: ocr 要有办法 detect
     相关的 event) — read ONCE for the batch, only when a bill printed an event,
     over a window around the dates it printed. A failed read offers nothing;
     it never fails the scan: the suggestion is a convenience (6a). */
  const anchors = read.flatMap((r) => (r.ok && r.extraction.event ? [r.extraction.event.dateFrom ?? r.extraction.invoiceDate ?? todayMyt(), r.extraction.event.dateTo ?? r.extraction.event.dateFrom ?? r.extraction.invoiceDate ?? todayMyt()] : []));
  let events: EventRow[] = [];
  if (anchors.length > 0) {
    const shift = (ymd: string, days: number) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
    const sorted = [...anchors].sort();
    try {
      events = await loadEventsBetween(c.env.DB, activeCompanySql(c, 'p.company_id'), shift(sorted[0]!, -60), shift(sorted[sorted.length - 1]!, 180));
    } catch {
      events = [];
    }
  }

  const out = read.map((r, i) => {
    if (!r.ok) return { index: i, ok: false, reason: r.reason };
    const match = matchSupplier(r.extraction.vendorName, suppliers);
    const mem = memoryFor(r.extraction.vendorName, match?.supplier.name ?? null);
    return {
      index: i, ok: true, extraction: r.extraction,
      supplierMatch: match ? { id: match.supplier.id, code: match.supplier.code, name: match.supplier.name, confidence: match.confidence } : null,
      memory: mem ? { payeeName: mem.payee_name, debitAccountCode: mem.debit_account_code, purpose: mem.purpose, timesSeen: mem.times_seen } : null,
      eventSuggestions: r.extraction.event
        ? suggestEvents({
          hint: r.extraction.event,
          vendorName: r.extraction.vendorName,
          lineText: r.extraction.lines.map((l) => l.description ?? '').join(' '),
          billDate: r.extraction.invoiceDate,
        }, events)
        : [],
    };
  });
  return c.json({ bills: out });
};

/** A payment request's files, read from the file store as one bill's pages —
    the same shape a scanned bill arrives in. The request must be this
    company's; the extract's own checks (types, sizes, page count) still apply. */
export async function requestBill(c: any, requestId: string): Promise<{ files: Array<{ name: string; mime: string; dataBase64: string }> } | { resp: Response }> {
  const sb = c.get('supabase');
  const { data: req, error } = await scopeToCompany(sb.from('acc_payment_requests').select('id').eq('id', requestId), c).maybeSingle();
  if (error) return { resp: c.json({ error: 'load_failed', reason: error.message }, 500) };
  if (!req) return { resp: c.json({ error: 'request_not_found', message: 'That payment request is not in the company you are working in.' }, 404) };
  const { data: rows, error: fErr } = await scopeToCompany(sb.from('acc_payment_request_files')
    .select('file_key, file_name, mime, sort_no').eq('request_id', requestId), c).order('sort_no');
  if (fErr) return { resp: c.json({ error: 'load_failed', reason: fErr.message }, 500) };
  const list = (rows ?? []) as Array<{ file_key: string; file_name: string; mime: string }>;
  if (list.length === 0) return { files: [] };
  const bucket = (c.env as { SLIPS?: { get: (k: string) => Promise<any> } }).SLIPS;
  if (!bucket) return { resp: c.json({ error: 'file_store_missing', message: 'The file store is not configured here — the bill cannot be read.' }, 503) };
  const files: Array<{ name: string; mime: string; dataBase64: string }> = [];
  for (const f of list) {
    const obj = await bucket.get(String(f.file_key));
    if (!obj) continue;
    const bytes: ArrayBuffer = typeof obj.arrayBuffer === 'function' ? await obj.arrayBuffer() : await new Response(obj.body).arrayBuffer();
    files.push({ name: String(f.file_name), mime: String(f.mime), dataBase64: toBase64(bytes) });
  }
  return { files };
}
