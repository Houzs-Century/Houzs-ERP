// The Daily Bank page's render contract: the available banner carries the
// endpoint's number, every money account renders as a block with its
// movements, and transit shows per acquirer without joining "available".
// The hook is mocked at the module seam - the board arithmetic itself is
// pinned in backend/src/acc/daily-bank.test.ts.

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';
import type { DailyBankBoard } from './accounting-phase1-queries';

const BOARD: DailyBankBoard = {
  date: '2026-08-16',
  blocks: [
    {
      accountCode: '310-0010', accountName: 'Bank — Maybank Current',
      openingSen: 100000, inSen: 50000, outSen: 20000, closingSen: 130000,
      receipts: [{ jeNo: 'JE-2608-0001', sourceType: 'SOPAY', sourceDocNo: 'pay-1', note: 'Payment cash', amountSen: 50000 }],
      payouts: [{ jeNo: 'JE-2608-0002', sourceType: 'PV', sourceDocNo: 'PV-2608-001', note: 'Freight', amountSen: 20000 }],
    },
  ],
  transit: [{ acquirerCode: 'MBB', accountCode: '326-0000', accountName: 'Card Machine Clearing (EDC)', balanceSen: 70000 }],
  totalClosingSen: 130000,
  totalTransitSen: 70000,
  pendingApprovalSen: 0,
  availableSen: 130000,
  note: 'test note',
};

vi.mock('./accounting-phase1-queries', () => ({
  useDailyBank: () => ({ data: BOARD, isLoading: false }),
}));

import { DailyBank } from './DailyBank';

describe('DailyBank board', () => {
  test('renders available, the account block arithmetic, movements and transit', () => {
    render(<MemoryRouter><DailyBank /></MemoryRouter>);
    expect(screen.getByText('RM 1,300.00')).toBeTruthy();            // available banner
    expect(screen.getByText('Bank — Maybank Current')).toBeTruthy();
    expect(screen.getByText(/JE-2608-0001/)).toBeTruthy();            // receipt listed
    expect(screen.getByText(/JE-2608-0002/)).toBeTruthy();            // payout listed
    expect(screen.getAllByText('RM 700.00').length).toBeGreaterThan(0); // transit balance (banner + row)
    expect(screen.getByText(/MBB/)).toBeTruthy();
    expect(screen.getByText('test note')).toBeTruthy();
  });
});
