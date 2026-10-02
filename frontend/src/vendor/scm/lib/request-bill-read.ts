// ----------------------------------------------------------------------------
// request-bill-read — the bill a payment request carries, READ as it is
// attached (owner 2026-10-01, payment-request item 1 → 做). One hook for the
// desktop form and the phone sheet: pick the bill's page(s) and the server
// reads its number, date and total, whether it is for an event (and which
// events it points at), and every other live request, voucher or AP invoice
// carrying the same number and date. A newer pick supersedes an older read; a
// read that fails says so and the request still goes — Finance reads the bill
// again when it answers.
// ----------------------------------------------------------------------------

import { useCallback, useRef, useState } from 'react';
import { useReadRequestBill, type PaymentRequestInput, type ReadBillResult } from './payment-request-queries';
import { fileToBase64 } from './payment-voucher-queries';

export type BillRead = Extract<ReadBillResult, { ok: true }>;
export type BillReadState =
  | { status: 'idle' }
  | { status: 'reading' }
  | { status: 'failed'; reason: string }
  | { status: 'done'; result: BillRead };

export function useRequestBillRead() {
  const read = useReadRequestBill();
  const [state, setState] = useState<BillReadState>({ status: 'idle' });
  const seq = useRef(0);
  const run = useCallback(async (files: File[]): Promise<BillRead | null> => {
    seq.current += 1;
    const mine = seq.current;
    if (files.length === 0) { setState({ status: 'idle' }); return null; }
    setState({ status: 'reading' });
    try {
      const payload = await Promise.all(files.map(async (f) => ({ name: f.name, mime: f.type || 'application/pdf', dataBase64: await fileToBase64(f) })));
      const res = await read.mutateAsync({ files: payload });
      if (mine !== seq.current) return null;
      if (!res.ok) { setState({ status: 'failed', reason: res.reason }); return null; }
      setState({ status: 'done', result: res });
      return res;
    } catch (e) {
      if (mine !== seq.current) return null;
      setState({ status: 'failed', reason: e instanceof Error ? e.message : 'The bill could not be read.' });
      return null;
    }
    // `read` is a fresh object every render; its mutateAsync is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [read.mutateAsync]);
  return { state, run };
}

/** What a read bill adds to the request's body — nothing until it is read. */
export const billFactsOf = (state: BillReadState): Partial<PaymentRequestInput> =>
  state.status === 'done'
    ? { billNo: state.result.bill.billNo, billDate: state.result.bill.billDate, billTotalSen: state.result.bill.totalSen, eventBill: state.result.eventBill }
    : {};

/** Does this read bill need an Event (or a reason why there is none)? */
export const needsEvent = (state: BillReadState): boolean => state.status === 'done' && state.result.eventBill;

/* ── The form filled from the paper (owner 2026-10-02: upload 后很多资料都没有填;
   自动填了资料还能手动改) ─────────────────────────────────────────────────────
   A read bill OFFERS a value for each field it printed. A field takes the offer
   when it is empty, or when it still holds what the previous read offered (the
   requester has not touched it — a phone adds a bill page by page, and a later
   page may say more). What the requester typed is never replaced, and every
   field stays theirs to change. */
const FILLABLE = ['payeeName', 'amountSen', 'dueDate', 'purpose', 'bankName', 'bankAccountNo', 'bankAccountName'] as const;
export type BillFillField = typeof FILLABLE[number];
export type BillOffer = Partial<Pick<PaymentRequestInput, BillFillField>>;

/** What the read bill offers each field — only what it printed. */
export function billOffer(bill: BillRead['bill'] | null | undefined): BillOffer {
  if (!bill) return {};
  const offer: BillOffer = {};
  const t = (s: string | null | undefined): string | null => (s ?? '').trim() || null;
  const payee = t(bill.vendorName);
  if (payee) offer.payeeName = payee;
  if (bill.totalSen != null && bill.totalSen > 0) offer.amountSen = bill.totalSen;
  const due = t(bill.dueDate);
  if (due) offer.dueDate = due;
  const purpose = t(bill.summary);
  if (purpose) offer.purpose = purpose;
  const bank = t(bill.bankName);
  if (bank) offer.bankName = bank;
  const accountNo = t(bill.bankAccountNo);
  if (accountNo) offer.bankAccountNo = accountNo;
  const accountName = t(bill.bankAccountName);
  if (accountName) offer.bankAccountName = accountName;
  return offer;
}

const isBlank = (v: string | number | null | undefined): boolean =>
  typeof v === 'number' ? !(v > 0) : (v ?? '').trim() === '';

function take<K extends BillFillField>(form: PaymentRequestInput, k: K, offer: BillOffer, before: BillOffer): void {
  const value = offer[k];
  if (value === undefined) return;
  const current = form[k];
  if (isBlank(current) || (before[k] !== undefined && current === before[k])) form[k] = value;
}

/** The form with the bill's offers taken where the field is empty or still the
    previous read's offer (`before`). Pure — safe inside a state updater. */
export function fillFromBill(form: PaymentRequestInput, offer: BillOffer, before: BillOffer = {}): PaymentRequestInput {
  const next: PaymentRequestInput = { ...form };
  for (const k of FILLABLE) take(next, k, offer, before);
  return FILLABLE.some((k) => next[k] !== form[k]) ? next : form;
}

/** The fields still holding what the bill offered — said under the form. */
export const filledFromBill = (form: PaymentRequestInput, offer: BillOffer): BillFillField[] =>
  FILLABLE.filter((k) => offer[k] !== undefined && form[k] === offer[k]);

export const BILL_FILL_LABEL: Record<BillFillField, string> = {
  payeeName: 'Pay to', amountSen: 'Amount', dueDate: 'Pay by', purpose: 'What it is for',
  bankName: "Payee's bank", bankAccountNo: 'Account no.', bankAccountName: 'Account name',
};
