/* eslint-disable @typescript-eslint/no-explicit-any -- the untyped supabase-js client and Hono context this SCM tree passes around (see companyScope.ts header). */
// ----------------------------------------------------------------------------
// Files on the receiving and return documents — the supplier's DO beside its
// Goods Received, the invoice scan beside its Purchase Invoice, damage photos
// beside a Delivery Return or a Purchase Return (backlog A3, sister
// Houzs-IT/Conts-ERP#278). The voucher, AP invoice and credit note already
// keep their paper this way; these four reuse the same factory
// (lib/doc-files.ts) with one spec each.
//
//   POST   /<doc>/:id/files          {fileName, mime, dataBase64}
//   GET    /<doc>/:id/files          the index rows + `locked`
//   GET    /<doc>/:id/files/:fileId  streams the bytes from R2
//   DELETE /<doc>/:id/files/:fileId  until the document is finished
//
// Keys: <keyPrefix>/<company>/<doc>/<uuid>.<ext> in the SLIPS bucket. Index
// tables scm.grn_files / purchase_invoice_files / delivery_return_files /
// purchase_return_files (20261110T0300).
//
// Who may write: these four documents carry no flat permission key — their
// own edits are gated by scmAreaGuard (`edit` on the area for any write) in
// scm/index.ts, which runs before these routers. Attaching rides that same
// gate, so `mayWrite` admits whoever the guard let through.
//
// When a file stops being removable: when the document is FINISHED — paid,
// completed, refunded, closed. Not at posting: a GRN and a Purchase Return are
// born posted, so locking there would make a wrongly attached photo permanent
// from the first second (the AP invoice learned the same, HC-0181). CANCELLED
// takes no more files on every one of them.
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import type { Env, Variables } from '../env';
import { supabaseAuth } from '../middleware/auth';
import { scopeToCompany } from '../lib/companyScope';
import { makeDocFileHandlers, type DocFilesSpec } from '../lib/doc-files';
import { canViewAllSales } from '../lib/houzs-perms';
import { salesDocOutOfScope } from '../lib/salesScope';

type Row = Record<string, any>;

const up = (v: unknown): string => String(v ?? '').trim().toUpperCase();
const areaGated = (): boolean => true;

type LoadOpts = { table: string; select: string; noun: string; finished: readonly string[]; salesScoped: boolean };

const loader = (o: LoadOpts): DocFilesSpec['load'] => async (c: any) => {
  const sb = c.get('supabase');
  const { data, error } = await scopeToCompany(sb.from(o.table).select(o.select).eq('id', c.req.param('id')), c).maybeSingle();
  if (error) return { resp: c.json({ error: 'load_failed', reason: error.message }, 500) };
  if (!data) return { resp: c.json({ error: 'not_found', message: `That ${o.noun} is not in the company you are working in.` }, 404) };
  const row = data as Row;
  /* The delivery return's own GET hides another salesperson's return (404);
     its files must not be the side door. */
  if (o.salesScoped && await salesDocOutOfScope(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c), row.salesperson_id)) {
    return { resp: c.json({ error: 'not_found' }, 404) };
  }
  const status = up(row.status);
  return { doc: { id: String(row.id), closed: status === 'CANCELLED', locked: o.finished.includes(status), status } };
};

export const GRN_FILES: DocFilesSpec = {
  table: 'grn_files',
  fkColumn: 'grn_id',
  keyPrefix: 'grn-files',
  writePerms: [],
  mayWrite: areaGated,
  scanKind: null,
  load: loader({ table: 'grns', select: 'id, status', noun: 'goods received note', finished: ['CLOSED'], salesScoped: false }),
  closedRefusal: { error: 'grn_cancelled', message: 'A cancelled goods received note takes no more files.' },
  lockedRefusal: { error: 'evidence_locked', message: 'The goods received note is closed — its files stay.' },
};

export const PURCHASE_INVOICE_FILES: DocFilesSpec = {
  table: 'purchase_invoice_files',
  fkColumn: 'purchase_invoice_id',
  keyPrefix: 'purchase-invoice-files',
  writePerms: [],
  mayWrite: areaGated,
  scanKind: null,
  load: loader({ table: 'purchase_invoices', select: 'id, status', noun: 'purchase invoice', finished: ['PARTIALLY_PAID', 'PAID'], salesScoped: false }),
  closedRefusal: { error: 'invoice_cancelled', message: 'A cancelled purchase invoice takes no more files.' },
  lockedRefusal: { error: 'evidence_locked', message: 'Money has been paid against this invoice — its files stay.' },
};

export const DELIVERY_RETURN_FILES: DocFilesSpec = {
  table: 'delivery_return_files',
  fkColumn: 'delivery_return_id',
  keyPrefix: 'delivery-return-files',
  writePerms: [],
  mayWrite: areaGated,
  scanKind: null,
  load: loader({ table: 'delivery_returns', select: 'id, status, salesperson_id', noun: 'delivery return', finished: ['REFUNDED', 'CREDIT_NOTED', 'REJECTED'], salesScoped: true }),
  closedRefusal: { error: 'return_cancelled', message: 'A cancelled delivery return takes no more files.' },
  lockedRefusal: { error: 'evidence_locked', message: 'The return is finished (refunded, credited or rejected) — its files stay.' },
};

export const PURCHASE_RETURN_FILES: DocFilesSpec = {
  table: 'purchase_return_files',
  fkColumn: 'purchase_return_id',
  keyPrefix: 'purchase-return-files',
  writePerms: [],
  mayWrite: areaGated,
  scanKind: null,
  load: loader({ table: 'purchase_returns', select: 'id, status', noun: 'purchase return', finished: ['COMPLETED'], salesScoped: false }),
  closedRefusal: { error: 'return_cancelled', message: 'A cancelled purchase return takes no more files.' },
  lockedRefusal: { error: 'evidence_locked', message: 'The return is completed — its files stay.' },
};

/* Spelled out per router, not built in a loop: the route capability matrix
   (scripts/generate-route-capability-matrix.mjs) reads each route from its
   literal registration. The '*' bridge runs on every request to the
   document's prefix, ahead of the document's own router; it is idempotent
   (middleware/auth.ts), the same as grns-list-enrichment's on /grns. */
type R = Hono<{ Bindings: Env; Variables: Variables }>;
const withAuth = (r: R): R => { r.use('*', supabaseAuth); return r; };

const grnFilesH = makeDocFileHandlers(GRN_FILES);
export const grnFiles: R = withAuth(new Hono());
const uploadGrnFiles = grnFilesH.upload;
const listGrnFiles = grnFilesH.list;
const streamGrnFiles = grnFilesH.stream;
const removeGrnFiles = grnFilesH.remove;
grnFiles.post('/:id/files', uploadGrnFiles);
grnFiles.get('/:id/files', listGrnFiles);
grnFiles.get('/:id/files/:fileId', streamGrnFiles);
grnFiles.delete('/:id/files/:fileId', removeGrnFiles);

const purchaseInvoiceFilesH = makeDocFileHandlers(PURCHASE_INVOICE_FILES);
export const purchaseInvoiceFiles: R = withAuth(new Hono());
const uploadPurchaseInvoiceFiles = purchaseInvoiceFilesH.upload;
const listPurchaseInvoiceFiles = purchaseInvoiceFilesH.list;
const streamPurchaseInvoiceFiles = purchaseInvoiceFilesH.stream;
const removePurchaseInvoiceFiles = purchaseInvoiceFilesH.remove;
purchaseInvoiceFiles.post('/:id/files', uploadPurchaseInvoiceFiles);
purchaseInvoiceFiles.get('/:id/files', listPurchaseInvoiceFiles);
purchaseInvoiceFiles.get('/:id/files/:fileId', streamPurchaseInvoiceFiles);
purchaseInvoiceFiles.delete('/:id/files/:fileId', removePurchaseInvoiceFiles);

const deliveryReturnFilesH = makeDocFileHandlers(DELIVERY_RETURN_FILES);
export const deliveryReturnFiles: R = withAuth(new Hono());
const uploadDeliveryReturnFiles = deliveryReturnFilesH.upload;
const listDeliveryReturnFiles = deliveryReturnFilesH.list;
const streamDeliveryReturnFiles = deliveryReturnFilesH.stream;
const removeDeliveryReturnFiles = deliveryReturnFilesH.remove;
deliveryReturnFiles.post('/:id/files', uploadDeliveryReturnFiles);
deliveryReturnFiles.get('/:id/files', listDeliveryReturnFiles);
deliveryReturnFiles.get('/:id/files/:fileId', streamDeliveryReturnFiles);
deliveryReturnFiles.delete('/:id/files/:fileId', removeDeliveryReturnFiles);

const purchaseReturnFilesH = makeDocFileHandlers(PURCHASE_RETURN_FILES);
export const purchaseReturnFiles: R = withAuth(new Hono());
const uploadPurchaseReturnFiles = purchaseReturnFilesH.upload;
const listPurchaseReturnFiles = purchaseReturnFilesH.list;
const streamPurchaseReturnFiles = purchaseReturnFilesH.stream;
const removePurchaseReturnFiles = purchaseReturnFilesH.remove;
purchaseReturnFiles.post('/:id/files', uploadPurchaseReturnFiles);
purchaseReturnFiles.get('/:id/files', listPurchaseReturnFiles);
purchaseReturnFiles.get('/:id/files/:fileId', streamPurchaseReturnFiles);
purchaseReturnFiles.delete('/:id/files/:fileId', removePurchaseReturnFiles);
