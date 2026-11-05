/* The move-earlier-transfers dialog (owner 2026-11-04: 做改记工具): Find lists
   the receipts on another bank with why a blocked one cannot move; Move sends
   only the movable ones and shows each one's outcome. The rules themselves are
   pinned server-side in backend/src/acc/receipt-rebank.test.ts. */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { RebankOutcome, RebankRow } from '../../vendor/scm/lib/accounting-queries';

const ROWS: RebankRow[] = [
  { source: 'SOPAY', paymentId: 'pay-1', docNo: 'HC-SO-2610-001', paidOn: '2026-10-05', amountSen: 50_000, jeNo: 'JE-1', fromAccount: '310-0020', blocked: null },
  { source: 'SOPAY', paymentId: 'pay-2', docNo: 'HC-SO-2610-002', paidOn: '2026-10-06', amountSen: 12_345, jeNo: 'JE-2', fromAccount: '310-0020', blocked: 'already matched on the 310-0020 statement' },
];
let range: unknown = null;
const moveAsync = vi.fn(async (items: Array<{ source: string; paymentId: string }>) => ({
  target: '310-0010',
  results: items.map((i): RebankOutcome => ({ source: i.source as 'SOPAY', paymentId: i.paymentId, status: 'moved', reason: null, fromJeNo: 'JE-1', jeNo: 'JE-9' })),
}));
vi.mock('../../vendor/scm/lib/accounting-queries', () => ({
  REBANK_PER_CALL: 25,
  useRebankCandidates: (r: unknown) => { range = r; return r ? { data: { target: '310-0010', rows: ROWS }, isFetching: false, isError: false } : { data: undefined, isFetching: false, isError: false }; },
  useRebankMove: () => ({ mutateAsync: moveAsync }),
}));

import { RebankReceiptsDialog } from './RebankReceiptsDialog';

describe('RebankReceiptsDialog', () => {
  test('finds, says why the blocked one stays, moves only the movable one', async () => {
    render(<RebankReceiptsDialog targetName="Bank — Maybank" defaultFrom="2026-01-01" today="2026-11-04" onClose={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Move from date'), { target: { value: '2026-10-01' } });
    fireEvent.click(screen.getByText('Find'));
    expect(range).toEqual({ from: '2026-10-01', to: '2026-11-04' });

    expect(screen.getByText(/2 receipt\(s\) on another bank · 1 can move/)).toBeTruthy();
    expect(screen.getByText('already matched on the 310-0020 statement')).toBeTruthy();
    expect(screen.getByText('Will move')).toBeTruthy();

    fireEvent.click(screen.getByText('Move 1 (RM 500.00)'));
    await waitFor(() => expect(screen.getByText('Moved · JE-9')).toBeTruthy());
    expect(moveAsync).toHaveBeenCalledTimes(1);
    expect(moveAsync.mock.calls[0]![0]).toEqual([{ source: 'SOPAY', paymentId: 'pay-1' }]);
  });
});
