// pv-from-requests — what ONE voucher answering several payment requests is
// pre-filled with (owner 2026-11-04: combine payment request 做一张pv — 不同人
// 也可以). One line per request, its number, purpose and amount, in the order
// ticked; the payee only when every request names the same one (else left for
// Finance, as the petty-cash voucher of Scan bills does); the bank only when
// every request that names one names the same (owner 2026-11-08: the bank in its
// own fields, the Description only what the money is for). Saving sends
// paymentRequestIds and the server claims every request for the voucher.

import type { PaymentRequest } from '../../vendor/scm/lib/payment-request-queries';
import { NO_PAY_TO, isBlankPayTo, payToOf, samePayTo, type PayTo } from './pv-pay-to';

type Req = Pick<PaymentRequest, 'request_no' | 'payee_name' | 'purpose' | 'amount_sen' | 'project_id' | 'bank_name' | 'bank_account_no' | 'bank_account_name'>;

export type RequestsPrefill = {
  payeeName: string;
  /** What the money is for: each purpose once. */
  notes: string;
  payTo: PayTo;
  /** The requests name different banks, so none was filled. */
  banksDiffer: boolean;
  lines: Array<{ description: string; amountSen: number; projectId: number | null }>;
  totalSen: number;
};

/** The ids in `?fromRequests=a,b,c`, de-duplicated, in order. */
export const requestIdsOf = (param: string | null): string[] =>
  [...new Set((param ?? '').split(',').map((s) => s.trim()).filter(Boolean))];

export function prefillFromRequests(reqs: Req[]): RequestsPrefill {
  const payees = [...new Set(reqs.map((r) => r.payee_name.trim().toUpperCase()))];
  const banks = reqs.map(payToOf).filter((b) => !isBlankPayTo(b));
  const oneBank = banks.length > 0 && banks.every((b) => samePayTo(b, banks[0]!));
  return {
    payeeName: payees.length === 1 ? reqs[0]!.payee_name : '',
    notes: [...new Set(reqs.map((r) => r.purpose.trim()).filter(Boolean))].join('; '),
    payTo: oneBank ? banks[0]! : NO_PAY_TO,
    banksDiffer: banks.length > 0 && !oneBank,
    lines: reqs.map((r) => ({ description: `${r.request_no} ${r.purpose}`.slice(0, 200), amountSen: r.amount_sen, projectId: r.project_id })),
    totalSen: reqs.reduce((s, r) => s + r.amount_sen, 0),
  };
}
