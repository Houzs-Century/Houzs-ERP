/* Other Debtors — the page contract (owner 2026-09-03): registry rows with
   outstanding. 2026-09-21: the party's own data, one pop-out form for New
   and Edit. 2026-09-29 (owner: 我希望 other debtor 那边只是 maintain other
   debtor 就好, 开 other debtor 的 bill 就直接在 ar invoice 页面): the page is
   the REGISTRY ALONE — no bill, no receipt raised here; a debtor's card links
   to its bills on AR Invoices. The bill's page contract moved to
   ArInvoices.test.tsx; the server half is backend/tests/otherDebtors.test.ts. */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';

const createDebtorAsync = vi.fn(async (_b: unknown) => ({ ok: true, debtor: { id: 'd9' } }));
const updateDebtorAsync = vi.fn(async (_b: unknown) => ({ ok: true }));

const baseDebtor = () => ({ id: 'd1', name: 'AHMAD BIN ALI', phone: '012-345', notes: null, is_active: true, outstanding_sen: 50000 });
let debtors: Array<Record<string, unknown>> = [baseDebtor()];

vi.mock('../../vendor/scm/lib/accounting-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/accounting-queries')>()),
  useOtherDebtors: () => ({ data: { debtors }, isLoading: false }),
  useCreateDebtor: () => ({ mutateAsync: createDebtorAsync, isPending: false }),
  useUpdateDebtor: () => ({ mutateAsync: updateDebtorAsync, isPending: false }),
}));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock('../../vendor/scm/components/NotifyDialog', () => ({ useNotify: () => vi.fn() }));

import { OtherDebtors } from './OtherDebtors';

const draw = () => render(<MemoryRouter><OtherDebtors /></MemoryRouter>);
const dialog = () => screen.getByRole('dialog');

describe('the registry', () => {
  test('rows show the outstanding; picking one opens the card, which links to the bills on AR Invoices and raises nothing here', () => {
    debtors = [baseDebtor()];
    draw();
    expect(screen.getByText('RM 500.00')).toBeTruthy();
    fireEvent.click(screen.getByText('AHMAD BIN ALI'));
    expect(screen.getByText('Bills on AR Invoices').closest('a')!.getAttribute('href')).toBe('/scm/ar-invoices?debtor=d1');
    expect(screen.getByText(/the bills behind it, and a new one, live on AR Invoices/)).toBeTruthy();
    /* The registry alone (2026-09-29): no bill and no receipt is raised on this page. */
    expect(screen.queryByText('New bill')).toBeNull();
    expect(screen.queryByText('New receipt')).toBeNull();
    expect(screen.queryByText('Prepare')).toBeNull();
  });

  test('Deactivate sends the flag for the picked debtor', async () => {
    debtors = [baseDebtor()];
    updateDebtorAsync.mockClear();
    draw();
    fireEvent.click(screen.getByText('AHMAD BIN ALI'));
    fireEvent.click(screen.getByRole('button', { name: /Deactivate/ }));
    await waitFor(() => expect(updateDebtorAsync).toHaveBeenCalledWith({ id: 'd1', isActive: false }));
  });
});

describe("the debtor's own data (owner 2026-09-21: 他要填的资料就和 supplier 的一样)", () => {
  test('New debtor is a pop-out with identity, contact and address; Save sends every box, the country Malaysia by default', async () => {
    debtors = [];
    createDebtorAsync.mockClear();
    draw();
    fireEvent.click(screen.getByRole('button', { name: /New debtor/ }));
    const d = dialog();
    for (const [label, value] of [['Name', 'LIM AH KOW'], ['TIN Number', 'IG12345678090'], ['Address line 1', '12, JALAN SATU'], ['City', 'PETALING JAYA'], ['Postcode', '47810'], ['State', 'Selangor']]) {
      fireEvent.change(within(d).getByLabelText(label), { target: { value } });
    }
    fireEvent.click(within(d).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(createDebtorAsync).toHaveBeenCalled());
    expect(createDebtorAsync).toHaveBeenLastCalledWith(expect.objectContaining({
      name: 'LIM AH KOW', tinNumber: 'IG12345678090', address1: '12, JALAN SATU', city: 'PETALING JAYA', postcode: '47810', state: 'Selangor', country: 'Malaysia', phone: '',
    }));
  });

  test('the card shows the address the invoice will carry; Edit debtor opens it filled and sends the change', async () => {
    debtors = [{ ...baseDebtor(), address1: '12, JALAN SATU', city: 'PETALING JAYA', postcode: '47810', state: 'Selangor', country: 'Malaysia', email: 'ahmad@example.com', tin_number: 'IG12345678090' }];
    updateDebtorAsync.mockClear();
    draw();
    fireEvent.click(screen.getByText('AHMAD BIN ALI'));
    expect(screen.getByText('12, JALAN SATU')).toBeTruthy();
    expect(screen.getByText('47810 PETALING JAYA')).toBeTruthy();
    expect(screen.getByText('Selangor, Malaysia')).toBeTruthy();
    expect(screen.getByText(/TIN IG12345678090/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Edit debtor/ }));
    const d = dialog();
    expect((within(d).getByLabelText('Address line 1') as HTMLInputElement).value).toBe('12, JALAN SATU');
    expect((within(d).getByLabelText('Email') as HTMLInputElement).value).toBe('ahmad@example.com');
    fireEvent.change(within(d).getByLabelText('City'), { target: { value: 'KLANG' } });
    fireEvent.click(within(d).getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(updateDebtorAsync).toHaveBeenCalled());
    expect(updateDebtorAsync).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'd1', name: 'AHMAD BIN ALI', city: 'KLANG', address1: '12, JALAN SATU', email: 'ahmad@example.com' }));
  });
});
