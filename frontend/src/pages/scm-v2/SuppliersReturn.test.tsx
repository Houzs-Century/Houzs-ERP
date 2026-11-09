// Coming back to the Suppliers list from a supplier lands where you left it
// (Conts-ERP #406). The page and the status, category and search choices live in
// the address, so Back (which returns to the last list address) restores them,
// and the supplier you opened is scrolled back into view.
import { act, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const authedFetch = vi.fn();
vi.mock('../../vendor/scm/lib/authed-fetch', () => ({ authedFetch: (...a: unknown[]) => authedFetch(...a) }));
vi.mock('../../vendor/scm/components/NotifyDialog', () => ({ useNotify: () => () => Promise.resolve() }));
vi.mock('../../auth/capabilities', () => ({ useCapability: () => true }));
vi.mock('../../vendor/scm/components/SupplyCategoryPicker', () => ({
  useSupplierCategoryPool: () => ['Sofa'],
  SupplyCategoryPicker: () => null,
}));

type GridProps = { rows: Array<{ id: string }>; onRowClick: (r: { id: string }) => void; scrollToRow?: { key: string; nonce: number } | null };
let grid: GridProps | null = null;
vi.mock('../../components/DataGridCompat', () => ({
  DataGridCompat: (p: GridProps) => { grid = p; return null; },
}));

import { Suppliers } from './Suppliers';

const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, code: `400-A${i}`, name: `S${i}`, status: 'ACTIVE' }));

let here = '';
function Where() {
  const loc = useLocation();
  here = `${loc.pathname}${loc.search}`;
  return null;
}

function renderAt(url: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/scm/suppliers" element={<><Suppliers /><Where /></>} />
          <Route path="/scm/suppliers/:id" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const lastListCall = () => String(authedFetch.mock.calls.filter((c) => String(c[0]).startsWith('/suppliers?')).at(-1)?.[0] ?? '');

describe('the Suppliers list keeps your place', () => {
  beforeEach(() => {
    authedFetch.mockReset();
    authedFetch.mockResolvedValue({ suppliers: rowsOf(43), total: 93, page: 1, pageSize: 50 });
    sessionStorage.clear();
    grid = null;
  });

  test('a page, status and search in the address are what is loaded, not page 1', async () => {
    renderAt('/scm/suppliers?page=1&status=ACTIVE&q=ad');
    await waitFor(() => expect(lastListCall()).toContain('page=1'));
    expect(lastListCall()).toContain('status=ACTIVE');
    expect(lastListCall()).toContain('q=ad');
    expect(here).toBe('/scm/suppliers?page=1&status=ACTIVE&q=ad');
  });

  test('opening a supplier and coming back scrolls to it', async () => {
    const first = renderAt('/scm/suppliers?page=1');
    await waitFor(() => expect(grid?.rows.length).toBe(43));
    act(() => grid!.onRowClick({ id: 's37' }));
    expect(here).toBe('/scm/suppliers/s37');
    first.unmount();
    grid = null;

    renderAt('/scm/suppliers?page=1');
    await waitFor(() => expect(grid?.scrollToRow?.key).toBe('s37'));
  });

  test('a list opened fresh does not scroll anywhere', async () => {
    renderAt('/scm/suppliers');
    await waitFor(() => expect(grid?.rows.length).toBe(43));
    expect(grid?.scrollToRow ?? null).toBeNull();
  });
});
