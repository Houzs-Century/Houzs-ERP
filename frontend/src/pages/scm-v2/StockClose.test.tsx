// Month-end tab (GL redesign item 4): the run log renders every outcome —
// the quiet 'no change' rows included, which is the whole point of the log —
// and Run now sends the chosen month.

import { describe, expect, test, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const runMutate = vi.fn();

vi.mock('./accounting-phase1-queries', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useStockClose: () => ({
    isLoading: false, isError: false,
    data: {
      liveValueSen: 7_301_432,
      defaultMonth: '2026-08',
      runs: [
        { month: '2026-08', ran_at: '2026-09-05T16:05:00Z', trigger: 'cron', stock_value_sen: 7_301_432, action: 'posted', je_no: '2990-JE-2608-0031', rev_je_no: '2990-JE-2609-0002', note: null },
        { month: '2026-08', ran_at: '2026-09-06T16:05:00Z', trigger: 'cron', stock_value_sen: 7_301_432, action: 'unchanged', je_no: '2990-JE-2608-0031', rev_je_no: '2990-JE-2609-0002', note: null },
      ],
    },
  }),
  useRunStockClose: () => ({ mutate: runMutate, isPending: false, isError: false, error: null }),
}));

import { StockCloseTab } from './StockClose';

beforeEach(() => runMutate.mockClear());

describe('the month-end log', () => {
  test('shows the live value, the posted run AND the quiet no-change check', () => {
    render(<StockCloseTab />);
    expect(screen.getAllByText('RM 73,014.32').length).toBeGreaterThan(0);
    expect(screen.getByText('posted')).toBeTruthy();
    expect(screen.getByText('no change')).toBeTruthy();
    expect(screen.getAllByText(/2990-JE-2608-0031/).length).toBe(2);
  });

  test('Run now sends the chosen month', () => {
    render(<StockCloseTab />);
    fireEvent.change(screen.getByLabelText('Close month'), { target: { value: '2026-07' } });
    fireEvent.click(screen.getByText('Run now'));
    expect(runMutate).toHaveBeenCalledWith({ month: '2026-07' });
  });
});
