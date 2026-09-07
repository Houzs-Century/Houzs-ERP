// ----------------------------------------------------------------------------
// PV attachments — the bill finally lives with its voucher (owner 2026-09-03:
// print pv include ocr 的文件一起; before this the scan flow READ the bill
// and kept nothing).
//
//   POST   /payment-vouchers/:id/files          {fileName, mime, dataBase64}
//   GET    /payment-vouchers/:id/files          the index rows
//   GET    /payment-vouchers/:id/files/:fileId  streams the bytes from R2
//   DELETE /payment-vouchers/:id/files/:fileId  until CHECKED — evidence
//          locks with the document (the owner's own four-layer rule).
//
// Bytes live in the SLIPS R2 bucket (the one binding that exists — see
// slips.ts's history) under pv-files/<company>/<pv>/<uuid>.<ext>; the index
// is scm.acc_pv_files (0352), sort_no = attach order = print order.
// Upload/delete take scm.payment_voucher.write; reading rides the voucher.
// The four handlers come from lib/doc-files.ts — one factory, since
// 2026-09-06 fed this spec and the AP invoice's (routes/ap-invoice-files.ts);
// only the spec and the print bundle are this file's. Handlers exported
// bare for the vitest harness.
// ----------------------------------------------------------------------------

import { requireActiveCompanyId, scopeToCompany } from '../lib/companyScope';
import { assemblePvBatchPdf, type PdfAttachment } from '../lib/pdf-attach';
import { decodeBase64, loadDocAttachments, makeDocFileHandlers, type DocFilesSpec } from '../lib/doc-files';
import { AP_INVOICE_FILES } from './ap-invoice-files';

type Row = Record<string, any>;

export const PV_FILES: DocFilesSpec = {
  table: 'acc_pv_files',
  fkColumn: 'pv_id',
  keyPrefix: 'pv-files',
  writePerms: ['scm.payment_voucher.write'],
  load: async (c: any) => {
    const sb = c.get('supabase');
    const { data, error } = await scopeToCompany(
      sb.from('payment_vouchers').select('id, pv_number, status, checked_at, company_id').eq('id', c.req.param('id')), c,
    ).maybeSingle();
    if (error) return { resp: c.json({ error: 'load_failed', reason: error.message }, 500) };
    if (!data) return { resp: c.json({ error: 'not_found' }, 404) };
    const pv = data as Row;
    /* Evidence locks with the document: checked 的人就不可以改了. */
    return { doc: { id: String(pv.id), closed: pv.status === 'CANCELLED', locked: !!pv.checked_at } };
  },
  closedRefusal: { error: 'voucher_cancelled', message: 'A cancelled voucher takes no more evidence.' },
  lockedRefusal: { error: 'evidence_locked', message: 'The voucher is checked — its evidence stays.' },
};

const handlers = makeDocFileHandlers(PV_FILES);
export const uploadPvFileHandler = handlers.upload;
export const listPvFilesHandler = handlers.list;
export const streamPvFileHandler = handlers.stream;
export const deletePvFileHandler = handlers.remove;

/* ── POST /payment-vouchers/print-bundle ────────────────────────────────────
   The print's merge, done WHERE THE FILES LIVE (see lib/pdf-attach.ts for
   why not the browser). Body: { parts: [{ pvId, voucherBase64 }] } — each
   part is ONE voucher's rendered page(s) (jsPDF output, client-side, so the
   letterhead/CJK pipeline stays where it is); the response is one PDF:
   voucher A, A's stored files in sort_no order, then the files of every AP
   INVOICE A pays (owner 2026-09-06: bundle 也带上 — allocation order, each
   named under its invoice number), voucher B, B's… A part whose voucher
   cannot be loaded fails the WHOLE request by pv — a bundle quietly missing
   a voucher is the dishonest branch. A stored file whose R2 object is gone
   becomes a notice page (the index said it existed; paper must say it
   didn't print). Reading rides the voucher (area guard). */
const MAX_BUNDLE_PARTS = 30;
const MAX_VOUCHER_BYTES = 10 * 1024 * 1024;

export const printPvBundleHandler = async (c: any): Promise<Response> => {
  const bucket = (c.env as { SLIPS?: { get: (k: string) => Promise<any> } }).SLIPS;
  if (!bucket) return c.json({ error: 'r2_not_configured', reason: 'R2 binding SLIPS not configured' }, 500);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json({ error: 'no_company' }, 409);
  const sb = c.get('supabase');

  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parts = Array.isArray(body?.parts) ? body.parts : [];
  if (parts.length === 0) return c.json({ error: 'no_parts', message: 'Nothing to print.' }, 400);
  if (parts.length > MAX_BUNDLE_PARTS) {
    return c.json({ error: 'too_many_parts', message: `A bundle is capped at ${MAX_BUNDLE_PARTS} vouchers.` }, 400);
  }

  const assembled: Array<{ voucher: ArrayBuffer; files: PdfAttachment[] }> = [];
  let firstPvNumber = '';
  for (const part of parts as Array<{ pvId?: unknown; voucherBase64?: unknown }>) {
    const pvId = String(part.pvId ?? '');
    const { data: pv, error: pvErr } = await scopeToCompany(
      sb.from('payment_vouchers').select('id, pv_number, company_id').eq('id', pvId), c,
    ).maybeSingle();
    if (pvErr) return c.json({ error: 'load_failed', reason: pvErr.message }, 500);
    if (!pv) return c.json({ error: 'not_found', message: `Voucher ${pvId} could not be loaded — nothing was printed.` }, 404);
    firstPvNumber ||= String((pv as Row).pv_number ?? '');

    const voucherBytes = decodeBase64(String(part.voucherBase64 ?? ''));
    if (!voucherBytes || voucherBytes.byteLength === 0) {
      return c.json({ error: 'bad_voucher_page', message: `${(pv as Row).pv_number}'s rendered page did not arrive intact.` }, 400);
    }
    if (voucherBytes.byteLength > MAX_VOUCHER_BYTES) {
      return c.json({ error: 'voucher_page_too_large' }, 400);
    }

    const own = await loadDocAttachments(c, bucket, PV_FILES, String((pv as Row).id));
    if ('error' in own) return c.json({ error: 'load_failed', reason: own.error }, 500);
    const files: PdfAttachment[] = [...own.files];

    /* The bills this voucher PAYS: every AP invoice it allocates to lends its
       own stored files, allocation order. A purchase-invoice allocation adds
       nothing — PIs keep no files here. */
    const { data: allocRows, error: allocErr } = await scopeToCompany(
      sb.from('pv_allocations').select('ap_invoice_id, created_at').eq('pv_id', (pv as Row).id), c,
    ).order('created_at');
    if (allocErr) return c.json({ error: 'load_failed', reason: allocErr.message }, 500);
    const apIds = [...new Set(((allocRows ?? []) as Row[]).map((a) => a.ap_invoice_id).filter((id): id is string => typeof id === 'string' && id.length > 0))];
    if (apIds.length > 0) {
      const { data: invRows, error: invErr } = await scopeToCompany(
        sb.from('ap_invoices').select('id, invoice_number').in('id', apIds), c,
      );
      if (invErr) return c.json({ error: 'load_failed', reason: invErr.message }, 500);
      const numberOf = new Map(((invRows ?? []) as Row[]).map((r) => [String(r.id), String(r.invoice_number ?? '')]));
      for (const apId of apIds) {
        const theirs = await loadDocAttachments(c, bucket, AP_INVOICE_FILES, apId, numberOf.get(apId) || 'AP invoice');
        if ('error' in theirs) return c.json({ error: 'load_failed', reason: theirs.error }, 500);
        files.push(...theirs.files);
      }
    }
    assembled.push({ voucher: voucherBytes.buffer as ArrayBuffer, files });
  }

  const merged = await assemblePvBatchPdf(assembled);
  const name = parts.length === 1 ? `${firstPvNumber || 'payment-voucher'}.pdf` : 'payment-vouchers.pdf';
  return new Response(merged as unknown as BodyInit, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="${name.replace(/"/g, '')}"`,
      'cache-control': 'no-store',
    },
  });
};
