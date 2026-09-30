// POST /payment-vouchers/extract — the bill reader behind 📷 Scan bills (PV and
// AP invoice alike). Moved out of payment-vouchers.ts unchanged on 2026-09-30,
// when that file reached its 2000-line ceiling; payment-vouchers.ts still
// registers the route and re-exports the handler.

import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId, scopeToCompany } from '../lib/companyScope';
import { extractOneBill, matchSupplier, normalizeVendor, BILL_IMAGE_MIMES, MAX_BILLS_PER_CALL, MAX_FILES_PER_BILL, MAX_BILL_FILE_BYTES } from '../../acc/bill-extract';

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
  const bills = Array.isArray(body.bills) ? body.bills : [];
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

  const out = [] as Array<Record<string, unknown>>;
  for (const [i, b] of bills.entries()) {
    const files = (b.files as Array<{ name?: unknown; mime?: unknown; dataBase64?: unknown }>).map((f) => ({
      name: String(f.name ?? `file-${i}`), mime: String(f.mime ?? ''), dataBase64: String(f.dataBase64 ?? ''),
    }));
    const r = await extractOneBill(apiKey, files);
    if (!r.ok) {
      out.push({ index: i, ok: false, reason: r.reason });
      continue;
    }
    const match = matchSupplier(r.extraction.vendorName, suppliers);
    const mem = memoryFor(r.extraction.vendorName, match?.supplier.name ?? null);
    out.push({
      index: i, ok: true, extraction: r.extraction,
      supplierMatch: match ? { id: match.supplier.id, code: match.supplier.code, name: match.supplier.name, confidence: match.confidence } : null,
      memory: mem ? { payeeName: mem.payee_name, debitAccountCode: mem.debit_account_code, purpose: mem.purpose, timesSeen: mem.times_seen } : null,
    });
  }
  return c.json({ bills: out });
};
