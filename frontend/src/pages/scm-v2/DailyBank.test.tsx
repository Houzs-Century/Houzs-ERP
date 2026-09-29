// The Daily Bank page's render contract, by bank (owner 2026-09-29, his "BANK
// BALANCE AVAILABLE" sample): the three totals stay on top; under a dark bar
// with the day, one table per money account with its Bank Balance in the
// header — Balance B/F, Received today, Paid today, Pending payment,
// Available (after pending), In transit per acquirer, Available + in transit —
// and a last section for what names no bank; Get image / PNG / PDF.
// The hook is mocked at the module seam — the board arithmetic is pinned in
// backend/src/acc/daily-bank.test.ts, the route's names and numbers in
// backend/tests/dailyBankByBank.test.ts, the table model in daily-bank-report.test.ts.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';
import type { DailyBankBoard } from './accounting-phase1-queries';

const BOARD: DailyBankBoard = {
  date: '2026-09-29',
  blocks: [
    {
      accountCode: '310-0020', accountName: 'CASH AT BANK - HLBB',
      openingSen: 6_172_699, inSen: 285_000, outSen: 44_264, closingSen: 6_413_435,
      receipts: [{ jeNo: 'JE-2', sourceType: 'SOPAY', sourceDocNo: 'pay-1', docNo: '2990-MOR-2609-009', party: 'Hookka', note: 'Settle invoice HV-INV-0039', amountSen: 285_000 }],
      payouts: [{ jeNo: 'JE-4', sourceType: 'PV', sourceDocNo: 'PV-0432', docNo: 'PV-0432', party: 'Tan Yong Hong', note: 'Claude - Sep', amountSen: 44_264 }],
      pending: [{ id: 'pv-1', pvNumber: '2990-HPV-2609-023', payee: 'UNICOM MARKETING SDN BHD', description: 'BILL IV2026-09-007', voucherDate: '2026-09-18', accountCode: '310-0020', amountSen: 1_083_600 }],
      pendingSen: 1_083_600, availableSen: 5_329_835,
      transit: [{ acquirerCode: 'PBB', accountCode: '326-0010', accountName: 'CARD MACHINE CLEARING — PBB', balanceSen: 3_750_352, bankAccountCode: '310-0020' }],
      transitSen: 3_750_352, availableWithTransitSen: 9_080_187,
    },
    {
      accountCode: '310-0030', accountName: 'CASH AT BANK - ALLIANCE',
      openingSen: 2_433_855, inSen: 0, outSen: 0, closingSen: 2_433_855, receipts: [], payouts: [],
      pending: [], pendingSen: 0, availableSen: 2_433_855, transit: [], transitSen: 0, availableWithTransitSen: 2_433_855,
    },
  ],
  transit: [
    { acquirerCode: 'PBB', accountCode: '326-0010', accountName: 'CARD MACHINE CLEARING — PBB', balanceSen: 3_750_352, bankAccountCode: '310-0020' },
    { acquirerCode: '未标银行', accountCode: '326-0000', accountName: 'CARD MACHINE CLEARING (EDC)', balanceSen: 336_500, bankAccountCode: null },
  ],
  totalClosingSen: 8_847_290,
  totalTransitSen: 4_086_852,
  pendingApprovalSen: 1_083_600,
  availableSen: 7_763_690,
  unassignedTransit: [{ acquirerCode: '未标银行', accountCode: '326-0000', accountName: 'CARD MACHINE CLEARING (EDC)', balanceSen: 336_500, bankAccountCode: null }],
  unassignedPending: [],
  note: 'test note',
};

vi.mock('./accounting-phase1-queries', () => ({
  useDailyBank: () => ({ data: BOARD, isLoading: false, isError: false, error: null }),
  useDailyClose: () => ({ data: { rows: [] }, isLoading: false }),
  useSaveDailyClose: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useConfirmDailyClose: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
const pdfMock = vi.fn(async (_b: unknown) => undefined);
vi.mock('./daily-bank-pdf', () => ({ generateDailyBankPdf: (b: unknown) => pdfMock(b) }));

import { DailyBank } from './DailyBank';

const section = (key: string): HTMLElement => {
  const head = document.querySelector(`[data-section="${key}"]`) as HTMLElement;
  return head;
};
/** The rows after a section's header, up to the next section — their kinds, in order. */
const kindsOf = (key: string): string[] => {
  const out: string[] = [];
  let tr = section(key).nextElementSibling;
  while (tr && !tr.hasAttribute('data-section')) {
    const k = tr.getAttribute('data-row');
    if (k) out.push(k);
    tr = tr.nextElementSibling;
  }
  return out;
};
const rowsOf = (key: string, kind: string): HTMLElement[] => {
  const out: HTMLElement[] = [];
  let tr = section(key).nextElementSibling;
  while (tr && !tr.hasAttribute('data-section')) {
    if (tr.getAttribute('data-row') === kind) out.push(tr as HTMLElement);
    tr = tr.nextElementSibling;
  }
  return out;
};
const col = (tr: HTMLElement, c: 'received' | 'paid' | 'last'): string => String(tr.querySelector(`[data-col="${c}"]`)?.textContent);

describe('DailyBank board, by bank', () => {
  test('the three totals stay on top; the dark bar names the day', () => {
    render(<MemoryRouter><DailyBank /></MemoryRouter>);
    expect(screen.getByText('RM 77,636.90')).toBeTruthy();                     // can actually move
    expect(screen.getByText('RM 40,868.52')).toBeTruthy();                     // in transit
    expect(screen.getByText('RM 10,836.00')).toBeTruthy();                     // checked, awaiting approval
    const table = screen.getByLabelText('Bank balance available');
    expect(within(table).getByText('BANK BALANCE AVAILABLE')).toBeTruthy();
    expect(within(table).getByText('Tue · 2026/09/29')).toBeTruthy();
    expect(screen.getByText('test note')).toBeTruthy();
  });

  test('a bank: its Bank Balance in the header, then B/F, received, paid, pending, available, its card money and the line with it added', () => {
    render(<MemoryRouter><DailyBank /></MemoryRouter>);
    expect(section('310-0020').textContent).toContain('CASH AT BANK - HLBB');
    expect((document.querySelector('[data-bank-balance="310-0020"]') as HTMLElement).textContent).toBe('64,134.35');
    expect(kindsOf('310-0020')).toEqual(['bf', 'receivedHead', 'received', 'paidHead', 'paid', 'pendingHead', 'pending', 'available', 'transitHead', 'transit', 'withTransit']);
    expect(col(rowsOf('310-0020', 'bf')[0]!, 'last')).toBe('61,726.99');
    const received = rowsOf('310-0020', 'received')[0]!;
    expect(received.textContent).toContain('· Hookka');
    expect(received.textContent).toContain('2990-MOR-2609-009');
    expect(received.textContent).toContain('Settle invoice HV-INV-0039');
    expect(col(received, 'received')).toBe('2,850.00');
    const paid = rowsOf('310-0020', 'paid')[0]!;
    expect(paid.textContent).toContain('· Tan Yong Hong');
    expect(col(paid, 'paid')).toBe('442.64');
    const pending = rowsOf('310-0020', 'pending')[0]!;
    expect(pending.textContent).toContain('· UNICOM MARKETING SDN BHD');
    expect(pending.textContent).toContain('2990-HPV-2609-023');
    expect(col(pending, 'last')).toBe('10,836.00');
    expect(col(rowsOf('310-0020', 'available')[0]!, 'last')).toBe('53,298.35');
    const transit = rowsOf('310-0020', 'transit')[0]!;
    expect(transit.textContent).toContain('· PBB');
    expect(col(transit, 'last')).toBe('37,503.52');
    expect(col(rowsOf('310-0020', 'withTransit')[0]!, 'last')).toBe('90,801.87');
  });

  test('a bank with nothing on the day shows its B/F and its available alone; what names no bank waits in the last section', () => {
    render(<MemoryRouter><DailyBank /></MemoryRouter>);
    expect(kindsOf('310-0030')).toEqual(['bf', 'available']);
    expect(section('unassigned').textContent).toContain('Not tied to a bank');
    expect(kindsOf('unassigned')).toEqual(['transitHead', 'transit']);
    expect(rowsOf('unassigned', 'transit')[0]!.textContent).toContain('未标银行');
    expect(col(rowsOf('unassigned', 'transit')[0]!, 'last')).toBe('3,365.00');
  });

  test('Get image, PNG and PDF: the PDF prints the board the page shows', async () => {
    render(<MemoryRouter><DailyBank /></MemoryRouter>);
    expect(screen.getByRole('button', { name: /Get image/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /PNG/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /PDF/ }));
    await waitFor(() => expect(pdfMock).toHaveBeenCalledWith(BOARD));
  });
});
