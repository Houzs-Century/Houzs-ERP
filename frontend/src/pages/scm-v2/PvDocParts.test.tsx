/* The payment voucher page's redesign pieces (owner's Claude Design, batch 4):
     • the stage reads off the four layers' marks on a DRAFT;
     • the books line says whether it posted, debit to credit, the money, and
       a foreign voucher's rate;
     • the trail reads inline with the reasons a voucher was sent back. */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../../vendor/scm/lib/entity-audit-queries', () => ({
  useEntityAuditLog: () => ({
    data: [{ id: 't1', action: 'reject', actor_name_snapshot: 'Mei Ling', status_snapshot: 'DRAFT', note: 'Wrong bank account', created_at: '2026-11-02T03:00:00Z' }],
    isLoading: false, isError: false,
  }),
}));
vi.mock('./finance/finance-todo-queries', () => ({ useTodoSettings: () => ({ data: undefined }) }));
vi.mock('./finance/TaskDrawers', () => ({ AddTaskDrawer: () => null }));

import { BooksLine, PvTrail, StageTag, pvStage } from './PvDocParts';

describe('the stage', () => {
  test('reads the marks a DRAFT wears', () => {
    expect(pvStage({ status: 'DRAFT' })).toBe('Draft');
    expect(pvStage({ status: 'DRAFT', submitted_at: 'x' })).toBe('Prepared');
    expect(pvStage({ status: 'DRAFT', submitted_at: 'x', checked_at: 'y' })).toBe('Checked');
    expect(pvStage({ status: 'POSTED' })).toBe('Approved');
    expect(pvStage({ status: 'CANCELLED' })).toBe('Cancelled');
    render(<StageTag pv={{ status: 'DRAFT', submitted_at: 'x', checked_at: 'y' }} />);
    expect(screen.getByText('Checked')).toBeTruthy();
  });
});

describe('the books line', () => {
  const names = (c: string) => ({ '900-T009': 'MERCHANT FEE', '310-0001': 'HONG LEONG BANK' } as Record<string, string>)[c] ?? null;

  test('a checked voucher posts at approval, debit to credit', () => {
    render(<BooksLine pv={{ status: 'DRAFT', checked_at: 'y', credit_account_code: '310-0001', total_sen: 30_000, currency: 'MYR' }}
      lines={[{ debit_account_code: '900-T009' }]} accountName={names} />);
    expect(screen.getByText(/Posts at approval/).parentElement!.textContent)
      .toBe('Posts at approval · Dr 900-T009 MERCHANT FEE · Cr 310-0001 HONG LEONG BANK · RM 300.00');
  });

  test('a posted foreign voucher says its rate; a cancelled one with a journal says it was reversed', () => {
    const { unmount } = render(<BooksLine pv={{ status: 'POSTED', je_no: 'HC-JE-2611-0004', credit_account_code: '310-0001', total_sen: 10_000, currency: 'USD', exchange_rate: '4.4500' }}
      lines={[{ debit_account_code: '900-T009' }]} accountName={names} />);
    expect(screen.getByText(/Posted/).parentElement!.textContent).toContain('USD at 4.4500');
    unmount();
    render(<BooksLine pv={{ status: 'CANCELLED', je_no: 'HC-JE-2611-0004', credit_account_code: '310-0001', total_sen: 10_000 }} lines={[]} accountName={names} />);
    expect(screen.getByText('Reversed')).toBeTruthy();
  });
});

describe('the trail', () => {
  test('reads who sent it back and why, and opens the full history', () => {
    const full = vi.fn();
    render(<PvTrail pvId="pv-1" onFullHistory={full} />);
    expect(screen.getByText('Reject')).toBeTruthy();
    expect(screen.getByText(/Mei Ling/)).toBeTruthy();
    expect(screen.getByText('“Wrong bank account”')).toBeTruthy();
    fireEvent.click(screen.getByText(/Full history ›/));
    expect(full).toHaveBeenCalled();
  });
});
