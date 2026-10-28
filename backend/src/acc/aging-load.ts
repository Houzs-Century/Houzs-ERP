// ----------------------------------------------------------------------------
// aging-load — reads what the formal AR / AP Aging needs and turns each control
// account line into the pieces acc/aging.ts knocks off (owner 2026-10-02; the
// rules are in aging.ts's header). Every counted line on the control accounts
// up to the date becomes one or more pieces that add back to it, so the report
// always adds up to the books.
//
//   AR  the line's ORDER is found from its paper:
//         SOPAY  the payment row → its order; SOCONV the converted row → the
//                debit leg on the order the money left, the credit leg on the
//                order it went to; SIPAY the invoice payment → its invoice →
//                its order; SI the invoice → its order; DI the deposit invoice
//                → its order; CN / DN the note → its order (or its invoice's);
//                PV a customer refund → the order (or invoice) it refunds.
//       Other Debtors (305): a bill is its own group; a receipt's allocations
//       join the bills they name, the rest of the receipt is 未冲.
//       The customer is the ORDER's (its debtor code, else its customer id —
//       the code SOPAY posts under), named by the order.
//   AP  the supplier is the line's party code. PI / API lines are the bills;
//       an AP Payment's line is split by its ticks (pv_allocations, an advance
//       applied counted from the day it was applied), a supplier credit note's
//       by its knock-offs (from the later of the note's date and the knock-off);
//       a foreign purchase invoice's ticks are turned into ringgit at its rate.
//   A line whose paper is not found is its own group — a bill if it is owed,
//   未冲 if it is money against — never dropped.
// ----------------------------------------------------------------------------

import { chunkIn, paginateAll } from '../scm/lib/paginate-all';
import { toMyrSen } from '../scm/lib/fx';
import { OPEN_PI_STATUSES, OPEN_SI_STATUSES } from '../scm/lib/open-invoice-states';
import { customerPartyCode } from './payments';
import { loadControlLines, type ControlLine } from './party-ledger';
import { splitLine, type AgingEntry, type AgingParty } from './aging';

/* eslint-disable @typescript-eslint/no-explicit-any -- PostgREST client, untyped in this family */
type Db = any;
type Row = Record<string, any>;

export type ControlBalance = { code: string; balanceSen: number };
export type AgingLoad =
  | {
      ok: true;
      entries: AgingEntry[];
      controls: ControlBalance[];
      outside: { count: number; sen: number };
      /** AR only: what each order was paid before the ERP (payments brought over
          from AutoCount, method 'imported' — never booked here), by order. */
      paidBeforeErp?: Record<string, number>;
    }
  | { ok: false; reason: string };

const mytDate = (iso: unknown): string => new Date(Date.parse(String(iso)) + 8 * 3_600_000).toISOString().slice(0, 10);
const uniq = (xs: Array<string | null | undefined>): string[] => [...new Set(xs.filter((x): x is string => !!x))];

/** Rows of `table` whose `col` is one of `values`, in this company. */
async function byValues(sb: Db, companyId: number, table: string, cols: string, col: string, values: string[]): Promise<{ ok: true; rows: Row[] } | { ok: false; reason: string }> {
  if (values.length === 0) return { ok: true, rows: [] };
  const { data, error } = await chunkIn<Row>(values, (batch, from, to) =>
    sb.from(table).select(cols).eq('company_id', companyId).in(col, batch).order(col).range(from, to));
  if (error) return { ok: false, reason: `${table}: ${error.message}` };
  return { ok: true, rows: data };
}

function controlsOf(lines: readonly ControlLine[], codes: readonly string[], sideOf: (l: ControlLine) => number): ControlBalance[] {
  return codes.map((code) => ({ code, balanceSen: lines.filter((l) => l.account_code === code).reduce((n, l) => n + sideOf(l), 0) }));
}

const lineParty = (l: ControlLine): AgingParty => ({
  key: l.party_code ?? `name:${l.party_name ?? '—'}`,
  code: l.party_code,
  name: l.party_name ?? l.party_code ?? '(no party)',
});

/* ── AR ─────────────────────────────────────────────────────────────────── */

export async function loadArAging(sb: Db, companyId: number, codes: readonly string[], asOf: string): Promise<AgingLoad> {
  const got = await loadControlLines(sb, companyId, codes, asOf);
  if (!got.ok) return got;
  const lines = got.lines;
  const docsOf = (...types: string[]) => uniq(lines.filter((l) => types.includes(l.source_type)).map((l) => l.source_doc_no));

  const [pays, siPays, sisByNo, dis, notes, pvs, bills, receipts] = await Promise.all([
    byValues(sb, companyId, 'mfg_sales_order_payments', 'id, so_doc_no, converted_from_so_doc_no', 'id', docsOf('SOPAY', 'SOCONV')),
    byValues(sb, companyId, 'sales_invoice_payments', 'id, sales_invoice_id', 'id', docsOf('SIPAY')),
    byValues(sb, companyId, 'sales_invoices', 'id, invoice_number, so_doc_no, due_date, debtor_code, debtor_name', 'invoice_number', docsOf('SI')),
    byValues(sb, companyId, 'acc_deposit_invoices', 'di_number, so_doc_no', 'di_number', docsOf('DI')),
    byValues(sb, companyId, 'acc_credit_notes', 'note_number, kind, so_doc_no, sales_invoice_id', 'note_number', docsOf('CN', 'DN')),
    byValues(sb, companyId, 'payment_vouchers', 'pv_number, refund_source_type, refund_source_doc_no', 'pv_number', docsOf('PV')),
    byValues(sb, companyId, 'acc_debtor_bills', 'id, bill_number, debtor_id', 'bill_number', docsOf('ODB')),
    byValues(sb, companyId, 'acc_debtor_receipts', 'id, receipt_number, debtor_id', 'receipt_number', docsOf('ODR')),
  ]);
  if (!pays.ok) return pays;
  if (!siPays.ok) return siPays;
  if (!sisByNo.ok) return sisByNo;
  if (!dis.ok) return dis;
  if (!notes.ok) return notes;
  if (!pvs.ok) return pvs;
  if (!bills.ok) return bills;
  if (!receipts.ok) return receipts;

  /* Invoices named by id (a payment's or a note's) or by number (a refund's)
     that the SI lines did not bring. */
  const siById = new Map<string, Row>(sisByNo.rows.map((s) => [String(s.id), s]));
  const siByNo = new Map<string, Row>(sisByNo.rows.map((s) => [String(s.invoice_number), s]));
  const wantIds = uniq([...siPays.rows.map((p) => p.sales_invoice_id), ...notes.rows.map((n) => n.sales_invoice_id)]).filter((id) => !siById.has(id));
  const wantNos = uniq(pvs.rows.filter((v) => v.refund_source_type === 'SI').map((v) => v.refund_source_doc_no)).filter((n) => !siByNo.has(n));
  const [moreById, moreByNo, allocs] = await Promise.all([
    byValues(sb, companyId, 'sales_invoices', 'id, invoice_number, so_doc_no, due_date, debtor_code, debtor_name', 'id', wantIds),
    byValues(sb, companyId, 'sales_invoices', 'id, invoice_number, so_doc_no, due_date, debtor_code, debtor_name', 'invoice_number', wantNos),
    byValues(sb, companyId, 'acc_debtor_receipt_allocations', 'id, receipt_id, bill_id, amount_sen', 'receipt_id', uniq(receipts.rows.map((r) => String(r.id)))),
  ]);
  if (!moreById.ok) return moreById;
  if (!moreByNo.ok) return moreByNo;
  if (!allocs.ok) return allocs;
  for (const s of [...moreById.rows, ...moreByNo.rows]) { siById.set(String(s.id), s); siByNo.set(String(s.invoice_number), s); }

  const payById = new Map(pays.rows.map((p) => [String(p.id), p]));
  const siPayById = new Map(siPays.rows.map((p) => [String(p.id), p]));
  const diByNo = new Map(dis.rows.map((d) => [String(d.di_number), d]));
  const noteByNo = new Map(notes.rows.map((n) => [String(n.note_number), n]));
  const pvByNo = new Map(pvs.rows.map((v) => [String(v.pv_number), v]));
  const billByNo = new Map(bills.rows.map((b) => [String(b.bill_number), b]));
  const billById = new Map(bills.rows.map((b) => [String(b.id), b]));
  const receiptByNo = new Map(receipts.rows.map((r) => [String(r.receipt_number), r]));

  /* The orders every line points at, and the debtors of the other-debtor paper. */
  const soNos = uniq([
    ...pays.rows.flatMap((p) => [p.so_doc_no, p.converted_from_so_doc_no]),
    ...[...siById.values()].map((s) => s.so_doc_no),
    ...dis.rows.map((d) => d.so_doc_no),
    ...notes.rows.map((n) => n.so_doc_no),
    ...pvs.rows.filter((v) => v.refund_source_type === 'SO').map((v) => v.refund_source_doc_no),
  ]);
  const debtorIds = uniq([...bills.rows.map((b) => b.debtor_id), ...receipts.rows.map((r) => r.debtor_id)].map((x) => (x == null ? null : String(x))));
  const [orders, debtors, imported] = await Promise.all([
    byValues(sb, companyId, 'mfg_sales_orders', 'doc_no, debtor_code, debtor_name, customer_id', 'doc_no', soNos),
    byValues(sb, companyId, 'acc_debtors', 'id, name', 'id', debtorIds),
    byValues(sb, companyId, 'mfg_sales_order_payments', 'id, so_doc_no, amount_sen, method', 'so_doc_no', soNos),
  ]);
  if (!orders.ok) return orders;
  if (!debtors.ok) return debtors;
  if (!imported.ok) return imported;
  /* A deposit taken before the ERP and brought over from AutoCount books
     nothing here, so an order invoiced after the move owes its whole invoice in
     these books. Said in the footer, never knocked off: the aging is the books. */
  const paidBeforeErp: Record<string, number> = {};
  for (const p of imported.rows) {
    if (p.method !== 'imported' || Number(p.amount_sen ?? 0) <= 0) continue;
    const so = String(p.so_doc_no);
    paidBeforeErp[so] = (paidBeforeErp[so] ?? 0) + Number(p.amount_sen);
  }
  const orderByNo = new Map(orders.rows.map((o) => [String(o.doc_no), o]));
  const debtorById = new Map(debtors.rows.map((d) => [String(d.id), d]));

  const orderGroup = (so: string, l: ControlLine): { group: string; party: AgingParty } => {
    const o = orderByNo.get(so);
    const key = customerPartyCode(o?.debtor_code, o?.customer_id) ?? l.party_code ?? `SO:${so}`;
    return { group: `SO:${so}`, party: { key, code: o?.debtor_code ?? null, name: o?.debtor_name ?? l.party_name ?? key } };
  };
  const invoiceGroup = (si: Row, l: ControlLine): { group: string; party: AgingParty } => {
    if (si.so_doc_no) return orderGroup(String(si.so_doc_no), l);
    const key = customerPartyCode(si.debtor_code, null) ?? l.party_code ?? `SI:${si.id}`;
    return { group: `SI:${si.id}`, party: { key, code: si.debtor_code ?? null, name: si.debtor_name ?? l.party_name ?? key } };
  };
  const debtorParty = (debtorId: unknown, l: ControlLine): AgingParty => {
    const id = debtorId == null ? null : String(debtorId);
    const d = id ? debtorById.get(id) : undefined;
    return id ? { key: `DEBTOR:${id}`, code: null, name: d?.name ?? l.party_name ?? 'Other debtor' } : lineParty(l);
  };

  const entries: AgingEntry[] = [];
  lines.forEach((l, i) => {
    const amountSen = l.debit_sen - l.credit_sen;
    if (amountSen === 0) return;
    const own = `LINE:${l.je_no}#${i}`;
    const base = { docNo: l.source_doc_no ?? l.je_no, kind: l.source_type, date: l.entry_date, dueDate: null as string | null, amountSen };
    const doc = l.source_doc_no ?? '';
    let at: { group: string; party: AgingParty } | null = null;
    switch (l.source_type) {
      case 'SOPAY': {
        const p = payById.get(doc);
        if (p?.so_doc_no) { at = orderGroup(String(p.so_doc_no), l); base.docNo = String(p.so_doc_no); base.kind = 'Payment'; }
        break;
      }
      case 'SOCONV': {
        const p = payById.get(doc);
        /* Dr the order the money left, Cr the order it went to (acc/payments.ts). */
        const so = amountSen > 0 ? p?.converted_from_so_doc_no : p?.so_doc_no;
        if (so) { at = orderGroup(String(so), l); base.docNo = String(so); base.kind = amountSen > 0 ? 'Moved to another order' : 'Moved from another order'; }
        break;
      }
      case 'SIPAY': {
        const si = siById.get(String(siPayById.get(doc)?.sales_invoice_id ?? ''));
        if (si) { at = invoiceGroup(si, l); base.docNo = String(si.invoice_number); base.kind = 'Payment'; }
        break;
      }
      case 'SI': {
        const si = siByNo.get(doc);
        if (si) { at = invoiceGroup(si, l); base.kind = 'Invoice'; base.dueDate = si.due_date ?? null; }
        break;
      }
      case 'DI': {
        const d = diByNo.get(doc);
        if (d?.so_doc_no) { at = orderGroup(String(d.so_doc_no), l); base.kind = 'Deposit invoice'; }
        break;
      }
      case 'CN':
      case 'DN': {
        const n = noteByNo.get(doc);
        const si = n?.sales_invoice_id ? siById.get(String(n.sales_invoice_id)) : undefined;
        if (n?.so_doc_no) at = orderGroup(String(n.so_doc_no), l);
        else if (si) at = invoiceGroup(si, l);
        base.kind = l.source_type === 'CN' ? 'Credit note' : 'Debit note';
        break;
      }
      case 'PV': {
        const v = pvByNo.get(doc);
        if (v?.refund_source_type === 'SO' && v.refund_source_doc_no) at = orderGroup(String(v.refund_source_doc_no), l);
        else if (v?.refund_source_type === 'SI' && siByNo.get(String(v.refund_source_doc_no))) at = invoiceGroup(siByNo.get(String(v.refund_source_doc_no))!, l);
        base.kind = 'Refund';
        break;
      }
      case 'ODB': {
        const b = billByNo.get(doc);
        if (b) at = { group: `ODB:${b.id}`, party: debtorParty(b.debtor_id, l) };
        base.kind = 'Other debtor bill';
        break;
      }
      case 'ODR': {
        const r = receiptByNo.get(doc);
        if (r) {
          const party = debtorParty(r.debtor_id, l);
          const parts = (allocs.rows as Row[]).filter((a) => String(a.receipt_id) === String(r.id) && billById.has(String(a.bill_id)))
            .map((a) => ({ group: `ODB:${a.bill_id}`, amountSen: Number(a.amount_sen ?? 0), date: l.entry_date }));
          entries.push(...splitLine({ ...base, kind: 'Receipt', group: `ODR:${r.id}`, party }, parts));
          return;
        }
        base.kind = 'Receipt';
        break;
      }
      default:
        break;
    }
    entries.push({ ...base, ...(at ?? { group: own, party: lineParty(l) }) });
  });

  /* Customer invoices brought over from AutoCount book nothing here: said, not aged. */
  const outside = await outsideTheBooks(sb, companyId, 'sales_invoices', [...OPEN_SI_STATUSES], false);
  if (!outside.ok) return outside;
  return { ok: true, entries, controls: controlsOf(lines, codes, (l) => l.debit_sen - l.credit_sen), outside: outside.outside, paidBeforeErp };
}

/* ── AP ─────────────────────────────────────────────────────────────────── */

export async function loadApAging(sb: Db, companyId: number, codes: readonly string[], asOf: string): Promise<AgingLoad> {
  const got = await loadControlLines(sb, companyId, codes, asOf);
  if (!got.ok) return got;
  const lines = got.lines;
  const docsOf = (t: string) => uniq(lines.filter((l) => l.source_type === t).map((l) => l.source_doc_no));

  const [pisByNo, apisByNo, pvs, scns, sups] = await Promise.all([
    byValues(sb, companyId, 'purchase_invoices', 'id, invoice_number, due_date, exchange_rate', 'invoice_number', docsOf('PI')),
    byValues(sb, companyId, 'ap_invoices', 'id, invoice_number, due_date', 'invoice_number', docsOf('API')),
    byValues(sb, companyId, 'payment_vouchers', 'id, pv_number, voucher_date', 'pv_number', docsOf('PV')),
    byValues(sb, companyId, 'acc_credit_notes', 'id, note_number, note_date', 'note_number', docsOf('SCN')),
    paginateAll<Row>((f, t) => sb.from('suppliers').select('id, code, name').eq('company_id', companyId).order('id').range(f, t)),
  ]);
  if (!pisByNo.ok) return pisByNo;
  if (!apisByNo.ok) return apisByNo;
  if (!pvs.ok) return pvs;
  if (!scns.ok) return scns;
  if (sups.error) return { ok: false, reason: `suppliers: ${sups.error.message}` };

  const [pvAllocs, scnAllocs] = await Promise.all([
    byValues(sb, companyId, 'pv_allocations', 'id, pv_id, pi_id, ap_invoice_id, applied_sen, from_advance, created_at', 'pv_id', uniq(pvs.rows.map((v) => String(v.id)))),
    byValues(sb, companyId, 'acc_credit_note_allocations', 'id, note_id, purchase_invoice_id, ap_invoice_id, applied_sen, created_at', 'note_id', uniq(scns.rows.map((n) => String(n.id)))),
  ]);
  if (!pvAllocs.ok) return pvAllocs;
  if (!scnAllocs.ok) return scnAllocs;

  /* The invoices a tick names that no invoice line brought (one paid in an
     earlier era, or brought over from AutoCount) — for their number and rate. */
  const piById = new Map(pisByNo.rows.map((p) => [String(p.id), p]));
  const apiById = new Map(apisByNo.rows.map((a) => [String(a.id), a]));
  const allAllocs = [...pvAllocs.rows, ...scnAllocs.rows] as Row[];
  const [morePis, moreApis] = await Promise.all([
    byValues(sb, companyId, 'purchase_invoices', 'id, invoice_number, due_date, exchange_rate', 'id',
      uniq(allAllocs.map((a) => (a.pi_id ?? a.purchase_invoice_id) == null ? null : String(a.pi_id ?? a.purchase_invoice_id))).filter((id) => !piById.has(id))),
    byValues(sb, companyId, 'ap_invoices', 'id, invoice_number, due_date', 'id',
      uniq(allAllocs.map((a) => (a.ap_invoice_id == null ? null : String(a.ap_invoice_id)))).filter((id) => !apiById.has(id))),
  ]);
  if (!morePis.ok) return morePis;
  if (!moreApis.ok) return moreApis;
  for (const p of morePis.rows) piById.set(String(p.id), p);
  for (const a of moreApis.rows) apiById.set(String(a.id), a);
  const piByNo = new Map([...piById.values()].map((p) => [String(p.invoice_number), p]));
  const apiByNo = new Map([...apiById.values()].map((a) => [String(a.invoice_number), a]));

  const supByCode = new Map(((sups.data ?? []) as Row[]).map((s) => [String(s.code), s]));
  const supplierParty = (l: ControlLine): AgingParty => {
    const s = l.party_code ? supByCode.get(l.party_code) : undefined;
    return s ? { key: String(s.code), code: String(s.code), name: String(s.name ?? s.code) } : lineParty(l);
  };
  /** The group a tick lands in, and what it is worth in ringgit. */
  const target = (piId: unknown, apiId: unknown, appliedSen: number): { group: string; sen: number } | null => {
    if (piId != null) {
      const p = piById.get(String(piId));
      return p ? { group: `PI:${p.invoice_number}`, sen: toMyrSen(appliedSen, p.exchange_rate) } : null;
    }
    if (apiId != null) {
      const a = apiById.get(String(apiId));
      return a ? { group: `API:${a.invoice_number}`, sen: appliedSen } : null;
    }
    return null;
  };

  const pvByNo = new Map(pvs.rows.map((v) => [String(v.pv_number), v]));
  const scnByNo = new Map(scns.rows.map((n) => [String(n.note_number), n]));
  const entries: AgingEntry[] = [];
  lines.forEach((l, i) => {
    const amountSen = l.credit_sen - l.debit_sen;
    if (amountSen === 0) return;
    const party = supplierParty(l);
    const doc = l.source_doc_no ?? '';
    const base = { party, docNo: doc || l.je_no, date: l.entry_date, dueDate: null as string | null, amountSen };
    if (l.source_type === 'PI' || l.source_type === 'API') {
      const inv = l.source_type === 'PI' ? piByNo.get(doc) : apiByNo.get(doc);
      entries.push({ ...base, group: `${l.source_type}:${doc}`, kind: l.source_type === 'PI' ? 'Purchase invoice' : 'AP invoice', dueDate: inv?.due_date ?? null });
      return;
    }
    if (l.source_type === 'PV' && pvByNo.has(doc)) {
      const v = pvByNo.get(doc)!;
      const parts = (pvAllocs.rows as Row[]).filter((a) => String(a.pv_id) === String(v.id) && Number(a.applied_sen ?? 0) > 0)
        .map((a) => {
          /* An advance applied later is a tick of its own day; the voucher's
             own ticks are the voucher's day. */
          const date = a.from_advance === true ? mytDate(a.created_at) : l.entry_date;
          const t = target(a.pi_id, a.ap_invoice_id, Number(a.applied_sen));
          return t && date <= asOf ? { group: t.group, amountSen: t.sen, date, kind: a.from_advance === true ? 'Advance applied' : 'Payment' } : null;
        })
        .filter((p): p is { group: string; amountSen: number; date: string; kind: string } => p !== null);
      entries.push(...splitLine({ ...base, group: `PV:${doc}`, kind: 'Payment' }, parts));
      return;
    }
    if (l.source_type === 'SCN' && scnByNo.has(doc)) {
      const n = scnByNo.get(doc)!;
      const parts = (scnAllocs.rows as Row[]).filter((a) => String(a.note_id) === String(n.id) && Number(a.applied_sen ?? 0) > 0)
        .map((a) => {
          const knocked = mytDate(a.created_at);
          const date = n.note_date && String(n.note_date) > knocked ? String(n.note_date) : knocked;
          const t = target(a.purchase_invoice_id, a.ap_invoice_id, Number(a.applied_sen));
          return t && date <= asOf ? { group: t.group, amountSen: t.sen, date, kind: 'Credit note' } : null;
        })
        .filter((p): p is { group: string; amountSen: number; date: string; kind: string } => p !== null);
      entries.push(...splitLine({ ...base, group: `SCN:${doc}`, kind: 'Credit note' }, parts));
      return;
    }
    entries.push({ ...base, group: `LINE:${l.je_no}#${i}`, kind: l.source_type });
  });

  /* Purchase invoices brought over from AutoCount book nothing here. */
  const outside = await outsideTheBooks(sb, companyId, 'purchase_invoices', [...OPEN_PI_STATUSES], true);
  if (!outside.ok) return outside;
  return { ok: true, entries, controls: controlsOf(lines, codes, (l) => l.credit_sen - l.debit_sen), outside: outside.outside };
}

/** Open invoices brought over from AutoCount (migrated_no_stock): never booked
    in this ledger, so they are not in the aging — the footer says how many. */
async function outsideTheBooks(sb: Db, companyId: number, table: 'sales_invoices' | 'purchase_invoices', open: string[], withRate: boolean): Promise<{ ok: true; outside: { count: number; sen: number } } | { ok: false; reason: string }> {
  const cols = withRate ? 'id, total_sen, paid_sen, exchange_rate' : 'id, total_sen, paid_sen';
  const { data, error } = await paginateAll<Row>((f, t) => sb.from(table).select(cols)
    .eq('company_id', companyId).eq('migrated_no_stock', true).in('status', open).order('id').range(f, t));
  if (error) return { ok: false, reason: `${table}: ${error.message}` };
  let count = 0;
  let sen = 0;
  for (const r of data ?? []) {
    const left = Number(r.total_sen ?? 0) - Number(r.paid_sen ?? 0);
    if (left <= 0) continue;
    count += 1;
    sen += withRate ? toMyrSen(left, r.exchange_rate) : left;
  }
  return { ok: true, outside: { count, sen } };
}
