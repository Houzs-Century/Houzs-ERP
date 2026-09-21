/* The three multi-line branding settings (owner 2026-09-21: the papers that ask
   for money say where to pay — customers to one account, other debtors to
   another — and the Other Debtor invoice carries terms). Pinned: the
   normaliser reads camelCase or snake_case, a blank stays blank (the paper
   omits the block), and both companies' defaults are blank. */
import { describe, expect, test } from 'vitest';
import { DEFAULT_BRANDING, DEFAULT_BRANDING_2990, normalizeBranding } from './branding';
import { settingLines } from '../vendor/scm/lib/pdf-common';

describe('payment details and terms', () => {
  test('normalised from camelCase or snake_case, trimmed at the ends only, blank when absent', () => {
    const camel = normalizeBranding({ companyName: 'X', customerPaymentDetails: ' CIMB 8000\n2990 HOME ', debtorPaymentDetails: 'Maybank 5644', debtorInvoiceTerms: 'Pay in 14 days.' });
    expect([camel.customerPaymentDetails, camel.debtorPaymentDetails, camel.debtorInvoiceTerms]).toEqual(['CIMB 8000\n2990 HOME', 'Maybank 5644', 'Pay in 14 days.']);
    const snake = normalizeBranding({ company_name: 'X', customer_payment_details: 'CIMB', debtor_payment_details: 'MBB', debtor_invoice_terms: 'T1\nT2' });
    expect([snake.customerPaymentDetails, snake.debtorPaymentDetails, snake.debtorInvoiceTerms]).toEqual(['CIMB', 'MBB', 'T1\nT2']);
    const none = normalizeBranding({ companyName: 'X' });
    expect([none.customerPaymentDetails, none.debtorPaymentDetails, none.debtorInvoiceTerms]).toEqual(['', '', '']);
    expect([DEFAULT_BRANDING.customerPaymentDetails, DEFAULT_BRANDING_2990.debtorInvoiceTerms]).toEqual(['', '']);
  });

  test('the lines a setting prints: one per line, trimmed, blank lines dropped, CRLF tolerated', () => {
    expect(settingLines(' Maybank 5644 \r\n\n HOUZS CENTURY SDN BHD\n')).toEqual(['Maybank 5644', 'HOUZS CENTURY SDN BHD']);
    expect(settingLines('')).toEqual([]);
    expect(settingLines(null)).toEqual([]);
  });
});
