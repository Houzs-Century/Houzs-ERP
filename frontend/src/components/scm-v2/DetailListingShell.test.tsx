/* B23: Print / Preview on a Detail Listing used to fire on a 60 / 250 ms timer
   after starting the inquiry, so a fetch slower than that printed an empty or
   "Loading" sheet. They now wait for the inquiry's rows. */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { DetailListingShell } from './DetailListingShell';
import { NotifyProvider } from '../../vendor/scm/components/NotifyDialog';
import type { DetailListingFilters, DetailListingRow } from '../../vendor/scm/lib/reports-queries';

type Gate = { resolve: (rows: DetailListingRow[]) => void; reject: (e: Error) => void };
let gates: Gate[] = [];

const useFakeDetail = (filters: DetailListingFilters) =>
  useQuery({
    queryKey: ['b23', JSON.stringify(filters)],
    queryFn: () => new Promise<{ rows: DetailListingRow[] }>((res, rej) => {
      gates.push({ resolve: (rows) => res({ rows }), reject: rej });
    }),
    retry: false,
  });

const row = { doc_no: 'DO-1', total_sen: 100, balance_sen: 0 } as unknown as DetailListingRow;

const draw = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <NotifyProvider>
          <DetailListingShell title="DO Detail Listing" storageKey="b23-test" useDetailQuery={useFakeDetail} buildColumns={() => []} />
        </NotifyProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

const settle = () => new Promise((r) => setTimeout(r, 20));

const lastGate = () => {
  const g = gates.at(-1);
  if (!g) throw new Error('no fetch started');
  return g;
};

afterEach(() => { gates = []; vi.restoreAllMocks(); });

describe('Detail Listing print waits for the rows', () => {
  test('Print before the inquiry ran prints only after the fetch resolves', async () => {
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {});
    draw();
    fireEvent.click(screen.getByText('Print'));
    await act(async () => { fireEvent.click(screen.getByText('Print now')); });
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    expect(printSpy).not.toHaveBeenCalled();
    await act(async () => { lastGate().resolve([row]); await settle(); });
    expect(printSpy).toHaveBeenCalledTimes(1);
  });

  test('a failed inquiry does not print and says why', async () => {
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {});
    draw();
    fireEvent.click(screen.getByText('Print'));
    await act(async () => { fireEvent.click(screen.getByText('Print now')); });
    await act(async () => { lastGate().reject(new Error('boom')); await settle(); });
    expect(printSpy).not.toHaveBeenCalled();
    expect(screen.getByText(/could not be loaded/)).toBeTruthy();
  });

  test('Preview before the inquiry ran waits for the rows too', async () => {
    draw();
    await act(async () => { fireEvent.click(screen.getByText('Preview')); });
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    expect(screen.queryByText(/PDF export is not enabled/)).toBeNull();
    await act(async () => { lastGate().resolve([row]); await settle(); });
    expect(screen.getByText(/PDF export is not enabled/)).toBeTruthy();
  });
});
