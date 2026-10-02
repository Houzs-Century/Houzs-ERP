// ----------------------------------------------------------------------------
// /supplier-maintenance — Finance's own supplier list (owner 2026-10-02:
// A1 「放在 money out 的 sidebar，supplier maintenance」; A2a a supplier Finance
// opens is Finance's alone; A3a the supplier's bank, which a payment carries).
//
//   GET /      every supplier of the active company — purchasing's and the ones
//              Finance keeps to itself — with what the books say is owed to it,
//              its unspent advance, its credit notes' unused credit, and its open
//              invoices
//   GET /:id   one supplier: the record, its open invoices (purchase invoices and
//              AP invoices), its advances, its credit notes with credit left, and
//              its latest payments
//
// Reads only. The record is opened and changed through /suppliers, which owns
// the rules: the Finance part — bank and the purchasing tick included — is
// Finance's (shared/supplier-finance-fields), and only Finance changes a code.
// A caller who is not Finance reads this list without the Finance part.
//
// "Owed" is the supplier's balance in the books: credit less debit on its lines
// on the AP control accounts (acc/party-ledger.ts), the same reader the AP Aging
// uses. A purchase invoice brought over from AutoCount (migrated_no_stock) books
// nothing, so it shows among the open invoices, marked, and is not in "owed".
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { requireActiveCompanyId } from '../lib/companyScope';
import { paginateAll } from '../lib/paginate-all';
import { toMyrSen } from '../lib/fx';
import { isSupplierFinanceCaller } from '../lib/supplier-finance';
import { withoutSupplierFinance } from '../shared/supplier-finance-fields';
import { SUPPLIER_COLS } from './suppliers';
import { apControlRole, resolveRoles } from '../../acc/rules';
import { creditorBalances, loadControlLines } from '../../acc/party-ledger';

/* eslint-disable @typescript-eslint/no-explicit-any -- PostgREST client, untyped in this router family */
type Row = Record<string, any>;

export const supplierMaintenance = new Hono<{ Bindings: Env; Variables: Variables }>();
supplierMaintenance.use('*', supabaseAuth);

/* An invoice still owing: posted and not paid down, or held (still owed). */
const OPEN_PI = ['POSTED', 'PARTIALLY_PAID', 'ON_HOLD'];
const OPEN_API = ['POSTED', 'PARTIALLY_PAID'];

const LIST_COLS = 'id, code, name, status, currency, payment_terms, tin_number, business_reg_no, registration_no, '
  + 'for_purchasing, bank_name, bank_account_no, bank_account_name';

/** The row keys that carry the Finance part on this list — what a caller who is
    not Finance does not read (the same fields shared/supplier-finance-fields names). */
const FINANCE_ROW_KEYS = ['tinNumber', 'businessRegNo', 'registrationNo', 'bankName', 'bankAccountNo', 'bankAccountName', 'forPurchasing'] as const;

const blank = (v: unknown) => !String(v ?? '').trim();

type OpenInvoice = {
  kind: 'PI' | 'API';
  id: string;
  number: string;
  supplierRef: string | null;
  date: string | null;
  dueDate: string | null;
  currency: string;
  totalSen: number;
  outstandingSen: number;
  /** In MYR — a foreign purchase invoice converted at its own rate. */
  outstandingMyrSen: number;
  status: string;
  /** Brought over from AutoCount: never booked here, so not in "owed". */
  preErp: boolean;
};

const piOpen = (r: Row): OpenInvoice => {
  const out = Number(r.total_sen ?? 0) - Number(r.paid_sen ?? 0);
  return {
    kind: 'PI', id: String(r.id), number: String(r.invoice_number ?? ''), supplierRef: r.supplier_invoice_ref ?? null,
    date: r.invoice_date ?? null, dueDate: r.due_date ?? null, currency: String(r.currency ?? 'MYR'),
    totalSen: Number(r.total_sen ?? 0), outstandingSen: out, outstandingMyrSen: toMyrSen(out, r.exchange_rate),
    status: String(r.status ?? ''), preErp: r.migrated_no_stock === true,
  };
};
const apiOpen = (r: Row): OpenInvoice => {
  const out = Number(r.total_sen ?? 0) - Number(r.paid_sen ?? 0);
  return {
    kind: 'API', id: String(r.id), number: String(r.invoice_number ?? ''), supplierRef: r.supplier_invoice_ref ?? null,
    date: r.invoice_date ?? null, dueDate: r.due_date ?? null, currency: 'MYR',
    totalSen: Number(r.total_sen ?? 0), outstandingSen: out, outstandingMyrSen: out,
    status: String(r.status ?? ''), preErp: false,
  };
};

/* ── GET / ─────────────────────────────────────────────────────────────────── */
export const listSupplierMaintenanceHandler = async (c: any): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const companyId = co.companyId;
  const finance = isSupplierFinanceCaller(c);
  const roles = await resolveRoles(sb, companyId);

  const [sups, gl, pis, apis, advances, notes, allocs] = await Promise.all([
    paginateAll((f, t) => sb.from('suppliers').select(LIST_COLS).eq('company_id', companyId).order('name').order('id').range(f, t)),
    loadControlLines(sb, companyId, [roles.AP, roles.AP_OTHER]),
    paginateAll((f, t) => sb.from('purchase_invoices').select('id, supplier_id, total_sen, paid_sen, exchange_rate, status, migrated_no_stock')
      .eq('company_id', companyId).in('status', OPEN_PI).order('id').range(f, t)),
    paginateAll((f, t) => sb.from('ap_invoices').select('id, supplier_id, total_sen, paid_sen, status')
      .eq('company_id', companyId).in('status', OPEN_API).order('id').range(f, t)),
    paginateAll((f, t) => sb.from('acc_supplier_advances').select('id, supplier_id, amount_sen, applied_sen')
      .eq('company_id', companyId).order('id').range(f, t)),
    paginateAll((f, t) => sb.from('acc_credit_notes').select('id, supplier_id, total_sen')
      .eq('company_id', companyId).eq('kind', 'SCN').eq('status', 'POSTED').order('id').range(f, t)),
    paginateAll((f, t) => sb.from('acc_credit_note_allocations').select('id, note_id, applied_sen')
      .eq('company_id', companyId).order('id').range(f, t)),
  ]);
  const failed = sups.error ?? pis.error ?? apis.error ?? advances.error ?? notes.error ?? allocs.error;
  if (failed) return c.json({ error: 'load_failed', reason: (failed as { message?: string }).message ?? String(failed) }, 500);
  if (!gl.ok) return c.json({ error: 'load_failed', reason: gl.reason }, 500);

  const owed = creditorBalances(gl.lines);
  const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);

  const openCount = new Map<string, number>();
  const openSen = new Map<string, number>();
  const preErpSen = new Map<string, number>();
  for (const r of (pis.data ?? []) as Row[]) {
    const inv = piOpen(r);
    if (inv.outstandingSen <= 0) continue;
    const sid = String(r.supplier_id);
    add(openCount, sid, 1);
    add(inv.preErp ? preErpSen : openSen, sid, inv.outstandingMyrSen);
  }
  for (const r of (apis.data ?? []) as Row[]) {
    const inv = apiOpen(r);
    if (inv.outstandingSen <= 0) continue;
    const sid = String(r.supplier_id);
    add(openCount, sid, 1);
    add(openSen, sid, inv.outstandingMyrSen);
  }
  const advanceSen = new Map<string, number>();
  for (const a of (advances.data ?? []) as Row[]) {
    const left = Number(a.amount_sen ?? 0) - Number(a.applied_sen ?? 0);
    if (left > 0) add(advanceSen, String(a.supplier_id), left);
  }
  const takenByNote = new Map<string, number>();
  for (const a of (allocs.data ?? []) as Row[]) add(takenByNote, String(a.note_id), Number(a.applied_sen ?? 0));
  const creditSen = new Map<string, number>();
  for (const n of (notes.data ?? []) as Row[]) {
    const left = Number(n.total_sen ?? 0) - (takenByNote.get(String(n.id)) ?? 0);
    if (left > 0 && n.supplier_id) add(creditSen, String(n.supplier_id), left);
  }

  const rows = ((sups.data ?? []) as Row[]).map((s) => {
    const id = String(s.id);
    const code = String(s.code ?? '');
    const other = apControlRole(code) === 'AP_OTHER';
    const row: Row = {
      id, code, name: String(s.name ?? ''), status: String(s.status ?? ''),
      currency: String(s.currency ?? 'MYR'), paymentTerms: s.payment_terms ?? null,
      controlKind: other ? 'OTHER' : 'TRADE',
      controlCode: other ? roles.AP_OTHER : roles.AP,
      tinNumber: s.tin_number ?? null, businessRegNo: s.business_reg_no ?? null, registrationNo: s.registration_no ?? null,
      missingTax: blank(s.tin_number) || (blank(s.registration_no) && blank(s.business_reg_no)),
      bankName: s.bank_name ?? null, bankAccountNo: s.bank_account_no ?? null, bankAccountName: s.bank_account_name ?? null,
      forPurchasing: s.for_purchasing !== false,
      owedSen: owed.get(code) ?? 0,
      advanceSen: advanceSen.get(id) ?? 0,
      creditSen: creditSen.get(id) ?? 0,
      openInvoices: openCount.get(id) ?? 0,
      openSen: openSen.get(id) ?? 0,
      preErpSen: preErpSen.get(id) ?? 0,
    };
    if (!finance) {
      for (const k of FINANCE_ROW_KEYS) delete row[k];
      delete row.missingTax;
    }
    return row;
  });
  return c.json({ rows, finance, controls: { trade: roles.AP, other: roles.AP_OTHER } });
};
supplierMaintenance.get('/', listSupplierMaintenanceHandler);

/* ── GET /:id ──────────────────────────────────────────────────────────────── */
export const getSupplierMaintenanceHandler = async (c: any): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const companyId = co.companyId;
  const id = String(c.req.param('id'));
  const finance = isSupplierFinanceCaller(c);

  const { data: sup, error: supErr } = await sb.from('suppliers').select(SUPPLIER_COLS).eq('company_id', companyId).eq('id', id).maybeSingle();
  if (supErr) return c.json({ error: 'load_failed', reason: supErr.message }, 500);
  if (!sup) return c.json({ error: 'not_found', message: 'That supplier is not in the company you are working in.' }, 404);
  const supplier = sup as Row;
  const code = String(supplier.code ?? '');
  const roles = await resolveRoles(sb, companyId);
  const controlCode = apControlRole(code) === 'AP_OTHER' ? roles.AP_OTHER : roles.AP;

  const [gl, pis, apis, advances, notes, pvs] = await Promise.all([
    loadControlLines(sb, companyId, [roles.AP, roles.AP_OTHER]),
    sb.from('purchase_invoices')
      .select('id, invoice_number, supplier_invoice_ref, invoice_date, due_date, currency, exchange_rate, total_sen, paid_sen, status, migrated_no_stock')
      .eq('company_id', companyId).eq('supplier_id', id).in('status', OPEN_PI),
    sb.from('ap_invoices')
      .select('id, invoice_number, supplier_invoice_ref, invoice_date, due_date, total_sen, paid_sen, status')
      .eq('company_id', companyId).eq('supplier_id', id).in('status', OPEN_API),
    sb.from('acc_supplier_advances').select('id, pv_id, pv_number, amount_sen, applied_sen, created_at')
      .eq('company_id', companyId).eq('supplier_id', id),
    sb.from('acc_credit_notes').select('id, note_number, note_date, total_sen')
      .eq('company_id', companyId).eq('supplier_id', id).eq('kind', 'SCN').eq('status', 'POSTED'),
    sb.from('payment_vouchers').select('id, pv_number, voucher_date, total_sen, currency, exchange_rate, status, purpose')
      .eq('company_id', companyId).eq('supplier_id', id).order('voucher_date', { ascending: false }).limit(10),
  ]);
  const failed = pis.error ?? apis.error ?? advances.error ?? notes.error ?? pvs.error;
  if (failed) return c.json({ error: 'load_failed', reason: failed.message ?? String(failed) }, 500);
  if (!gl.ok) return c.json({ error: 'load_failed', reason: gl.reason }, 500);

  const noteRows = (notes.data ?? []) as Row[];
  const taken = new Map<string, number>();
  if (noteRows.length > 0) {
    const { data: allocs, error: allocErr } = await sb.from('acc_credit_note_allocations').select('note_id, applied_sen')
      .eq('company_id', companyId).in('note_id', noteRows.map((n) => String(n.id)));
    if (allocErr) return c.json({ error: 'load_failed', reason: allocErr.message }, 500);
    for (const a of (allocs ?? []) as Row[]) taken.set(String(a.note_id), (taken.get(String(a.note_id)) ?? 0) + Number(a.applied_sen ?? 0));
  }

  const openInvoices = [
    ...((pis.data ?? []) as Row[]).map(piOpen),
    ...((apis.data ?? []) as Row[]).map(apiOpen),
  ].filter((i) => i.outstandingSen > 0)
    .sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')) || a.number.localeCompare(b.number));
  const advanceRows = ((advances.data ?? []) as Row[])
    .map((a) => ({ pvId: String(a.pv_id), pvNumber: String(a.pv_number ?? ''), date: String(a.created_at ?? '').slice(0, 10), leftSen: Number(a.amount_sen ?? 0) - Number(a.applied_sen ?? 0) }))
    .filter((a) => a.leftSen > 0);
  const credits = noteRows
    .map((n) => ({ id: String(n.id), noteNumber: String(n.note_number ?? ''), date: n.note_date ?? null, leftSen: Number(n.total_sen ?? 0) - (taken.get(String(n.id)) ?? 0) }))
    .filter((n) => n.leftSen > 0);
  const payments = ((pvs.data ?? []) as Row[]).map((v) => ({
    id: String(v.id), pvNumber: v.pv_number ?? null, date: v.voucher_date ?? null, purpose: String(v.purpose ?? ''),
    status: String(v.status ?? ''), totalSen: Number(v.total_sen ?? 0), totalMyrSen: toMyrSen(Number(v.total_sen ?? 0), v.exchange_rate),
  }));
  const balanceSen = creditorBalances(gl.lines.filter((l) => l.party_code === code)).get(code) ?? 0;

  return c.json({
    supplier: finance ? supplier : withoutSupplierFinance(supplier),
    finance,
    controlCode,
    balanceSen,
    openInvoices,
    advances: advanceRows,
    credits,
    payments,
  });
};
supplierMaintenance.get('/:id', getSupplierMaintenanceHandler);
