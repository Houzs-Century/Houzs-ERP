/* 欠正式单 (owner 2026-10-01, payment-request item 3) on the AP invoice form: a
   bill the reader read as a PROFORMA or QUOTATION is booked owing its official
   invoice — pre-ticked; the flag rides the submit only when ticked. */

import { describe, expect, test } from 'vitest';
import { emptyApForm, formFromExtraction, formFromRequest, isProvisional, toSubmit } from './ApInvoiceForm';
import type { BillExtraction } from '../../vendor/scm/lib/payment-voucher-queries';

const read = (documentKind: BillExtraction['documentKind']): BillExtraction => ({
  vendorName: 'MLE EVENTS SDN BHD', vendorRegNo: null, documentKind, invoiceNumber: 'PF-0925', invoiceDate: '2026-09-01', dueDate: null,
  currency: 'MYR', totalSen: 850_000, sstSen: null, lines: [{ description: 'Booth F1 rental', amountSen: 850_000 }], event: null,
} as BillExtraction);

describe('the AP invoice form and the official invoice', () => {
  test('a proforma or a quotation pre-ticks 欠正式单; an invoice does not', () => {
    expect(formFromExtraction(read('proforma'), null, null).officialDocOwed).toBe(true);
    expect(formFromExtraction(read('quotation'), null, null).officialDocOwed).toBe(true);
    expect(formFromExtraction(read('invoice'), null, null).officialDocOwed).toBeUndefined();
    expect(isProvisional({ documentKind: 'receipt' })).toBe(false);
  });

  test('the submit carries the flag only when ticked', () => {
    const base = { ...emptyApForm(), supplierId: 'sup-1', lines: [{ rid: 1, description: 'Booth', debitAccountCode: '900-R032', amountSen: 100, projectId: null }] };
    expect(toSubmit(base)).not.toHaveProperty('officialDocOwed');
    expect(toSubmit({ ...base, officialDocOwed: true })).toMatchObject({ officialDocOwed: true });
  });
});

/* Owner 2026-10-02 (多一个第五给他们写note): the requester's note comes along into the invoice's notes. */
test('an AP invoice answering a request carries the requester\'s note', () => {
  const r = { request_no: 'HC-PRQ-2610-002', requested_by_name: 'James Seow', purpose: 'Booth F1 rental', amount_sen: 850_000, due_date: null, project_id: null };
  expect(formFromRequest({ ...r, note: 'Pay before 25/09' }, undefined, null).initial.description).toBe('Payment request HC-PRQ-2610-002 — Booth F1 rental · Note: Pay before 25/09');
  expect(formFromRequest(r, undefined, null).initial.description).toBe('Payment request HC-PRQ-2610-002 — Booth F1 rental');
});
