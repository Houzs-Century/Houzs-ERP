// ----------------------------------------------------------------------------
// GET /ap-invoices/duplicate-bills — the supplier bills booked more than once.
//
// New ones are refused since #5535; this lists the copies that were already in
// the books (read-only check, run 42747928164: 9 AP-invoice and 2 purchase-
// invoice bill numbers booked twice in company 1). Document numbers cannot go
// to the public Actions log, so Finance reviews them here and cancels the wrong
// copy on its own screen. No writes. Each copy carries what paid or knocked it
// off, because the costly case is a bill paid twice.
// ----------------------------------------------------------------------------

import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId, scopeToCompany } from '../lib/companyScope';
import { chunkIn, paginateAll } from '../lib/paginate-all';
import { groupDuplicateBills, type BillRow } from '../lib/duplicate-supplier-bill-groups';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SCM PostgREST client and Hono context are untyped everywhere they are passed
type Row = Record<string, any>;

/* The keys that raise, post and cancel supplier bills (ap-invoices.ts): the
   people who can act on what this list shows. */
const REVIEW_KEYS = ['scm.payment_voucher.create', 'scm.payment_voucher.write', 'scm.payment_voucher.post', 'scm.payment_voucher.cancel'];

type Settlement = { kind: 'PV' | 'CN'; id: string; number: string; status: string; amountSen: number };
type Copy = BillRow & { invoiceNumber: string; invoiceDate: string | null; currency: string; totalSen: number; paidSen: number; settlements: Settlement[] };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SCM PostgREST client and Hono context are untyped everywhere they are passed
export const listDuplicateSupplierBillsHandler = async (c: any): Promise<Response> => {
  if (!REVIEW_KEYS.some((k) => hasHouzsPerm(c, k))) {
    return c.json({ error: "You don't have permission to review supplier bills." }, 403);
  }
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');

  const read = (table: 'purchase_invoices' | 'ap_invoices') => paginateAll<Row>((from, to) => scopeToCompany(
    sb.from(table).select(`id, company_id, invoice_number, supplier_id, supplier_invoice_ref, invoice_date, currency, total_sen, paid_sen, status${table === 'ap_invoices' ? ', doc_kind' : ''}`)
      .neq('status', 'CANCELLED').not('supplier_invoice_ref', 'is', null), c,
  ).order('id', { ascending: true }).range(from, to));
  const [pis, apis] = await Promise.all([read('purchase_invoices'), read('ap_invoices')]);
  if (pis.error) return c.json({ error: 'load_failed', reason: pis.error.message }, 500);
  if (apis.error) return c.json({ error: 'load_failed', reason: apis.error.message }, 500);

  const toCopy = (table: 'purchase_invoices' | 'ap_invoices') => (r: Row): Copy => ({
    table, id: String(r.id), companyId: Number(r.company_id), supplierId: r.supplier_id == null ? null : String(r.supplier_id),
    supplierInvoiceRef: r.supplier_invoice_ref ?? null,
    docKind: table === 'ap_invoices' && String(r.doc_kind ?? 'INV').toUpperCase() === 'DN' ? 'DN' : 'INV',
    status: String(r.status ?? ''), invoiceNumber: String(r.invoice_number ?? ''), invoiceDate: r.invoice_date ?? null,
    currency: String(r.currency ?? 'MYR'), totalSen: Number(r.total_sen ?? 0), paidSen: Number(r.paid_sen ?? 0), settlements: [],
  });
  const groups = groupDuplicateBills<Copy>([
    ...(pis.data ?? []).map(toCopy('purchase_invoices')),
    ...(apis.data ?? []).map(toCopy('ap_invoices')),
  ]);
  if (groups.length === 0) return c.json({ groups: [] });

  const copies = groups.flatMap((g) => g.rows);
  const piIds = copies.filter((r) => r.table === 'purchase_invoices').map((r) => r.id);
  const apiIds = copies.filter((r) => r.table === 'ap_invoices').map((r) => r.id);
  const supplierIds = [...new Set(groups.map((g) => g.supplierId))];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SCM PostgREST client and Hono context are untyped everywhere they are passed
  const pick = <T,>(ids: string[], q: (batch: string[]) => any) =>
    chunkIn<Row>(ids, (batch, from, to) => q(batch).range(from, to)) as Promise<{ data: T[]; error: { message: string } | null }>;
  const [pvPi, pvApi, cnPi, cnApi, sups] = await Promise.all([
    pick<Row>(piIds, (b) => scopeToCompany(sb.from('pv_allocations').select('id, pv_id, pi_id, amount_sen'), c).in('pi_id', b)),
    pick<Row>(apiIds, (b) => scopeToCompany(sb.from('pv_allocations').select('id, pv_id, ap_invoice_id, amount_sen'), c).in('ap_invoice_id', b)),
    pick<Row>(piIds, (b) => scopeToCompany(sb.from('acc_credit_note_allocations').select('id, note_id, purchase_invoice_id, amount_sen, applied_sen'), c).in('purchase_invoice_id', b)),
    pick<Row>(apiIds, (b) => scopeToCompany(sb.from('acc_credit_note_allocations').select('id, note_id, ap_invoice_id, amount_sen, applied_sen'), c).in('ap_invoice_id', b)),
    pick<Row>(supplierIds, (b) => scopeToCompany(sb.from('suppliers').select('id, code, name'), c).in('id', b)),
  ]);
  for (const r of [pvPi, pvApi, cnPi, cnApi, sups]) if (r.error) return c.json({ error: 'load_failed', reason: r.error.message }, 500);

  const pvAllocs = [...pvPi.data, ...pvApi.data];
  const cnAllocs = [...cnPi.data, ...cnApi.data];
  const [pvs, notes] = await Promise.all([
    pick<Row>([...new Set(pvAllocs.map((a) => String(a.pv_id)))], (b) => scopeToCompany(sb.from('payment_vouchers').select('id, pv_number, status'), c).in('id', b)),
    pick<Row>([...new Set(cnAllocs.map((a) => String(a.note_id)))], (b) => scopeToCompany(sb.from('acc_credit_notes').select('id, note_number, status'), c).in('id', b)),
  ]);
  if (pvs.error) return c.json({ error: 'load_failed', reason: pvs.error.message }, 500);
  if (notes.error) return c.json({ error: 'load_failed', reason: notes.error.message }, 500);
  const pvById = new Map(pvs.data.map((p) => [String(p.id), p]));
  const noteById = new Map(notes.data.map((n) => [String(n.id), n]));

  const copyFor = new Map(copies.map((r) => [`${r.table}:${r.id}`, r]));
  for (const a of pvAllocs) {
    const pv = pvById.get(String(a.pv_id));
    const target = a.pi_id != null ? `purchase_invoices:${a.pi_id}` : `ap_invoices:${a.ap_invoice_id}`;
    /* A cancelled voucher paid nothing; showing it would read as a payment. */
    if (!pv || String(pv.status).toUpperCase() === 'CANCELLED') continue;
    copyFor.get(target)?.settlements.push({ kind: 'PV', id: String(a.pv_id), number: String(pv.pv_number ?? ''), status: String(pv.status), amountSen: Number(a.amount_sen ?? 0) });
  }
  for (const a of cnAllocs) {
    const note = noteById.get(String(a.note_id));
    const target = a.purchase_invoice_id != null ? `purchase_invoices:${a.purchase_invoice_id}` : `ap_invoices:${a.ap_invoice_id}`;
    if (!note || String(note.status).toUpperCase() === 'CANCELLED') continue;
    const posted = String(note.status).toUpperCase() === 'POSTED';
    copyFor.get(target)?.settlements.push({ kind: 'CN', id: String(a.note_id), number: String(note.note_number ?? ''), status: String(note.status), amountSen: Number((posted ? a.applied_sen : a.amount_sen) ?? 0) });
  }

  const supById = new Map(sups.data.map((s) => [String(s.id), s]));
  const out = groups.map((g) => {
    const sup = supById.get(g.supplierId);
    const rows = [...g.rows].sort((a, b) => String(a.invoiceDate ?? '').localeCompare(String(b.invoiceDate ?? '')) || a.invoiceNumber.localeCompare(b.invoiceNumber));
    return {
      kind: g.table === 'purchase_invoices' ? 'PI' : 'API',
      docKind: g.docKind,
      supplierId: g.supplierId,
      supplierCode: sup?.code ?? null,
      supplierName: sup?.name ?? null,
      billKey: g.billKey,
      /* More than one copy has money against it: the double-payment case. */
      paidMoreThanOnce: rows.filter((r) => r.paidSen > 0 || r.settlements.length > 0).length > 1,
      copies: rows.map((r) => ({
        id: r.id, invoiceNumber: r.invoiceNumber, supplierInvoiceRef: r.supplierInvoiceRef, invoiceDate: r.invoiceDate,
        currency: r.currency, totalSen: r.totalSen, paidSen: r.paidSen, status: r.status, settlements: r.settlements,
      })),
    };
  }).sort((a, b) => Number(b.paidMoreThanOnce) - Number(a.paidMoreThanOnce) || String(a.supplierName ?? '').localeCompare(String(b.supplierName ?? '')) || a.billKey.localeCompare(b.billKey));
  return c.json({ groups: out });
};
