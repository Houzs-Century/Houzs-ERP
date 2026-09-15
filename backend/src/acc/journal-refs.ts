// ----------------------------------------------------------------------------
// journal-refs — what a journal entry IS, in the words a person recognises
// (owner 2026-09-15, docs/bugs/0918, on the bank reconciliation's outstanding
// list: 我需要看到 customer name，然后 source 改成 reference 吧，就是 or number, pv
// number 等等 … so number 我还是需要). An entry's source is a system word and
// a key ("SOPAY · 0bb232ad-…"); its REFERENCE is the document a person holds
// and its WHO is the customer, the payee or the merchant. Resolved here for a
// batch of entries, in a handful of reads, so every screen that lists
// entries (the bank reconciliation today, the general ledger next) names
// them the same way.
//
//   SOPAY / SIPAY   the payment's official receipt number when one exists,
//                   and ALWAYS the sales order number (OR · SO); who = the
//                   order's customer
//   PV              the voucher number; who = the payee
//   PI / API        the invoice number; who = the supplier
//   RCT / ODR       the receipt number; who = the debtor
//   SETTLEBANK      "<acquirer> payout dd/mm/yyyy" off the settlement receipt;
//                   who = the acquirer
//   anything else   the source document number as it is; who = the party, or
//                   the entry's note
// A reversal (…_REVERSAL) reads as its original does.
// ----------------------------------------------------------------------------

import { fmtDate } from '../scm/shared/format';

export type JournalRefSource = {
  jeNo: string;
  sourceType: string | null;
  sourceDocNo: string | null;
  partyName?: string | null;
  notes?: string | null;
};

export type JournalRef = { reference: string | null; who: string | null };

type Db = any;

const CHUNK = 150;
const chunks = <T>(xs: T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
  return out;
};

const baseTypeOf = (t: string | null): string => String(t ?? '').replace(/_REVERSAL$/, '');

/**
 * Resolve the reference and the who of every entry given, keyed by je_no.
 * Reads only what the entries call for — the payments, orders, receipts and
 * settlement receipts they name — and answers for the rest without a read.
 * An entry the reads cannot place keeps its source document number.
 */
export async function resolveJournalRefs(sb: Db, companyId: number, entries: JournalRefSource[]): Promise<{ ok: true; refs: Map<string, JournalRef> } | { ok: false; reason: string }> {
  const refs = new Map<string, JournalRef>();

  /* ── Sales-order payments: the payment → its order and its receipt ─────── */
  const paymentIds = [...new Set(entries.filter((e) => ['SOPAY', 'SIPAY'].includes(baseTypeOf(e.sourceType)) && e.sourceDocNo).map((e) => String(e.sourceDocNo)))];
  const orderOfPayment = new Map<string, string>();
  const receiptOfPayment = new Map<string, string>();
  const customerOfOrder = new Map<string, string>();
  for (const ids of chunks(paymentIds)) {
    const { data, error } = await sb.from('mfg_sales_order_payments').select('id, so_doc_no').eq('company_id', companyId).in('id', ids);
    if (error) return { ok: false, reason: `payments: ${String(error.message ?? error)}` };
    for (const p of (Array.isArray(data) ? data : []) as Array<{ id: string; so_doc_no: string }>) orderOfPayment.set(String(p.id), String(p.so_doc_no));
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

  /* ── Settlement payouts: the receipt → its day, the batch → its acquirer ── */
  const payoutKeys = entries.filter((e) => baseTypeOf(e.sourceType) === 'SETTLEBANK' && e.sourceDocNo).map((e) => String(e.sourceDocNo));
  const receiptIds = [...new Set(payoutKeys.map((k) => Number(k.split('-')[2])).filter((n) => Number.isInteger(n)))];
  const batchIds = [...new Set(payoutKeys.map((k) => Number(k.split('-')[1])).filter((n) => Number.isInteger(n)))];
  const receivedOn = new Map<number, string>();
  const acquirerOfBatch = new Map<number, string>();
  if (receiptIds.length > 0) {
    const { data, error } = await sb.from('acc_settlement_receipts').select('id, received_on').eq('company_id', companyId).in('id', receiptIds);
    if (error) return { ok: false, reason: `settlement receipts: ${String(error.message ?? error)}` };
    for (const r of (Array.isArray(data) ? data : []) as Array<{ id: number; received_on: string | null }>) receivedOn.set(Number(r.id), String(r.received_on ?? '').slice(0, 10));
  }
  if (batchIds.length > 0) {
    const { data, error } = await sb.from('acc_settlement_batches').select('id, acquirer_code').eq('company_id', companyId).in('id', batchIds);
    if (error) return { ok: false, reason: `settlement batches: ${String(error.message ?? error)}` };
    for (const b of (Array.isArray(data) ? data : []) as Array<{ id: number; acquirer_code: string }>) acquirerOfBatch.set(Number(b.id), String(b.acquirer_code));
  }

  for (const e of entries) {
    const base = baseTypeOf(e.sourceType);
    const doc = e.sourceDocNo ? String(e.sourceDocNo) : null;
    const party = e.partyName ? String(e.partyName) : null;
    let ref: JournalRef;
    if ((base === 'SOPAY' || base === 'SIPAY') && doc) {
      const so = orderOfPayment.get(doc) ?? null;
      const or = receiptOfPayment.get(doc) ?? null;
      ref = {
        reference: so ? (or ? `${or} · ${so}` : so) : (or ?? doc),
        /* The order's customer; failing that the party, failing that the note. */
        who: (so ? customerOfOrder.get(so) : null) || party || (e.notes ? String(e.notes) : null),
      };
    } else if (base === 'SETTLEBANK' && doc) {
      const [, batch, receipt] = doc.split('-');
      const acquirer = acquirerOfBatch.get(Number(batch)) ?? 'Card';
      const day = receivedOn.get(Number(receipt));
      ref = { reference: `${acquirer} payout${day ? ` ${fmtDate(day)}` : ''}`, who: acquirer };
    } else {
      ref = { reference: doc, who: party ?? (e.notes ? String(e.notes) : null) };
    }
    refs.set(e.jeNo, ref);
  }
  return { ok: true, refs };
}

/** The entries with their reference and who written on — what a list prints. */
export async function withJournalRefs<T extends JournalRefSource>(sb: Db, companyId: number, entries: T[]): Promise<{ ok: true; entries: Array<T & JournalRef> } | { ok: false; reason: string }> {
  const r = await resolveJournalRefs(sb, companyId, entries);
  if (!r.ok) return r;
  return { ok: true, entries: entries.map((e) => ({ ...e, ...(r.refs.get(e.jeNo) ?? { reference: e.sourceDocNo ?? null, who: e.partyName ?? null }) })) };
}
