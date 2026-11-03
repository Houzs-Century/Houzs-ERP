// ----------------------------------------------------------------------------
// acc/control-check — reconciliation layer 1 (brief 3.5): each control account
// against the documents that are supposed to explain it, named to the doc;
// money on a document that never reached the ledger; payments that stopped
// agreeing with their entry. Lifted out of GET /accounting/control-check
// (accounting.ts) so Self-check's Run again and the nightly run read the same
// thing the page does (the owner's redesign, batch 6 c2/c3). Reads only.
//
// For each control role (AR from SI documents, AP from PI and AP invoices) it
// reports DRIFT docs (document total != its ACTIVE journal total, including a
// confirmed doc with NO journal and a journal whose doc is gone) and FOREIGN
// lines (control-account lines from a source no rule maps there). Sums run over
// POSTED, non-reversed entries — the same predicate every balance view uses.
//
// Each drift row now says who it is with, the document's date, its active
// entry and the id its page opens by; each unbooked payment its customer and
// salesperson (batch 6 c2) — read in a handful of company-scoped reads.
// ----------------------------------------------------------------------------

import { chunkIn, paginateAll } from '../scm/lib/paginate-all';
import { safeRate, toMyrSen } from '../scm/lib/fx';
import { resolveRoles } from './rules';
import { CONVERT_SOURCE, paymentEntryDisagreements, unbookedPayments, type UnbookedPayment } from './payments';

type Db = any;
type Row = Record<string, any>;

export type ControlDrift = {
  docNo: string; docTotalSen: number; jeTotalSen: number; diffSen: number; note: string;
  /** The customer or supplier, the document's date, its active entry. */
  party: string | null; date: string | null; jeNo: string | null;
  /** Which page opens it, and by what id — null when the document is gone. */
  docKind: 'SI' | 'PI' | 'API' | null; docId: string | null;
};
export type ControlForeign = { jeNo: string; sourceType: string; debitSen: number; creditSen: number };
export type ControlCheckOk = { role: string; accountCode: string; glBalanceSen: number; driftDocs: ControlDrift[]; foreignLines: ControlForeign[]; ok: boolean };
export type ControlCheckErr = { role: string; accountCode: string; error: string };
export type ControlCheckRow = ControlCheckOk | ControlCheckErr;

export type UnbookedRow = UnbookedPayment & { customer: string | null; salesperson: string | null };
export type ControlCheckPayments = {
  since: string | null; rows: UnbookedRow[]; totalSen: number; ok: boolean; error?: string;
  neverBooked?: { count: number; totalSen: number; firstPaidOn: string | null; lastPaidOn: string | null };
};
export type ControlCheckDrift = { rows: unknown[]; scanned: number; ok: boolean; error?: string };
export type ControlCheckResult = { checks: ControlCheckRow[]; payments: ControlCheckPayments; paymentDrift: ControlCheckDrift };

const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v));
const dayOf = (v: unknown): string | null => (v == null || v === '' ? null : String(v).slice(0, 10));

/** Supplier names by id, in the company. */
async function supplierNames(sb: Db, companyId: number, ids: string[]): Promise<{ ok: true; names: Map<string, string> } | { ok: false; reason: string }> {
  const uniq = [...new Set(ids.filter(Boolean))];
  const rows = await chunkIn<Row>(uniq, (batch, lo, hi) => sb.from('suppliers')
    .select('id, name').eq('company_id', companyId).in('id', batch).order('id').range(lo, hi));
  if (rows.error) return { ok: false, reason: `suppliers: ${rows.error.message}` };
  return { ok: true, names: new Map(rows.data.filter((r) => r.name).map((r) => [String(r.id), String(r.name)])) };
}

/** Staff names by id (who sold it) — the salesperson's row, else the order's agent text. */
async function staffNames(sb: Db, ids: string[]): Promise<{ ok: true; names: Map<string, string> } | { ok: false; reason: string }> {
  const uniq = [...new Set(ids.filter(Boolean))];
  const rows = await chunkIn<Row>(uniq, (batch, lo, hi) => sb.from('staff').select('id, name').in('id', batch).order('id').range(lo, hi));
  if (rows.error) return { ok: false, reason: `staff: ${rows.error.message}` };
  return { ok: true, names: new Map(rows.data.filter((r) => r.name).map((r) => [String(r.id), String(r.name)])) };
}

async function runOne(sb: Db, companyId: number, role: 'AR' | 'AP' | 'AP_OTHER' | 'AR_OTHER', accountCode: string): Promise<ControlCheckRow> {
  const expectedSource = role === 'AR' ? 'SI' : 'PI';
  /* AP_OTHER (405-0000, the 2026-09-03 split) and AR_OTHER (305-0000, the
     Other Debtors module): the document↔journal drift walk below is
     per-DOCUMENT and control-agnostic — the AP arm already covers every PI
     once, and a debtor bill cannot exist without its journal (the create is
     atomic). These arms contribute what IS control-specific: the GL balance
     and any foreign line parked on the control. */
  const docDrift = role !== 'AP_OTHER' && role !== 'AR_OTHER';

  const jeByDoc = new Map<string, { jeTotal: number; jeNo: string | null }>();
  if (docDrift) {
    const { data: jes, error: jesErr } = await sb.from('journal_entries')
      .select('id, je_no, source_doc_no, total_debit_sen')
      .eq('company_id', companyId).eq('source_type', expectedSource)
      .eq('posted', true).eq('reversed', false);
    if (jesErr) return { role, accountCode, error: jesErr.message };
    for (const j of (jes ?? []) as Array<{ je_no: string | null; source_doc_no: string | null; total_debit_sen: number }>) {
      if (j.source_doc_no) jeByDoc.set(j.source_doc_no, { jeTotal: Number(j.total_debit_sen ?? 0), jeNo: str(j.je_no) });
    }
  }

  const drift: ControlDrift[] = [];
  type DocFacts = { party: string | null; date: string | null; docKind: ControlDrift['docKind']; docId: string | null };
  const NO_DOC: DocFacts = { party: null, date: null, docKind: null, docId: null };
  const push = (docNo: string, docTotalSen: number, jeTotalSen: number, note: string, jeNo: string | null, facts: DocFacts) =>
    drift.push({ docNo, docTotalSen, jeTotalSen, diffSen: jeTotalSen - docTotalSen, note, jeNo, ...facts });

  if (role === 'AR') {
    const { data: docs, error } = await sb.from('sales_invoices')
      .select('id, invoice_number, total_sen, status, migrated_no_stock, debtor_name, invoice_date')
      .eq('company_id', companyId);
    if (error) return { role, accountCode, error: error.message };
    for (const d of (docs ?? []) as Row[]) {
      const docNo = String(d.invoice_number);
      const s = String(d.status ?? '').toUpperCase();
      const je = jeByDoc.get(docNo);
      const facts: DocFacts = { party: str(d.debtor_name), date: dayOf(d.invoice_date), docKind: 'SI', docId: str(d.id) };
      if (d.migrated_no_stock === true || s === 'DRAFT' || s === 'CANCELLED') {
        if (je) push(docNo, 0, je.jeTotal, `journal active but document is ${d.migrated_no_stock ? 'migrated' : s}`, je.jeNo, facts);
        jeByDoc.delete(docNo);
        continue;
      }
      const docTotal = Number(d.total_sen ?? 0);
      if (!je) {
        if (docTotal > 0) push(docNo, docTotal, 0, 'document has no active journal', null, facts);
      } else {
        if (je.jeTotal !== docTotal) push(docNo, docTotal, je.jeTotal, 'journal total differs from document total', je.jeNo, facts);
        jeByDoc.delete(docNo);
      }
    }
  } else if (docDrift) {
    const { data: docs, error } = await sb.from('purchase_invoices')
      .select('id, invoice_number, total_sen, exchange_rate, status, migrated_no_stock, supplier_id, invoice_date')
      .eq('company_id', companyId);
    if (error) return { role, accountCode, error: error.message };
    const pis = (docs ?? []) as Row[];
    const sup = await supplierNames(sb, companyId, pis.map((d) => String(d.supplier_id ?? '')));
    if (!sup.ok) return { role, accountCode, error: sup.reason };
    for (const d of pis) {
      const docNo = String(d.invoice_number);
      const s = String(d.status ?? '').toUpperCase();
      const je = jeByDoc.get(docNo);
      const facts: DocFacts = { party: sup.names.get(String(d.supplier_id ?? '')) ?? null, date: dayOf(d.invoice_date), docKind: 'PI', docId: str(d.id) };
      if (d.migrated_no_stock === true || s === 'DRAFT' || s === 'CANCELLED') {
        if (je) push(docNo, 0, je.jeTotal, `journal active but document is ${d.migrated_no_stock ? 'migrated' : s}`, je.jeNo, facts);
        jeByDoc.delete(docNo);
        continue;
      }
      /* A confirmed PI with no active journal IS drift — the AR arm reports
         the identical shape (found live 2026-08-22: HC-PI-2608-002 and -003).
         `docTotal > 0` mirrors AR: a zero-value invoice has no journal. */
      const docTotal = toMyrSen(Number(d.total_sen ?? 0), safeRate(d.exchange_rate));
      if (!je) {
        if (docTotal > 0) push(docNo, docTotal, 0, 'document has no active journal', null, facts);
        continue;
      }
      if (je.jeTotal !== docTotal) push(docNo, docTotal, je.jeTotal, 'journal total differs from document total (MYR)', je.jeNo, facts);
      jeByDoc.delete(docNo);
    }
  }
  for (const [docNo, je] of jeByDoc) push(docNo, 0, je.jeTotal, 'journal active but document not found', je.jeNo, NO_DOC);

  /* AP INVOICES (the non-stock supplier bills, 2026-09-06) — source API, on
     either creditor control by the supplier's code. The AP arm walks them
     once, the same shape as the PIs above (docs/bugs/0654). */
  if (role === 'AP') {
    const { data: apiJes, error: apiJesErr } = await sb.from('journal_entries')
      .select('id, je_no, source_doc_no, total_debit_sen')
      .eq('company_id', companyId).eq('source_type', 'API')
      .eq('posted', true).eq('reversed', false);
    if (apiJesErr) return { role, accountCode, error: apiJesErr.message };
    const apiByDoc = new Map<string, { jeTotal: number; jeNo: string | null }>();
    for (const j of (apiJes ?? []) as Array<{ je_no: string | null; source_doc_no: string | null; total_debit_sen: number }>) {
      if (j.source_doc_no) apiByDoc.set(j.source_doc_no, { jeTotal: Number(j.total_debit_sen ?? 0), jeNo: str(j.je_no) });
    }
    const { data: bills, error: billsErr } = await sb.from('ap_invoices')
      .select('id, invoice_number, total_sen, status, supplier_id, invoice_date')
      .eq('company_id', companyId);
    if (billsErr) return { role, accountCode, error: billsErr.message };
    const list = (bills ?? []) as Row[];
    const sup = await supplierNames(sb, companyId, list.map((b) => String(b.supplier_id ?? '')));
    if (!sup.ok) return { role, accountCode, error: sup.reason };
    for (const b of list) {
      const docNo = String(b.invoice_number);
      const s = String(b.status ?? '').toUpperCase();
      const je = apiByDoc.get(docNo);
      const facts: DocFacts = { party: sup.names.get(String(b.supplier_id ?? '')) ?? null, date: dayOf(b.invoice_date), docKind: 'API', docId: str(b.id) };
      if (s === 'DRAFT' || s === 'CANCELLED') {
        if (je) push(docNo, 0, je.jeTotal, `journal active but document is ${s}`, je.jeNo, facts);
        apiByDoc.delete(docNo);
        continue;
      }
      const docTotal = Number(b.total_sen ?? 0);
      if (!je) {
        if (docTotal > 0) push(docNo, docTotal, 0, 'document has no active journal', null, facts);
        continue;
      }
      if (je.jeTotal !== docTotal) push(docNo, docTotal, je.jeTotal, 'journal total differs from document total', je.jeNo, facts);
      apiByDoc.delete(docNo);
    }
    for (const [docNo, je] of apiByDoc) push(docNo, 0, je.jeTotal, 'journal active but document not found', je.jeNo, NO_DOC);
  }

  const { data: lines, error: linesErr } = await paginateAll<Row>((from, to) =>
    sb.from('v_gl_entries').select('*').eq('company_id', companyId).eq('account_code', accountCode).order('line_id').range(from, to));
  if (linesErr) return { role, accountCode, error: linesErr.message };
  let bal = 0;
  const foreign: ControlForeign[] = [];
  /* What LEGITIMATELY moves each control account: the document that books it
     plus everything that settles it. AR moves on invoices AND on customer
     payments (SOPAY/SIPAY), on the deposit invoice a payment raises (DI), on
     the credit note a refund raises against it (CN), on the Customer Refund
     voucher itself (PV, Dr AR) and on a CONVERSION (SOCONV — a customer's
     money moved from one order to another, netting to nil; owner 2026-10-06
     saw its two lines as findings); AP moves on purchase invoices AND on the
     payment vouchers that settle them. Anything else on the account is the
     finding. */
  const family = role === 'AR'
    ? new Set(['SI', 'SI_REVERSAL', 'SOPAY', 'SOPAY_REVERSAL', 'SIPAY', 'SIPAY_REVERSAL',
      'DI', 'DI_REVERSAL', 'CN', 'CN_REVERSAL', 'PV', 'PV_REVERSAL', CONVERT_SOURCE, `${CONVERT_SOURCE}_REVERSAL`])
    : role === 'AR_OTHER'
      /* OCN = a credit note to an other debtor (Cr the other-debtor control),
         knocked off the debtor's bills — part of the family (2026-10-28). */
      ? new Set(['ODB', 'ODB_REVERSAL', 'ODR', 'ODR_REVERSAL', 'OCN', 'OCN_REVERSAL'])
      /* API = the AP invoice (docs/bugs/0654) and SCN = a supplier's credit
         note (Dr the supplier's AP control, off the invoices it credits since
         2026-10-01) — part of the family, not findings. */
      : new Set(['PI', 'PI_REVERSAL', 'PV', 'PV_REVERSAL', 'API', 'API_REVERSAL', 'SCN', 'SCN_REVERSAL']);
  for (const l of (lines ?? []) as Array<{ je_no: string; source_type: string; debit_sen: number; credit_sen: number }>) {
    bal += Number(l.debit_sen ?? 0) - Number(l.credit_sen ?? 0);
    if (!family.has(l.source_type)) {
      foreign.push({ jeNo: l.je_no, sourceType: l.source_type, debitSen: Number(l.debit_sen ?? 0), creditSen: Number(l.credit_sen ?? 0) });
    }
  }

  return { role, accountCode, glBalanceSen: bal, driftDocs: drift, foreignLines: foreign, ok: drift.length === 0 && foreign.length === 0 };
}

/** Each unbooked payment's customer and salesperson: the order's (SOPAY), the
    invoice's (SIPAY — named by its number rather than its id). */
async function withPeople(sb: Db, companyId: number, rows: UnbookedPayment[]): Promise<{ ok: true; rows: UnbookedRow[] } | { ok: false; reason: string }> {
  const soDocs = [...new Set(rows.filter((r) => r.source === 'SOPAY').map((r) => r.docNo).filter(Boolean))];
  const siIds = [...new Set(rows.filter((r) => r.source === 'SIPAY').map((r) => r.docNo).filter(Boolean))];
  const orders = await chunkIn<Row>(soDocs, (batch, lo, hi) => sb.from('mfg_sales_orders')
    .select('doc_no, debtor_name, salesperson_id, agent').eq('company_id', companyId).in('doc_no', batch).order('doc_no').range(lo, hi));
  if (orders.error) return { ok: false, reason: `orders: ${orders.error.message}` };
  const invoices = await chunkIn<Row>(siIds, (batch, lo, hi) => sb.from('sales_invoices')
    .select('id, invoice_number, debtor_name, salesperson_id, agent').eq('company_id', companyId).in('id', batch).order('id').range(lo, hi));
  if (invoices.error) return { ok: false, reason: `invoices: ${invoices.error.message}` };
  const staff = await staffNames(sb, [...orders.data, ...invoices.data].map((r) => String(r.salesperson_id ?? '')));
  if (!staff.ok) return staff;
  const seller = (r: Row | undefined): string | null =>
    (r?.salesperson_id ? staff.names.get(String(r.salesperson_id)) ?? null : null) ?? str(r?.agent);
  const orderOf = new Map(orders.data.map((o) => [String(o.doc_no), o]));
  const invoiceOf = new Map(invoices.data.map((i) => [String(i.id), i]));
  return {
    ok: true,
    rows: rows.map((r): UnbookedRow => {
      const doc = r.source === 'SIPAY' ? invoiceOf.get(r.docNo) : orderOf.get(r.docNo);
      return { ...r, docNo: r.source === 'SIPAY' ? str(doc?.invoice_number) ?? r.docNo : r.docNo, customer: str(doc?.debtor_name), salesperson: seller(doc) };
    }),
  };
}

/** The whole check for one company — what GET /accounting/control-check returns. */
export async function runControlCheck(sb: Db, companyId: number): Promise<ControlCheckResult> {
  const roles = await resolveRoles(sb, companyId);
  const checks = [
    await runOne(sb, companyId, 'AR', roles.AR),
    await runOne(sb, companyId, 'AR_OTHER', roles.AR_OTHER),
    await runOne(sb, companyId, 'AP', roles.AP),
    await runOne(sb, companyId, 'AP_OTHER', roles.AP_OTHER),
  ];

  /* THE THIRD FINDING: money recorded on a document that never reached the
     ledger at all. A booking failure does not fail the operator's save, so
     until then the only trace was a server log. Owner, asked whether this page
     should say so: 要. `since` is the derived boundary — see acc/payments.ts. */
  const unbooked = await unbookedPayments(sb, companyId);
  let payments: ControlCheckPayments;
  if (!unbooked.ok) {
    payments = { since: null, rows: [], totalSen: 0, ok: false, error: unbooked.reason };
  } else {
    const named = await withPeople(sb, companyId, unbooked.rows);
    payments = {
      since: unbooked.since,
      /* A failed name read costs the names, never the finding. */
      rows: named.ok ? named.rows : unbooked.rows.map((r) => ({ ...r, customer: null, salesperson: null })),
      totalSen: unbooked.totalSen,
      ok: unbooked.rows.length === 0 && (unbooked.neverBooked?.count ?? 0) === 0,
      /* neverBooked rides along (docs/bugs/0654: it was computed and then
         dropped, so the card said "all of them" over 171 unbooked rows). */
      ...(unbooked.neverBooked ? { neverBooked: unbooked.neverBooked } : {}),
    };
  }

  /* THE FOURTH FINDING: a payment that reached the ledger and then stopped
     agreeing with it. Reads only. */
  const drift = await paymentEntryDisagreements(sb, companyId);
  const paymentDrift: ControlCheckDrift = drift.ok
    ? { rows: drift.rows, scanned: drift.scanned, ok: drift.rows.length === 0 }
    : { rows: [], scanned: 0, ok: false, error: drift.reason };

  return { checks, payments, paymentDrift };
}
