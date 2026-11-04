/* One voucher answering several payment requests (owner 2026-11-04: combine
   payment request 做一张pv — 不同人也可以): which requests may be ticked, the
   link the button opens, and what the voucher is pre-filled with. The server
   side (each request claimed, or none) is pinned in
   backend/tests/paymentRequests.test.ts. */
import { describe, expect, it } from 'vitest';
import type { PaymentRequest } from '../../vendor/scm/lib/payment-request-queries';
import { prefillFromRequests, requestIdsOf } from './pv-from-requests';
import { combinable, oneVoucherHref } from './PaymentRequestsFinance';

const req = (over: Partial<PaymentRequest>): PaymentRequest => ({
  id: 'a', request_no: '2990-PRQ-2611-002', payee_name: 'CHOW WAI MAN', purpose: 'lalamove', amount_sen: 3320, project_id: null,
  bank_name: 'Maybank', bank_account_no: '5232', bank_account_name: 'CHOW WAI MAN', stage: 'SUBMITTED', refund_source_doc_no: null,
  ...over,
} as PaymentRequest);

describe('combining payment requests into one voucher', () => {
  it('only a waiting, plain payment request can be ticked', () => {
    expect(combinable(req({}))).toBe(true);
    expect(combinable(req({ stage: 'PROCESSING' } as Partial<PaymentRequest>))).toBe(false);
    expect(combinable(req({ refund_source_doc_no: 'SO-1' }))).toBe(false);
  });

  it('the button opens the voucher with every ticked id, and the voucher reads them back once each', () => {
    const href = oneVoucherHref(['a', 'b']);
    expect(href).toBe('/scm/payment-vouchers/new?fromRequests=a,b');
    expect(requestIdsOf(new URL(href, 'http://x').searchParams.get('fromRequests'))).toEqual(['a', 'b']);
    expect(requestIdsOf('a, b,,a')).toEqual(['a', 'b']);
  });

  it('one payee is kept; different payees leave it blank; one line per request; each bank in the notes', () => {
    const same = prefillFromRequests([req({}), req({ id: 'b', request_no: '2990-PRQ-2611-003', purpose: 'soy sauce', amount_sen: 749, payee_name: 'chow wai man ' })]);
    expect(same.payeeName).toBe('CHOW WAI MAN');
    expect(same.totalSen).toBe(4069);
    const mixed = prefillFromRequests([req({}), req({ id: 'c', request_no: '2990-PRQ-2611-010', payee_name: 'LOO WEN WEI', purpose: 'meta ads', amount_sen: 11786, bank_account_no: null, bank_account_name: 'LOO WEN WEI' })]);
    expect(mixed.payeeName).toBe('');
    expect(mixed.lines).toEqual([
      { description: '2990-PRQ-2611-002 lalamove', amountSen: 3320, projectId: null },
      { description: '2990-PRQ-2611-010 meta ads', amountSen: 11786, projectId: null },
    ]);
    expect(mixed.notes).toBe('Payment requests 2990-PRQ-2611-002 (CHOW WAI MAN · Maybank 5232 CHOW WAI MAN); 2990-PRQ-2611-010 (LOO WEN WEI · Maybank LOO WEN WEI)');
  });
});
