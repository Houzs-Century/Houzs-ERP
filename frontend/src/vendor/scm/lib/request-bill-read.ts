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
