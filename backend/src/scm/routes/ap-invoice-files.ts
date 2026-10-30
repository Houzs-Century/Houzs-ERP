// ----------------------------------------------------------------------------
// AP invoice attachments — the supplier's bill LIVES with the AP invoice, the
// way the scanned bill lives with its voucher (owner 2026-09-06, told the AP
// invoice had neither OCR nor files: 做,附件也一起做,bundle 也带上).
//
//   POST   /ap-invoices/:id/files          {fileName, mime, dataBase64}
//   GET    /ap-invoices/:id/files          the index rows
//   GET    /ap-invoices/:id/files/:fileId  streams the bytes from R2
//   DELETE /ap-invoices/:id/files/:fileId  until an AP Payment holds the
//          bill — money paid against it, or a CHECKED voucher that ticks it
//          (checked before posted, paid_sen still 0) — that voucher prints
//          these files in its bundle, so they stay. A posted, unpaid
//          bill may still lose a wrong file (HC-0181: the bill was right,
//          only the attachment was wrong, and Cancel bill was the only way
//          out). A CANCELLED bill takes no more evidence; a posted one may
//          still receive its scan.
//
// Keys: ap-invoice-files/<company>/<invoice>/<uuid>.<ext> in the SLIPS R2
// bucket; index scm.acc_ap_invoice_files (20260906T2100). The AP Payment's
// print bundle (routes/pv-files.ts) appends these after the voucher's own
// files, one paid bill after another. Handlers come from the shared factory
// (lib/doc-files.ts) — only this spec is the AP invoice's.
// ----------------------------------------------------------------------------

import { scopeToCompany } from '../lib/companyScope';
import { makeDocFileHandlers, type DocFilesSpec } from '../lib/doc-files';

type Row = Record<string, any>;

export const AP_INVOICE_FILES: DocFilesSpec = {
  table: 'acc_ap_invoice_files',
  fkColumn: 'ap_invoice_id',
  keyPrefix: 'ap-invoice-files',
  /* The keys that raise the bill (routes/ap-invoices.ts create) attach to it. */
  writePerms: ['scm.payment_voucher.create', 'scm.payment_voucher.write'],
  scanKind: null,
  load: async (c: any) => {
    const sb = c.get('supabase');
    const { data, error } = await scopeToCompany(
      sb.from('ap_invoices').select('id, invoice_number, status, paid_sen, company_id').eq('id', c.req.param('id')), c,
    ).maybeSingle();
    if (error) return { resp: c.json({ error: 'load_failed', reason: error.message }, 500) };
    if (!data) return { resp: c.json({ error: 'not_found', message: 'That AP invoice is not in the company you are working in.' }, 404) };
    const inv = data as Row;
    const closed = inv.status === 'CANCELLED';
    let locked = !closed && Number(inv.paid_sen ?? 0) > 0;
    if (!closed && !locked && inv.status !== 'DRAFT') {
      const { data: allocs, error: aErr } = await scopeToCompany(sb.from('pv_allocations').select('pv_id').eq('ap_invoice_id', inv.id), c);
      if (aErr) return { resp: c.json({ error: 'load_failed', reason: aErr.message }, 500) };
      const pvIds = [...new Set(((allocs ?? []) as Row[]).map((a) => String(a.pv_id)))];
      if (pvIds.length > 0) {
        const { data: pvs, error: pErr } = await scopeToCompany(
          sb.from('payment_vouchers').select('id').in('id', pvIds).neq('status', 'CANCELLED').not('checked_at', 'is', null), c,
        );
        if (pErr) return { resp: c.json({ error: 'load_failed', reason: pErr.message }, 500) };
        locked = ((pvs ?? []) as Row[]).length > 0;
      }
    }
    return { doc: { id: String(inv.id), closed, locked } };
  },
  closedRefusal: { error: 'invoice_cancelled', message: 'A cancelled bill takes no more evidence.' },
  lockedRefusal: { error: 'evidence_locked', message: 'An AP Payment already holds this bill (paid, or its voucher is checked) — its files print with that payment, so they stay. Attach the right file beside it.' },
};

const handlers = makeDocFileHandlers(AP_INVOICE_FILES);
export const uploadApInvoiceFileHandler = handlers.upload;
export const listApInvoiceFilesHandler = handlers.list;
export const streamApInvoiceFileHandler = handlers.stream;
export const deleteApInvoiceFileHandler = handlers.remove;
