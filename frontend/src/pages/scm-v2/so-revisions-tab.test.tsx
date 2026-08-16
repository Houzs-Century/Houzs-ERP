// ----------------------------------------------------------------------------
// so-revisions-tab — the Revisions tab lifted out of SalesOrderDetail.tsx so
// that file could shrink under its ceiling. The move must be behaviour-neutral,
// so this pins what it renders in each of its four states.
// ----------------------------------------------------------------------------

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const useSoRevisions = vi.fn();
vi.mock('../../vendor/scm/lib/so-amendment-queries', () => ({
  useSoRevisions: (docNo: string) => useSoRevisions(docNo) as unknown,
}));

const { RevisionsTab } = await import('./so-revisions-tab');

beforeEach(() => { useSoRevisions.mockReset(); });

describe('RevisionsTab', () => {
  it('says so plainly when an order has never been amended', () => {
    useSoRevisions.mockReturnValue({ data: { revisions: [] }, isLoading: false, error: null });
    render(<RevisionsTab docNo="HC-SO-000001" currency="MYR" />);
    expect(screen.getByText(/Revisions \(0\)/)).toBeTruthy();
    expect(screen.getByText(/hasn't been amended yet/i)).toBeTruthy();
  });

  it('surfaces a load failure instead of an empty-looking tab', () => {
    useSoRevisions.mockReturnValue({ data: null, isLoading: false, error: new Error('network down') });
    render(<RevisionsTab docNo="HC-SO-000001" currency="MYR" />);
    expect(screen.getByText(/Could not load revisions/i)).toBeTruthy();
    expect(screen.getByText(/network down/)).toBeTruthy();
  });

  it('lists each revision and counts them in the header', () => {
    useSoRevisions.mockReturnValue({
      isLoading: false,
      error: null,
      data: {
        revisions: [
          { id: 'r2', revision: 2, created_at: '2026-08-15T02:00:00.000Z', snapshot: null },
          { id: 'r1', revision: 1, created_at: '2026-08-14T02:00:00.000Z', snapshot: null },
        ],
      },
    });
    render(<RevisionsTab docNo="HC-SO-000001" currency="MYR" />);
    expect(screen.getByText(/Revisions \(2\)/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /view snapshot/i })).toHaveLength(2);
  });

  it('reads a snapshot written in either snake or camel case', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    useSoRevisions.mockReturnValue({
      isLoading: false,
      error: null,
      data: {
        revisions: [{
          id: 'r1',
          revision: 1,
          created_at: '2026-08-14T02:00:00.000Z',
          // The approve-so snapshot shape is not frozen, which is why the
          // component dual-reads. Mix the two here on purpose.
          snapshot: {
            header: { debtorName: 'Test Debtor Sdn Bhd', local_total_centi: 123400 },
            lines: [{ item_code: 'SOFA-A', qty: 2, unitPriceCenti: 61700 }],
          },
        }],
      },
    });
    render(<RevisionsTab docNo="HC-SO-000001" currency="MYR" />);
    await userEvent.click(screen.getByRole('button', { name: /view snapshot/i }));
    expect(screen.getByText(/Test Debtor Sdn Bhd/)).toBeTruthy();
    expect(screen.getByText('SOFA-A')).toBeTruthy();
  });
});
