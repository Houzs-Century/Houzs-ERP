/* Setup › Deposit invoices (the owner's Claude Design, batch 5 step 5): the
   per-company switch that issues a deposit invoice for every customer payment
   and the day it counts from, moved off the old Deposit invoices page. The
   same read and save (GET / POST /deposit-invoices/settings); Save shows only
   once something changed; switching on needs a day. The server half is
   backend/tests/depositInvoices.test.ts. */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const SETTINGS = { value: { data: { settings: { enabled: true, fromDate: '2026-09-15' }, missingCount: 0, deliveredUninvoicedCount: 0 }, isLoading: false, isError: false, error: null } as Record<string, unknown> };
const saveMutate = vi.fn();
vi.mock('../../../vendor/scm/lib/deposit-invoice-queries', () => ({
  useDepositInvoiceSettings: () => SETTINGS.value,
  useSaveDepositInvoiceSettings: () => ({ mutate: saveMutate, isPending: false }),
}));
const PERMS = { value: new Set<string>(['*']) };
vi.mock('../../../auth/AuthContext', () => ({ useAuth: () => ({ can: (p: string) => PERMS.value.has('*') || PERMS.value.has(p) }) }));

const { DepositInvoiceSetup } = await import('./DepositInvoiceSetup');
const { ToastProvider } = await import('../../../hooks/useToast');
const draw = () => render(<MemoryRouter><ToastProvider><DepositInvoiceSetup /></ToastProvider></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  PERMS.value = new Set(['*']);
  SETTINGS.value = { data: { settings: { enabled: true, fromDate: '2026-09-15' }, missingCount: 0, deliveredUninvoicedCount: 0 }, isLoading: false, isError: false, error: null };
});

describe('Setup › Deposit invoices', () => {
  test('says the switch is on and from when; Save shows once something changed and sends the pair', async () => {
    draw();
    expect(screen.getByRole('heading', { name: 'Deposit invoices' })).toBeTruthy();
    expect(screen.getByText('On · payments dated from 2026/09/15')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    const sw = screen.getByRole('switch', { name: 'Issue a deposit invoice for every customer payment' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(saveMutate.mock.calls[0]![0]).toEqual({ enabled: false, fromDate: '2026-09-15' });
    const done = saveMutate.mock.calls[0]![1] as { onSuccess: (r: unknown) => void };
    done.onSuccess({ settings: { enabled: false, fromDate: '2026-09-15' } });
    await waitFor(() => expect(screen.getByText('Saved · off')).toBeTruthy());
  });

  test('switching on with no day is refused on the spot, nothing sent', () => {
    SETTINGS.value = { data: { settings: { enabled: false, fromDate: null }, missingCount: 0, deliveredUninvoicedCount: 0 }, isLoading: false, isError: false, error: null };
    draw();
    expect(screen.getByText('Off')).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'Issue a deposit invoice for every customer payment' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(saveMutate).not.toHaveBeenCalled();
    expect(screen.getByText('Type the start day as 2026/09/15')).toBeTruthy();
  });

  test('without the post key the switch is read, not changed', () => {
    PERMS.value = new Set(['scm.access']);
    draw();
    expect((screen.getByRole('switch', { name: 'Issue a deposit invoice for every customer payment' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
