/* The Receipts & Payments tab (owner 2026-09-06/07): a column per money
   account plus Total, receipts above payments, opening and closing per
   column, rows in the owner's accounts, a figure that opens its entries. The
   server half is backend/tests/rpReport.test.ts. */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { RpReport } from '../../vendor/scm/lib/rp-report-queries';

const report: RpReport = {
  from: '2026-07-01', to: '2026-07-31', byParty: false,
  columns: [{ code: '310-0010', name: 'CASH AT BANK - MAYBANK' }, { code: '320-0000', name: 'CASH IN HAND' }],
  opening: { '310-0010': -10000, '320-0000': 0 },
  receipts: [
    { key: '300-0000', code: '300-0000', name: 'ACCOUNT RECEIVEABLE', cells: { '310-0010': 50000 }, totalSen: 50000 },
    { key: 'XFER:310-0010', code: '310-0010', name: 'Transfer from 310-0010 · CASH AT BANK - MAYBANK', cells: { '320-0000': 20000 }, totalSen: 20000 },
  ],
  payments: [
    { key: '601-0003', code: '601-0003', name: 'PURCHASE OF SOFA', cells: { '310-0010': 40000 }, totalSen: 40000 },
    { key: 'ADV', code: null, name: 'Supplier advances (预付)', cells: { '310-0010': 30000 }, totalSen: 30000 },
    { key: '910-0000', code: '910-0000', name: 'UTILITIES', cells: { '320-0000': 6000 }, totalSen: 6000 },
  ],
  totals: {
    receipts: { '310-0010': 50000, '320-0000': 20000 }, payments: { '310-0010': 70000, '320-0000': 6000 },
    closing: { '310-0010': -30000, '320-0000': 14000 }, openingTotalSen: -10000, receiptsTotalSen: 70000, paymentsTotalSen: 76000, closingTotalSen: -16000,
  },
  entries: [
    { jeNo: 'JE-1', entryDate: '2026-07-05', sourceType: 'SOPAY', sourceDocNo: 'pay-1', narration: null, party: 'Ah Meng', side: 'R', rowKey: '300-0000', column: '310-0010', sen: 50000 },
    { jeNo: 'JE-3', entryDate: '2026-07-15', sourceType: 'PV', sourceDocNo: 'PV-3', narration: null, party: 'FOSHAN CHAIRS', side: 'P', rowKey: '601-0003', column: '310-0010', sen: 40000 },
    { jeNo: 'JE-3', entryDate: '2026-07-15', sourceType: 'PV', sourceDocNo: 'PV-3', narration: null, party: 'FOSHAN CHAIRS', side: 'P', rowKey: 'ADV', column: '310-0010', sen: 30000 },
  ],
};
const lastPath = { value: '' };

vi.mock('../../vendor/scm/lib/rp-report-queries', async (importOriginal) => ({
  ...(await importOriginal() as object),
  useRpReport: (from: string, to: string, accounts: string[], byParty: boolean) => {
    lastPath.value = `${from}|${to}|${accounts.join(',')}|${byParty}`;
    return { data: report, isLoading: false, isError: false };
  },
}));
vi.mock('../../vendor/scm/lib/accounting-queries', () => ({
  useAccounts: () => ({ data: { accounts: [
    { account_code: '310-0010', account_name: 'CASH AT BANK - MAYBANK', account_type: 'ASSET', is_active: true, acc_money: true },
    { account_code: '320-0000', account_name: 'CASH IN HAND', account_type: 'ASSET', is_active: true, acc_money: true },
    { account_code: '910-0000', account_name: 'UTILITIES', account_type: 'EXPENSE', is_active: true, acc_money: false },
  ] }, isLoading: false }),
}));
vi.mock('../../vendor/scm/lib/rp-report-pdf', async (importOriginal) => ({
  ...(await importOriginal() as object),
  generateRpPdf: vi.fn(async () => undefined),
}));

import { ReceiptsPaymentsTab } from './ReceiptsPayments';
import { generateRpPdf } from '../../vendor/scm/lib/rp-report-pdf';

describe('the Receipts & Payments tab', () => {
  test('columns per money account, receipts above payments, the four balance lines, brackets for a negative', () => {
    render(<ReceiptsPaymentsTab />);
    expect(screen.getByText('310-0010', { selector: 'th' })).toBeTruthy();
    expect(screen.getByText('RECEIPTS')).toBeTruthy();
    expect(screen.getByText('PAYMENTS')).toBeTruthy();
    expect(screen.getByText('Opening balance').closest('tr')!.textContent).toContain('(100.00)');
    expect(screen.getByText('Total receipts').closest('tr')!.textContent).toContain('700.00');
    expect(screen.getByText('Total payments').closest('tr')!.textContent).toContain('760.00');
    expect(screen.getByText('Closing balance').closest('tr')!.textContent).toContain('(160.00)');
    /* A coded row renders "code · name" in two nodes — match the name node. */
    expect(screen.getByText(/PURCHASE OF SOFA/)).toBeTruthy();
    expect(screen.getByText('Supplier advances (预付)')).toBeTruthy();
  });

  test('a figure opens the entries behind it; the toggle and the account ticks change the read', () => {
    render(<ReceiptsPaymentsTab />);
    fireEvent.click(screen.getByLabelText('PURCHASE OF SOFA 310-0010'));
    expect(screen.getByText(/PURCHASE OF SOFA · 310-0010 — 1 entry/)).toBeTruthy();
    expect(screen.getByText('FOSHAN CHAIRS')).toBeTruthy();
    expect(screen.getByText(/Payment voucher PV-3/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Show debtor and creditor names'));
    expect(lastPath.value.endsWith('|true')).toBe(true);
    fireEvent.click(screen.getByLabelText('Column 320-0000'));
    expect(lastPath.value).toContain('|310-0010|');
  });

  test('Print hands the report to the PDF', () => {
    render(<ReceiptsPaymentsTab />);
    fireEvent.click(screen.getByText('Print'));
    expect(vi.mocked(generateRpPdf)).toHaveBeenCalledWith(report);
  });
});
