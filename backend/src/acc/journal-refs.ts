// ----------------------------------------------------------------------------
// journal-refs — what a journal entry IS, in the words a person recognises
// (owner 2026-09-15, docs/bugs/0918, on the bank reconciliation's outstanding
// list: 我需要看到 customer name，然后 source 改成 reference 吧，就是 or number, pv
// number 等等 … so number 我还是需要). An entry's source is a system word and
// a key ("SOPAY · 0bb232ad-…"); its REFERENCE is the document a person holds
// and its WHO is the customer, the payee or the merchant. Resolved here for a
// batch of entries, in a handful of reads, so every screen that lists
// entries (the bank reconciliation, the general ledger) names them the same
// way.
//
//   SOPAY / SIPAY   the payment's official receipt number when one exists,
//                   and ALWAYS the sales order number (OR · SO); who = the
//                   order's customer
//   SOCONV          money moved from a cancelled order (docs/bugs/0927): the
//                   new order, and the cancelled one it came from
//   PV              the voucher number; who = the payee
//   PI / API        the invoice number; who = the supplier
//   RCT / ODR       the receipt number; who = the debtor
//   SETTLEBANK      "<acquirer> payout dd/mm/yyyy" off the settlement receipt;
//                   who = the acquirer
//   anything else   the source document number as it is; who = the party, or
//                   the entry's note
// A reversal (…_REVERSAL) reads as its original does.
//
// The general ledger (docs/bugs/0924) prints the same knowledge as two
// AutoCount columns, Ref. 1 and Ref. 2 — `doc` and `doc2` here:
//
//   SOPAY / SIPAY   doc = the receipt number, or the order when there is none
//                   yet; doc2 = the order (blank when doc already is)
//   PV              doc = the voucher number; doc2 = what a refund refunds
//   PI / API        doc = the invoice number; doc2 = the supplier's own ref
//   SI / DI / CN    doc = the document number; doc2 = its sales order
//   SETTLE(MOVE)    doc = "<acquirer> settlement dd/mm/yyyy"; doc2 = the
//                   merchant's transaction ref
//   SETTLEBANK      doc = "<acquirer> payout dd/mm/yyyy"; doc2 = the bank ref
//   SETTLECHARGE    doc = "<acquirer> charge dd/mm/yyyy"
//   STOCKADJ        doc = "Stock mm/yyyy"
//   MANUAL          nothing — the narration says what it is
// ----------------------------------------------------------------------------

import { fmtDate } from '../scm/shared/format';

export type JournalRefSource = {
  jeNo: string;
  sourceType: string | null;
  sourceDocNo: string | null;
  partyName?: string | null;
  notes?: string | null;
};

export type JournalRef = {
  reference: string | null;
  who: string | null;
  /** Ref. 1 — the document number a person files the entry under. */
  doc: string | null;
  /** Ref. 2 — the second handle: the order, the supplier's ref, the bank ref. */
  doc2: string | null;
};

type Db = any;

const CHUNK = 150;
const chunks = <T>(xs: T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
  return out;
};

const baseTypeOf = (t: string | null): string => String(t ?? '').replace(/_REVERSAL$/, '');

/** "Stock 07/2026" off a STOCKADJ key (STOCKADJ-<company>-<yyyy>-<mm>, or STOCKADJ-REV-…). */
export const stockMonthLabel = (doc: string): string => {
  const m = /(\d{4})-(\d{2})$/.exec(doc);
  return m ? `Stock ${m[2]}/${m[1]}` : doc;
};

/** Read one lookup table in chunks and fold it into a map. */
async function lookup(sb: Db, companyId: number, table: string, keyCol: string, cols: string, keys: string[], label: string): Promise<{ ok: true; rows: Map<string, Record<string, unknown>> } | { ok: false; reason: string }> {
  const rows = new Map<string, Record<string, unknown>>();
  for (const ks of chunks(keys)) {
    const { data, error } = await sb.from(table).select(cols).eq('company_id', companyId).in(keyCol, ks);
    if (error) return { ok: false, reason: `${label}: ${String(error.message ?? error)}` };
    for (const r of (Array.isArray(data) ? data : []) as Array<Record<string, unknown>>) rows.set(String(r[keyCol]), r);
  }
  return { ok: true, rows };
}

const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

/**
 * Resolve the reference, the who and the two document handles of every
 * entry given, keyed by je_no. Reads only what the entries call for — the
 * payments, orders, receipts, invoices and settlement rows they name — and
 * answers for the rest without a read. An entry the reads cannot place keeps
 * its source document number.
 */
export async function resolveJournalRefs(sb: Db, companyId: number, entries: JournalRefSource[]): Promise<{ ok: true; refs: Map<string, JournalRef> } | { ok: false; reason: string }> {
  const refs = new Map<string, JournalRef>();
  const docsOf = (types: string[]): string[] =>
    [...new Set(entries.filter((e) => types.includes(baseTypeOf(e.sourceType)) && e.sourceDocNo).map((e) => String(e.sourceDocNo)))];

  /* ── Sales-order payments: the payment → its order and its receipt ─────── */
  const paymentIds = docsOf(['SOPAY', 'SIPAY', 'SOCONV']);
  const orderOfPayment = new Map<string, string>();
  const movedFrom = new Map<string, string>();
  const receiptOfPayment = new Map<string, string>();
  const customerOfOrder = new Map<string, string>();
  for (const ids of chunks(paymentIds)) {
    const { data, error } = await sb.from('mfg_sales_order_payments').select('id, so_doc_no, converted_from_so_doc_no').eq('company_id', companyId).in('id', ids);
    if (error) return { ok: false, reason: `payments: ${String(error.message ?? error)}` };
    for (const p of (Array.isArray(data) ? data : []) as Array<{ id: string; so_doc_no: string; converted_from_so_doc_no?: string | null }>) {
      orderOfPayment.set(String(p.id), String(p.so_doc_no));
      if (p.converted_from_so_doc_no) movedFrom.set(String(p.id), String(p.converted_from_so_doc_no));
    }
    const { data: ors, error: oErr } = await sb.from('acc_official_receipts').select('payment_id, or_number').eq('company_id', companyId).in('payment_id', ids);
    if (oErr) return { ok: false, reason: `receipts: ${String(oErr.message ?? oErr)}` };
    for (const r of (Array.isArray(ors) ? ors : []) as Array<{ payment_id: string; or_number: string }>) receiptOfPayment.set(String(r.payment_id), String(r.or_number));
  }
  const orderNos = [...new Set(orderOfPayment.values())];
  for (const docs of chunks(orderNos)) {
    const { data, error } = await sb.from('mfg_sales_orders').select('doc_no, debtor_name').eq('company_id', companyId).in('doc_no', docs);
    if (error) return { ok: false, reason: `orders: ${String(error.message ?? error)}` };
    for (const o of (Array.isArray(data) ? data : []) as Array<{ doc_no: string; debtor_name: string | null }>) customerOfOrder.set(String(o.doc_no), String(o.debtor_name ?? ''));
  }

  /* ── Documents with a second handle: the supplier's ref, the order ─────── */
  const pis = await lookup(sb, companyId, 'purchase_invoices', 'invoice_number', 'invoice_number, supplier_invoice_ref', docsOf(['PI']), 'purchase invoices');
  if (!pis.ok) return pis;
  const apis = await lookup(sb, companyId, 'ap_invoices', 'invoice_number', 'invoice_number, supplier_invoice_ref', docsOf(['API']), 'AP invoices');
  if (!apis.ok) return apis;
  const sis = await lookup(sb, companyId, 'sales_invoices', 'invoice_number', 'invoice_number, so_doc_no, debtor_name', docsOf(['SI']), 'sales invoices');
  if (!sis.ok) return sis;
  const dis = await lookup(sb, companyId, 'acc_deposit_invoices', 'di_number', 'di_number, so_doc_no, party_name', docsOf(['DI']), 'deposit invoices');
  if (!dis.ok) return dis;
  const cns = await lookup(sb, companyId, 'acc_credit_notes', 'note_number', 'note_number, so_doc_no, party_name', docsOf(['CN']), 'credit notes');
  if (!cns.ok) return cns;
  const pvs = await lookup(sb, companyId, 'payment_vouchers', 'pv_number', 'pv_number, payee_name, refund_source_doc_no', docsOf(['PV']), 'vouchers');
  if (!pvs.ok) return pvs;

  /* ── Settlements: the row → its day and ref; the receipt → its day and bank ref; the batch → its acquirer ── */
  const settleKeys = docsOf(['SETTLE', 'SETTLEMOVE']);
  const rowIds = [...new Set(settleKeys.map((k) => Number(k.split('-')[1])).filter((n) => Number.isInteger(n)))];
  const settleRows = new Map<number, { txn_date: string | null; ref: string | null; acquirer_code: string | null }>();
  if (rowIds.length > 0) {
    const { data, error } = await sb.from('acc_settlement_rows').select('id, txn_date, ref, acquirer_code').eq('company_id', companyId).in('id', rowIds);
    if (error) return { ok: false, reason: `settlement rows: ${String(error.message ?? error)}` };
    for (const r of (Array.isArray(data) ? data : []) as Array<{ id: number; txn_date: string | null; ref: string | null; acquirer_code: string | null }>) settleRows.set(Number(r.id), r);
  }
  const payoutKeys = docsOf(['SETTLEBANK']);
  const receiptIds = [...new Set(payoutKeys.map((k) => Number(k.split('-')[2])).filter((n) => Number.isInteger(n)))];
  const batchIds = new Set(payoutKeys.map((k) => Number(k.split('-')[1])).filter((n) => Number.isInteger(n)));
  const receipts = new Map<number, { received_on: string; bank_ref: string | null }>();
  if (receiptIds.length > 0) {
    const { data, error } = await sb.from('acc_settlement_receipts').select('id, received_on, bank_ref').eq('company_id', companyId).in('id', receiptIds);
    if (error) return { ok: false, reason: `settlement receipts: ${String(error.message ?? error)}` };
    for (const r of (Array.isArray(data) ? data : []) as Array<{ id: number; received_on: string | null; bank_ref: string | null }>) receipts.set(Number(r.id), { received_on: String(r.received_on ?? '').slice(0, 10), bank_ref: r.bank_ref ?? null });
  }
  const chargeKeys = docsOf(['SETTLECHARGE']);
  const payoutBatchIds = [...new Set(chargeKeys.map((k) => Number(k.split('-')[1])).filter((n) => Number.isInteger(n)))];
  const charges = new Map<number, { settled_on: string; batch_id: number | null }>();
  if (payoutBatchIds.length > 0) {
    const { data, error } = await sb.from('acc_settlement_payout_batches').select('id, settled_on, batch_id').eq('company_id', companyId).in('id', payoutBatchIds);
    if (error) return { ok: false, reason: `payout charges: ${String(error.message ?? error)}` };
    for (const r of (Array.isArray(data) ? data : []) as Array<{ id: number; settled_on: string | null; batch_id: number | null }>) {
      charges.set(Number(r.id), { settled_on: String(r.settled_on ?? '').slice(0, 10), batch_id: r.batch_id == null ? null : Number(r.batch_id) });
      if (r.batch_id != null) batchIds.add(Number(r.batch_id));
    }
  }
  const acquirerOfBatch = new Map<number, string>();
  if (batchIds.size > 0) {
    const { data, error } = await sb.from('acc_settlement_batches').select('id, acquirer_code').eq('company_id', companyId).in('id', [...batchIds]);
    if (error) return { ok: false, reason: `settlement batches: ${String(error.message ?? error)}` };
    for (const b of (Array.isArray(data) ? data : []) as Array<{ id: number; acquirer_code: string }>) acquirerOfBatch.set(Number(b.id), String(b.acquirer_code));
  }

  for (const e of entries) {
    const base = baseTypeOf(e.sourceType);
    const doc = e.sourceDocNo ? String(e.sourceDocNo) : null;
    const party = e.partyName ? String(e.partyName) : null;
    const note = e.notes ? String(e.notes) : null;
    let ref: JournalRef;
    if (base === 'SOCONV' && doc) {
      const so = orderOfPayment.get(doc) ?? null;
      const from = movedFrom.get(doc) ?? null;
      ref = {
        reference: so ? (from ? `${so} ← ${from}` : so) : doc,
        who: (so ? customerOfOrder.get(so) : null) || party || note,
        doc: so ?? doc,
        doc2: from,
      };
    } else if ((base === 'SOPAY' || base === 'SIPAY') && doc) {
      const so = orderOfPayment.get(doc) ?? null;
      const or = receiptOfPayment.get(doc) ?? null;
      ref = {
        reference: so ? (or ? `${or} · ${so}` : so) : (or ?? doc),
        /* The order's customer; failing that the party, failing that the note. */
        who: (so ? customerOfOrder.get(so) : null) || party || note,
        doc: or ?? so ?? doc,
        doc2: or ? so : null,
      };
    } else if (base === 'SETTLEBANK' && doc) {
      const [, batch, receipt] = doc.split('-');
      const acquirer = acquirerOfBatch.get(Number(batch)) ?? 'Card';
      const r = receipts.get(Number(receipt));
      ref = { reference: `${acquirer} payout${r?.received_on ? ` ${fmtDate(r.received_on)}` : ''}`, who: acquirer, doc: `${acquirer} payout${r?.received_on ? ` ${fmtDate(r.received_on)}` : ''}`, doc2: r?.bank_ref ?? null };
    } else if ((base === 'SETTLE' || base === 'SETTLEMOVE') && doc) {
      const row = settleRows.get(Number(doc.split('-')[1]));
      const acquirer = row?.acquirer_code ?? 'Card';
      ref = { reference: doc, who: party ?? acquirer, doc: row ? `${acquirer} settlement${row.txn_date ? ` ${fmtDate(String(row.txn_date).slice(0, 10))}` : ''}` : doc, doc2: row?.ref ?? null };
    } else if (base === 'SETTLECHARGE' && doc) {
      const ch = charges.get(Number(doc.split('-')[1]));
      const acquirer = ch?.batch_id != null ? (acquirerOfBatch.get(ch.batch_id) ?? 'Card') : 'Card';
      ref = { reference: doc, who: party ?? acquirer, doc: ch ? `${acquirer} charge${ch.settled_on ? ` ${fmtDate(ch.settled_on)}` : ''}` : doc, doc2: null };
    } else if (base === 'STOCKADJ' && doc) {
      ref = { reference: doc, who: party ?? note, doc: stockMonthLabel(doc), doc2: null };
    } else if (base === 'PI' && doc) {
      ref = { reference: doc, who: party ?? note, doc, doc2: str(pis.rows.get(doc)?.supplier_invoice_ref) };
    } else if (base === 'API' && doc) {
      ref = { reference: doc, who: party ?? note, doc, doc2: str(apis.rows.get(doc)?.supplier_invoice_ref) };
    } else if (base === 'SI' && doc) {
      const si = sis.rows.get(doc);
      ref = { reference: doc, who: party ?? str(si?.debtor_name) ?? note, doc, doc2: str(si?.so_doc_no) };
    } else if (base === 'DI' && doc) {
      const di = dis.rows.get(doc);
      ref = { reference: doc, who: party ?? str(di?.party_name) ?? note, doc, doc2: str(di?.so_doc_no) };
    } else if (base === 'CN' && doc) {
      const cn = cns.rows.get(doc);
      ref = { reference: doc, who: party ?? str(cn?.party_name) ?? note, doc, doc2: str(cn?.so_doc_no) };
    } else if (base === 'PV' && doc) {
      const pv = pvs.rows.get(doc);
      ref = { reference: doc, who: party ?? str(pv?.payee_name) ?? note, doc, doc2: str(pv?.refund_source_doc_no) };
    } else {
      ref = { reference: doc, who: party ?? note, doc, doc2: null };
    }
    refs.set(e.jeNo, ref);
  }
  return { ok: true, refs };
}

/** The entries with their reference and who written on — what a list prints. */
export async function withJournalRefs<T extends JournalRefSource>(sb: Db, companyId: number, entries: T[]): Promise<{ ok: true; entries: Array<T & JournalRef> } | { ok: false; reason: string }> {
  const r = await resolveJournalRefs(sb, companyId, entries);
  if (!r.ok) return r;
  return { ok: true, entries: entries.map((e) => ({ ...e, ...(r.refs.get(e.jeNo) ?? { reference: e.sourceDocNo ?? null, who: e.partyName ?? null, doc: e.sourceDocNo ?? null, doc2: null }) })) };
}
