/* The Receipts & Payments tab (owner 2026-09-06/07): a column per money
   account plus Total, receipts above payments, opening and closing per
   column, rows in the owner's accounts, a figure that opens its entries. The
   server half is backend/tests/rpReport.test.ts. */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { RpReport } from '../../vendor/scm/lib/rp-report-queries';
import type { LaidNode } from '../../vendor/scm/lib/report-layout';

const line = (key: string, code: string, label: string, cells: Record<string, number>, pct: number): LaidNode =>
  ({ kind: 'account', id: `acc:${key}`, label, code, key, amountSen: Object.values(cells).reduce((s, v) => s + v, 0), pct, cells, children: [] });

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
  /* The rows on the tree (docs/bugs/0912): the owner's "Purchases" holds the
     sofa row; the advance follows the tree. */
  layout: {
    stored: true,
    receipts: [
      { kind: 'category', id: 'sec:CURRENT ASSETS', label: 'CURRENT ASSETS', amountSen: 70000, pct: 100, cells: { '310-0010': 50000, '320-0000': 20000 }, children: [
        line('300-0000', '300-0000', '300-0000 · ACCOUNT RECEIVEABLE', { '310-0010': 50000 }, 71.4),
        line('XFER:310-0010', '310-0010', 'Transfer from 310-0010 · CASH AT BANK - MAYBANK', { '320-0000': 20000 }, 28.6),
      ] },
    ],
    payments: [
      { kind: 'category', id: 'cat:purchases', label: 'Purchases', amountSen: 40000, pct: 52.6, cells: { '310-0010': 40000 }, children: [
        line('601-0003', '601-0003', '601-0003 · PURCHASE OF SOFA', { '310-0010': 40000 }, 52.6),
      ] },
      line('910-0000', '910-0000', '910-0000 · UTILITIES', { '320-0000': 6000 }, 7.9),
      line('ADV', 'ADV', 'Supplier advances (预付)', { '310-0010': 30000 }, 39.5),
    ],
  },
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
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock('./ReportLayoutEditor', () => ({ ReportLayoutEditor: () => <div role="dialog" aria-label="Layout · Receipts & Payments">editor</div> }));
/* The monthly view has its own contract (MonthlyReport.test.tsx); here it only has to be reached. */
vi.mock('./MonthlyReport', () => ({
  MonthlyReport: (p: { title: string; withCumulative: boolean }) => <div role="region" aria-label={`Monthly · ${p.title}`}>{p.withCumulative ? 'with 累计' : 'no 累计'}</div>,
  ByMonthButton: ({ on, onToggle }: { on: boolean; onToggle: () => void }) => <button type="button" aria-pressed={on} onClick={onToggle}>By month</button>,
}));

import { ReceiptsPaymentsTab } from './ReceiptsPayments';
import { generateRpPdf } from '../../vendor/scm/lib/rp-report-pdf';

describe('the Receipts & Payments tab', () => {
  test('Total alone by default, a ticked account adds its own column, receipts above payments, the four balance lines, brackets for a negative', () => {
    render(<ReceiptsPaymentsTab />);
    /* Total alone by default (owner 2026-09-18: default 看 total); a tick adds the account's own column. */
    expect(screen.queryByText('310-0010', { selector: 'th' })).toBeNull();
    expect(screen.getByText('Total', { selector: 'th' })).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Column 310-0010'));
    expect(screen.getByText('310-0010', { selector: 'th' })).toBeTruthy();
    expect(screen.getByText('RECEIPTS')).toBeTruthy();
    expect(screen.getByText('PAYMENTS')).toBeTruthy();
    expect(screen.getByText('Opening balance').closest('tr')!.textContent).toContain('(100.00)');
    expect(screen.getByText('Total receipts').closest('tr')!.textContent).toContain('700.00');
    expect(screen.getByText('Total payments').closest('tr')!.textContent).toContain('760.00');
    expect(screen.getByText('Closing balance').closest('tr')!.textContent).toContain('(160.00)');
    expect(screen.getByText('601-0003 · PURCHASE OF SOFA')).toBeTruthy();
    expect(screen.getByText('Supplier advances (预付)')).toBeTruthy();
    /* The tree (docs/bugs/0912): the category with its per-column subtotal
       and its % of the side's total; every row its %; the balance lines
       carry the side's 100%. */
    const purchases = screen.getByText('Purchases').closest('tr')!;
    expect(purchases.getAttribute('data-kind')).toBe('category');
    expect(purchases.textContent).toContain('400.00');
    expect(purchases.textContent).toContain('52.6%');
    expect(screen.getByText('601-0003 · PURCHASE OF SOFA').closest('tr')!.getAttribute('data-depth')).toBe('2');
    expect(screen.getByText('Supplier advances (预付)').closest('tr')!.textContent).toContain('39.5%');
    expect(screen.getByText('Total payments').closest('tr')!.textContent).toContain('100.0%');
    expect(screen.getByText('%', { selector: 'th' })).toBeTruthy();
  });

  test('a figure opens the entries behind it — a category\'s figure, every row under it; the toggle changes the read; a tick adds a column', () => {
    render(<ReceiptsPaymentsTab />);
    fireEvent.click(screen.getByLabelText('Column 310-0010'));
    fireEvent.click(screen.getByLabelText('601-0003 · PURCHASE OF SOFA 310-0010'));
    expect(screen.getByText(/601-0003 · PURCHASE OF SOFA · 310-0010 — 1 entry/)).toBeTruthy();
    expect(screen.getByText('FOSHAN CHAIRS')).toBeTruthy();
    expect(screen.getByText(/Payment voucher PV-3/)).toBeTruthy();
    /* The category's total: the sofa row's entry, and it alone here. */
    fireEvent.click(screen.getByLabelText('Purchases total'));
    expect(screen.getByText(/Purchases — 1 entry/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Show debtor and creditor names'));
    expect(lastPath.value.endsWith('|true')).toBe(true);
    /* A tick shows a column; the read itself still covers every account. */
    fireEvent.click(screen.getByLabelText('Column 320-0000'));
    expect(screen.getByText('320-0000', { selector: 'th' })).toBeTruthy();
    expect(lastPath.value).not.toContain('320-0000');
    expect(lastPath.value).not.toContain('310-0010');
  });

  test('Print hands the report to the PDF', () => {
    render(<ReceiptsPaymentsTab />);
    fireEvent.click(screen.getByText('Print'));
    expect(vi.mocked(generateRpPdf)).toHaveBeenCalledWith(report, { columns: [] });
  });

  test('By month opens the monthly view with 累计; Print steps aside; the column ticks stay (docs/bugs/0916)', () => {
    render(<ReceiptsPaymentsTab />);
    fireEvent.click(screen.getByRole('button', { name: 'By month' }));
    expect(screen.getByRole('region', { name: /Monthly · Cash Flow/ }).textContent).toBe('with 累计');
    expect(screen.queryByText('Closing balance')).toBeNull();
    expect((screen.getByText('Print').closest('button') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByLabelText('Column 310-0010')).toBeTruthy();
  });

  test('L1 folds the rows to their categories; the Layout button opens the editor', () => {
    render(<ReceiptsPaymentsTab />);
    fireEvent.click(screen.getByRole('button', { name: 'L1' }));
    expect(screen.queryByText('601-0003 · PURCHASE OF SOFA')).toBeNull();
    expect(screen.getByText('Purchases').closest('tr')!.textContent).toContain('400.00');
    /* A row at the top level stays. */
    expect(screen.getByText('910-0000 · UTILITIES')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByText('601-0003 · PURCHASE OF SOFA')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Layout' }));
    expect(screen.getByRole('dialog', { name: 'Layout · Receipts & Payments' })).toBeTruthy();
  });
});
