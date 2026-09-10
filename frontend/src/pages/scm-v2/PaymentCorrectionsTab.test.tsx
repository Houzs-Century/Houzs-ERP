/* The Finance corrections tab. Pinned: the three summary figures and every
   column of a row are on screen from what the endpoint returns; an empty
   month says so in a sentence rather than showing an empty table; a read
   that fails says it failed instead of reading as an empty month; and the
   person filter narrows the table without touching the month's summary. */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../../vendor/scm/lib/authed-fetch', () => ({ authedFetch: vi.fn() }));
vi.mock('../../components/scm-v2/PrintPreviewModal', () => ({
  usePrintPreview: () => ({ open: false, openPreview: () => {}, close: () => {}, handlers: {} }),
  PrintPreviewModal: () => null,
}));

import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { PaymentCorrectionsTab } from './PaymentCorrectionsTab';
import type { PaymentCorrections } from './accounting-phase1-queries';

const mockedFetch = vi.mocked(authedFetch);

const REPORT: PaymentCorrections = {
  month: '2026-09',
  rows: [
    {
      id: 'a', at: '2026-09-10T02:15:00Z', by: 'Chew', docNo: '2990-SO-2606-043', customer: 'Wong li way',
      kind: 'edited', changes: [{ field: 'amountSen', from: 199_000, to: 199_100 }],
      amountFromSen: 199_000, amountToSen: 199_100,
      reason: 'Sales keyed RM 1,990 — receipt shows RM 1,991', originalJeNo: 'JE-2609-0031', contraJeNo: 'JE-2609-0057', jeNo: 'JE-2609-0058',
    },
    {
      id: 'b', at: '2026-09-05T08:00:00Z', by: 'Mei Ling', docNo: '2990-SO-2608-092', customer: 'Lim Siew Mei',
      kind: 'deleted', changes: [{ field: 'amountSen', from: 50_000, to: null }],
      amountFromSen: 50_000, amountToSen: null,
      reason: 'Keyed twice', originalJeNo: 'JE-2608-0388', contraJeNo: 'JE-2609-0012', jeNo: null,
    },
  ],
  summary: { corrections: 2, edited: 1, deleted: 1, netMovedSen: 100 - 50_000, deletedSen: 50_000 },
};

const draw = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter><PaymentCorrectionsTab /></MemoryRouter>
  </QueryClientProvider>,
);

describe('the corrections tab', () => {
  test('asks for the current month and shows the summary and every column of each row', async () => {
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValue(REPORT);
    draw();
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledWith(expect.stringMatching(/^\/accounting\/payment-corrections\?month=\d{4}-\d{2}$/)));

    await waitFor(() => expect(screen.getByText('2')).toBeTruthy());
    expect(screen.getByText('−RM 499.00')).toBeTruthy();
    expect(screen.getByText(/1 · RM 500\.00/)).toBeTruthy();

    expect(screen.getByText('2990-SO-2606-043').closest('a')?.getAttribute('href')).toBe('/scm/sales-orders/2990-SO-2606-043');
    expect(screen.getByText('Wong li way')).toBeTruthy();
    expect(screen.getByText('Amount RM 1,990.00 → RM 1,991.00')).toBeTruthy();
    expect(screen.getByText('Sales keyed RM 1,990 — receipt shows RM 1,991')).toBeTruthy();
    expect(screen.getByText('JE-2609-0031 → reversed by JE-2609-0057 → JE-2609-0058')).toBeTruthy();

    expect(screen.getByText('Deleted — RM 500.00 removed')).toBeTruthy();
    expect(screen.getByText('JE-2608-0388 → reversed by JE-2609-0012')).toBeTruthy();
  });

  test('the person filter narrows the rows and leaves the month\'s summary alone', async () => {
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValue(REPORT);
    draw();
    await waitFor(() => expect(screen.getByText('Keyed twice')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Corrected by'), { target: { value: 'Chew' } });
    expect(screen.queryByText('Keyed twice')).toBeNull();
    expect(screen.getByText('Sales keyed RM 1,990 — receipt shows RM 1,991')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
  });

  test('an empty month says so in a sentence, with no table', async () => {
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValue({ month: '2026-09', rows: [], summary: { corrections: 0, edited: 0, deleted: 0, netMovedSen: 0, deletedSen: 0 } });
    draw();
    await waitFor(() => expect(screen.getByText(/No payment correction on the amend right was recorded for/)).toBeTruthy());
    expect(screen.queryByRole('table')).toBeNull();
  });

  test('a read that fails says so rather than reading as an empty month', async () => {
    mockedFetch.mockReset();
    mockedFetch.mockRejectedValue(new Error('load_failed'));
    draw();
    await waitFor(() => expect(screen.getByText(/The report could not be read/)).toBeTruthy());
    expect(screen.queryByText(/was recorded for/)).toBeNull();
  });
});
