/* The 3PL company drawer links each carrier to its supplier (owner 2026-11-11:
   「这里的 3pl supplier 其实是要 link with 我的 other supplier 的」). Renders the
   REAL drawer and the REAL query hooks against a mocked authedFetch. Pinned:
   each carrier shows its supplier (code over name) or says none is linked; the
   picker finds a supplier by code or by name, fills an EMPTY company name, and
   posts the id; an edit sends the link only when it changed, and Clear unlinks. */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const authedFetch = vi.hoisted(() => vi.fn());
vi.mock('../../vendor/scm/lib/authed-fetch', () => ({ authedFetch }));

import { ThreePLCompanies } from './ThreePLCompanies';
import { NotifyProvider } from '../../vendor/scm/components/NotifyDialog';
import { ConfirmProvider } from '../../vendor/scm/components/ConfirmDialog';

const SUP_A = { id: 'sup-a', code: '400-X001', name: 'CARRIER A SDN BHD' };
const SUP_B = { id: 'sup-b', code: '400-X002', name: 'CARRIER B SDN BHD' };
const SUP_C = { id: 'sup-c', code: '400-X003', name: 'CARRIER C SDN BHD' };

const carrier = (over: Record<string, unknown>) => ({
  id: 'car-a', code: '3PL-001', name: 'CARRIER A', registrationNo: null, contactName: null, contactPhone: null,
  officePhone: null, email: null, address: null, isActive: true, notes: null, supplier: null,
  lorryCount: 0, driverCount: 0, helperCount: 0, ...over,
});

function serve(companies: unknown[]) {
  authedFetch.mockImplementation((path: string, init?: { method?: string }) => {
    if (init?.method === 'POST' || init?.method === 'PATCH') return Promise.resolve({ company: companies[0] });
    if (path === '/threepl-companies') return Promise.resolve({ companies });
    if (path.startsWith('/suppliers')) return Promise.resolve({ suppliers: [SUP_A, SUP_B, SUP_C].map((s) => ({ ...s, status: 'ACTIVE' })) });
    return Promise.resolve({});
  });
}

const mount = () => render(
  <MemoryRouter>
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ConfirmProvider>
        <NotifyProvider><ThreePLCompanies embedded /></NotifyProvider>
      </ConfirmProvider>
    </QueryClientProvider>
  </MemoryRouter>,
);

const bodyOf = (method: string, nth = 0): { path: string; body: Record<string, unknown> } | null => {
  const calls = authedFetch.mock.calls.filter((c) => (c[1] as { method?: string } | undefined)?.method === method);
  if (calls.length <= nth) return null;
  const [path, init] = calls[nth] as [string, { body: string }];
  return { path, body: JSON.parse(init.body) as Record<string, unknown> };
};

/* A block body on purpose: a function RETURNED from beforeEach is run as its
   cleanup, and mockReset() returns the mock, so the arrow shorthand would call
   authedFetch() with no path after every test. */
beforeEach(() => { authedFetch.mockReset(); });

describe('3PL companies: the supplier link', () => {
  test('each carrier shows its supplier, code over name, or that none is linked', async () => {
    serve([carrier({ supplier: SUP_A }), carrier({ id: 'car-b', code: '3PL-002', name: 'CARRIER B' })]);
    mount();
    expect(await screen.findByText('CARRIER A SDN BHD')).toBeTruthy();
    expect(screen.getByText('400-X001')).toBeTruthy();
    expect(screen.getByText('No supplier linked')).toBeTruthy();
  });

  test('registering: the picker finds a supplier by name or code, fills the empty name, and posts its id', async () => {
    serve([carrier({})]);
    mount();
    await screen.findByText('No supplier linked');
    const picker = screen.getByRole('combobox', { name: 'Supplier' });
    fireEvent.focus(picker);
    fireEvent.change(picker, { target: { value: 'carrier b' } });
    expect(await screen.findByRole('option', { name: '400-X002 · CARRIER B SDN BHD' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: '400-X003 · CARRIER C SDN BHD' })).toBeNull();

    fireEvent.change(picker, { target: { value: '400-x003' } });
    const option = await screen.findByRole('option', { name: '400-X003 · CARRIER C SDN BHD' });
    expect(screen.queryByRole('option', { name: '400-X002 · CARRIER B SDN BHD' })).toBeNull();
    fireEvent.mouseDown(option);

    expect((screen.getByPlaceholderText('e.g. ABC Logistics Sdn Bhd') as HTMLInputElement).value).toBe('CARRIER C SDN BHD');
    fireEvent.click(screen.getByRole('button', { name: /Add company/ }));
    await waitFor(() => expect(bodyOf('POST')?.body).toMatchObject({ name: 'CARRIER C SDN BHD', supplierId: 'sup-c' }));
  });

  test('registering: a name typed first is kept when a supplier is picked', async () => {
    serve([carrier({})]);
    mount();
    await screen.findByText('No supplier linked');
    const name = screen.getByPlaceholderText('e.g. ABC Logistics Sdn Bhd') as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'MY CARRIER' } });
    const picker = screen.getByRole('combobox', { name: 'Supplier' });
    fireEvent.focus(picker);
    fireEvent.change(picker, { target: { value: '400-x002' } });
    fireEvent.mouseDown(await screen.findByRole('option', { name: '400-X002 · CARRIER B SDN BHD' }));
    expect(name.value).toBe('MY CARRIER');
  });

  test('editing: the saved link shows, an untouched link is not sent, and Clear unlinks', async () => {
    serve([carrier({ supplier: SUP_A })]);
    mount();
    await screen.findByText('CARRIER A SDN BHD');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const pickers = screen.getAllByRole('combobox', { name: 'Supplier' }) as HTMLInputElement[];
    expect(pickers[1]!.value).toBe('400-X001 · CARRIER A SDN BHD');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bodyOf('PATCH')).not.toBeNull());
    expect(bodyOf('PATCH')!.path).toBe('/threepl-companies/car-a');
    expect(bodyOf('PATCH')!.body).not.toHaveProperty('supplierId');

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear supplier' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bodyOf('PATCH', 1)?.body).toMatchObject({ supplierId: null }));
  });

  test('a saved link the supplier list leaves out (an inactive supplier) still shows when editing', async () => {
    serve([carrier({ supplier: { id: 'sup-old', code: '400-X009', name: 'OLD SUPPLIER' } })]);
    mount();
    await screen.findByText('OLD SUPPLIER');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const pickers = screen.getAllByRole('combobox', { name: 'Supplier' }) as HTMLInputElement[];
    expect(pickers[1]!.value).toBe('400-X009 · OLD SUPPLIER');
  });
});
