// pv-from-requests — what ONE voucher answering several payment requests is
// pre-filled with (owner 2026-11-04: combine payment request 做一张pv — 不同人
// 也可以). One line per request, its purpose and amount, in the order ticked;
// the payee only when every request names the same one (else left for Finance,
// as the petty-cash voucher of Scan bills does); each request and the bank it
// asks to be paid into named in the notes. Saving sends paymentRequestIds and
// the server claims every request for the voucher.

import type { PaymentRequest } from '../../vendor/scm/lib/payment-request-queries';

type Req = Pick<PaymentRequest, 'request_no' | 'payee_name' | 'purpose' | 'amount_sen' | 'project_id' | 'bank_name' | 'bank_account_no' | 'bank_account_name'>;

export type RequestsPrefill = {
  payeeName: string;
  notes: string;
  lines: Array<{ description: string; amountSen: number; projectId: number | null }>;
  totalSen: number;
};

/** The ids in `?fromRequests=a,b,c`, de-duplicated, in order. */
export const requestIdsOf = (param: string | null): string[] =>
  [...new Set((param ?? '').split(',').map((s) => s.trim()).filter(Boolean))];

export function prefillFromRequests(reqs: Req[]): RequestsPrefill {
  const payees = [...new Set(reqs.map((r) => r.payee_name.trim().toUpperCase()))];
  const payTo = (r: Req) => [r.bank_name, r.bank_account_no, r.bank_account_name].filter(Boolean).join(' ');
  return {
    payeeName: payees.length === 1 ? reqs[0]!.payee_name : '',
    notes: `Payment requests ${reqs.map((r) => `${r.request_no} (${r.payee_name}${payTo(r) ? ` · ${payTo(r)}` : ''})`).join('; ')}`,
    lines: reqs.map((r) => ({ description: `${r.request_no} ${r.purpose}`.slice(0, 200), amountSen: r.amount_sen, projectId: r.project_id })),
    totalSen: reqs.reduce((s, r) => s + r.amount_sen, 0),
  };
}
