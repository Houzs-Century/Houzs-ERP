// The Daily Bank's Daily close (the owner's Claude Design redesign, batch 3):
// what each bucket settles by, the cash count that must come first, the note
// that says what confirming will do, the counts saved before the close, and a
// closed or future day read-only. The hooks are mocked at the module seam; the
// posting itself is pinned in backend acc/daily-close.test.ts.

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { DailyCloseRow } from './accounting-phase1-queries';

let ROWS: DailyCloseRow[] = [];
let META: { confirmedBy?: string | null; confirmedAt?: string | null; cashJeNo?: string | null } = {};
const save = vi.fn((_b: unknown, o?: { onSuccess?: () => void }) => { o?.onSuccess?.(); });
const confirm = vi.fn((_b: unknown, o?: { onSuccess?: (r: { cashPosting: { status: string; jeNo?: string } | null }) => void }) => {
  o?.onSuccess?.({ cashPosting: { status: 'posted', jeNo: 'JE-2611-0009' } });
});

vi.mock('./accounting-phase1-queries', () => ({
  useDailyClose: () => ({ data: { date: '2026-11-02', rows: ROWS, ...META }, isLoading: false, isError: false, error: null }),
  useSaveDailyClose: () => ({ mutate: save, isPending: false }),
  useConfirmDailyClose: () => ({ mutate: confirm, isPending: false }),
}));

import { DailyBankClose } from './DailyBankClose';

const row = (bucket: string, systemSen: number, over: Partial<DailyCloseRow> = {}): DailyCloseRow =>
  ({ bucket, systemSen, countedSen: null, diffSen: null, status: 'DRAFT', notes: null, ...over });

beforeEach(() => {
  save.mockClear(); confirm.mockClear(); META = {};
  ROWS = [row('cash', 10_000), row('transfer', 50_000), row('MBB', 30_000)];
});

describe('DailyBankClose', () => {
  test('an open day: what each bucket settles by; the cash must be counted before closing', () => {
    render(<DailyBankClose date="2026-11-02" today="2026-11-02" />);
    expect(screen.getByText('Close 2026/11/02')).toBeTruthy();
    expect(screen.getByText('Open')).toBeTruthy();
    expect(screen.getByText('Nothing counted yet')).toBeTruthy();
    expect(screen.getByText('Counted here · a difference books to Cash Over/Short (946-0000)')).toBeTruthy();
    expect(screen.getByText('Bank statements · no posting here')).toBeTruthy();
    expect(screen.getByText('Card · MBB')).toBeTruthy();
    const close = screen.getByRole('button', { name: /Confirm close/ });
    expect((close as HTMLButtonElement).disabled).toBe(true);
    expect(close.getAttribute('title')).toBe('Count the cash first');
    expect(screen.getByText(/Count the cash to close the day\. Only cash posts/)).toBeTruthy();
  });

  test('a short drawer says what confirming books, saves the counts, then closes the day', () => {
    render(<DailyBankClose date="2026-11-02" today="2026-11-02" />);
    fireEvent.change(screen.getByLabelText('Cash counted'), { target: { value: '95.00' } });
    expect(screen.getByText('(5.00)')).toBeTruthy();
    expect(screen.getByText('Cash is short by RM 5.00. Confirming books it to Cash Over/Short (946-0000) dated 2026/11/02.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Confirm close/ }));
    expect(save).toHaveBeenCalledWith(
      { date: '2026-11-02', buckets: [{ bucket: 'cash', countedSen: 9_500 }, { bucket: 'transfer', countedSen: null }, { bucket: 'MBB', countedSen: null }] },
      expect.anything(),
    );
    expect(confirm).toHaveBeenCalledWith({ date: '2026-11-02' }, expect.anything());
    expect(screen.getByRole('status').textContent).toBe('Closed 2026/11/02 · short RM 5.00 booked to 946-0000 · JE-2611-0009');
  });

  test('a closed day reads who closed it and its entry; nothing can be typed', () => {
    ROWS = [row('cash', 10_000, { countedSen: 9_500, diffSen: -500, status: 'CONFIRMED' }), row('transfer', 0, { status: 'CONFIRMED' })];
    META = { confirmedBy: 'Mei Ling', confirmedAt: '2026-11-02T10:15:00Z', cashJeNo: 'JE-2611-0009' };
    render(<DailyBankClose date="2026-11-02" today="2026-11-03" />);
    expect(screen.getByText('Closed')).toBeTruthy();
    expect(screen.getByText('Counts locked')).toBeTruthy();
    const note = screen.getByText(/Closed by Mei Ling/);
    expect(note.textContent).toContain('short RM 5.00 booked to Cash Over/Short · JE-2611-0009');
    expect((screen.getByLabelText('Cash counted') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /Confirm close/ })).toBeNull();
  });

  test('a day still to come is ahead and read-only', () => {
    render(<DailyBankClose date="2026-11-09" today="2026-11-02" />);
    expect(screen.getByText('Ahead')).toBeTruthy();
    expect(screen.getByText('This day hasn’t happened yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Save counts/ })).toBeNull();
  });
});
