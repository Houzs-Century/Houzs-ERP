// ----------------------------------------------------------------------------
// AP invoice attachments — the supplier's bill LIVES with the AP invoice, the
// way the scanned bill lives with its voucher (owner 2026-09-06, told the AP
// invoice had neither OCR nor files: 做,附件也一起做,bundle 也带上).
//
//   POST   /ap-invoices/:id/files          {fileName, mime, dataBase64}
//   GET    /ap-invoices/:id/files          the index rows
//   GET    /ap-invoices/:id/files/:fileId  streams the bytes from R2
//   DELETE /ap-invoices/:id/files/:fileId  while DRAFT — a POSTED bill's
//          evidence stays (the PV locks at CHECKED; an AP invoice has no
//          check layer, so the ledger is its lock). A CANCELLED bill takes
//          no more evidence; a posted one may still receive its scan.
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
  load: async (c: any) => {
    const sb = c.get('supabase');
    const { data, error } = await scopeToCompany(
      sb.from('ap_invoices').select('id, invoice_number, status, company_id').eq('id', c.req.param('id')), c,
    ).maybeSingle();
    if (error) return { resp: c.json({ error: 'load_failed', reason: error.message }, 500) };
    if (!data) return { resp: c.json({ error: 'not_found', message: 'That AP invoice is not in the company you are working in.' }, 404) };
    const inv = data as Row;
    return { doc: { id: String(inv.id), closed: inv.status === 'CANCELLED', locked: inv.status !== 'DRAFT' && inv.status !== 'CANCELLED' } };
  },
  closedRefusal: { error: 'invoice_cancelled', message: 'A cancelled bill takes no more evidence.' },
  lockedRefusal: { error: 'evidence_locked', message: 'The bill is posted — its evidence stays.' },
};

const handlers = makeDocFileHandlers(AP_INVOICE_FILES);
export const uploadApInvoiceFileHandler = handlers.upload;
export const listApInvoiceFilesHandler = handlers.list;
export const streamApInvoiceFileHandler = handlers.stream;
export const deleteApInvoiceFileHandler = handlers.remove;
