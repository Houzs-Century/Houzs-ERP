/* Supplier Maintenance (owner 2026-10-02) — Finance's own supplier list in
   Money out. Pinned: what each supplier is owed and its bank on the list, the
   chips (other creditors, missing TIN, Finance only), the pop-out with the
   Finance part, the open bills and the latest payments, and the form: a supplier
   Finance opens is Finance's alone unless 采购也用 is ticked, its bank rides
   along, a code that names neither control is flagged, and an edit sends the
   code only when it changed. A caller who is not Finance gets no form and no
   Finance part. */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

type Row = Record<string, unknown>;
let list: { rows: Row[]; finance: boolean } = { rows: [], finance: true };
let detail: Row | undefined;
const createSupplier = vi.fn();
const updateSupplier = vi.fn();
vi.mock('../../vendor/scm/lib/supplier-maintenance-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/supplier-maintenance-queries')>()),
  useSupplierMaintenance: () => ({ data: { ...list, controls: { trade: '400-0000', other: '405-0000' } }, isLoading: false, isError: false, error: null }),
  useSupplierMaintenanceDetail: (id: string | null) => ({ data: id ? detail : undefined, isLoading: false, isError: false, error: null }),
  useCreateMaintainedSupplier: () => ({ mutateAsync: createSupplier, isPending: false }),
  useUpdateMaintainedSupplier: () => ({ mutateAsync: updateSupplier, isPending: false }),
}));

import { SupplierMaintenance, codeNote } from './SupplierMaintenance';

const row = (over: Row): Row => ({
  id: 's-bed', code: '400-B001', name: 'BEST BED SDN BHD', status: 'ACTIVE', currency: 'MYR', paymentTerms: '30 days',
  controlKind: 'TRADE', controlCode: '400-0000', tinNumber: 'C123', businessRegNo: null, registrationNo: '2019', missingTax: false,
  bankName: 'Maybank', bankAccountNo: '5123 4567 8901', bankAccountName: 'BEST BED SDN BHD', forPurchasing: true,
  owedSen: 800_000, advanceSen: 30_000, creditSen: 0, openInvoices: 2, openSen: 800_000, preErpSen: 0, ...over,
});
const LAND = row({ id: 's-land', code: '405-L001', name: 'MAJU PROPERTY SDN BHD', controlKind: 'OTHER', controlCode: '405-0000', missingTax: true, tinNumber: null, registrationNo: null, bankName: null, bankAccountNo: null, forPurchasing: false, owedSen: 300_000, advanceSen: 0, openInvoices: 1 });

const draw = () => render(<MemoryRouter><SupplierMaintenance /></MemoryRouter>);

beforeEach(() => {
  list = { rows: [row({}), LAND], finance: true };
  detail = undefined;
  createSupplier.mockReset().mockResolvedValue({ supplier: { id: 's-new' } });
  updateSupplier.mockReset().mockResolvedValue({ supplier: { id: 's-bed' } });
});

describe('the list', () => {
  test('what each supplier is owed, its bank, and the chips that narrow it', () => {
    draw();
    expect(screen.getByText('BEST BED SDN BHD')).toBeTruthy();
    expect(screen.getByText('RM 8,000.00')).toBeTruthy();
    expect(screen.getByText('Maybank · 5123 4567 8901')).toBeTruthy();
    expect(screen.getByText('Finance only')).toBeTruthy();

    fireEvent.click(screen.getByText('Other creditor 405 · 1'));
    expect(screen.queryByText('BEST BED SDN BHD')).toBeNull();
    expect(screen.getByText('MAJU PROPERTY SDN BHD')).toBeTruthy();
    fireEvent.click(screen.getByText('缺 TIN / 注册号 · 1'));
    expect(screen.getByText('MAJU PROPERTY SDN BHD')).toBeTruthy();
    fireEvent.click(screen.getByText('全部 · All · 2'));
    expect(screen.getByText('BEST BED SDN BHD')).toBeTruthy();
  });

  test('a caller who is not Finance: no form, no Finance chips or columns', () => {
    list = { rows: [row({ tinNumber: undefined, bankName: undefined, bankAccountNo: undefined, forPurchasing: undefined, missingTax: undefined })], finance: false };
    draw();
    expect(screen.queryByText('New supplier')).toBeNull();
    expect(screen.queryByText(/缺 TIN/)).toBeNull();
    expect(screen.queryByText('Bank')).toBeNull();
    expect(screen.getByText('RM 8,000.00')).toBeTruthy();
  });
});

describe('the pop-out', () => {
  test('the Finance part, open bills (AutoCount ones marked), what is not knocked off, latest payments', () => {
    detail = {
      supplier: { id: 's-bed', code: '400-B001', name: 'BEST BED SDN BHD', status: 'ACTIVE', currency: 'MYR', payment_terms: '30 days', tin_number: 'C123', bank_name: 'Maybank', bank_account_no: '5123 4567 8901', bank_account_name: 'BEST BED SDN BHD', for_purchasing: true },
      finance: true, controlCode: '400-0000', balanceSen: 800_000,
      openInvoices: [
        { kind: 'PI', id: 'pi-old', number: 'PI-2405-001', supplierRef: 'OLD-1', date: '2024-05-02', dueDate: null, currency: 'MYR', totalSen: 40_000, outstandingSen: 40_000, outstandingMyrSen: 40_000, status: 'POSTED', preErp: true },
        { kind: 'PI', id: 'pi-1', number: 'PI-2609-002', supplierRef: 'INV-9', date: '2026-09-10', dueDate: null, currency: 'MYR', totalSen: 1_000_000, outstandingSen: 800_000, outstandingMyrSen: 800_000, status: 'PARTIALLY_PAID', preErp: false },
      ],
      advances: [{ pvId: 'pv-adv', pvNumber: 'PV-2609-003', date: '2026-09-12', leftSen: 30_000 }],
      credits: [],
      payments: [{ id: 'pv-1', pvNumber: 'PV-2609-001', date: '2026-09-15', purpose: 'SUPPLIER_PAYMENT', status: 'POSTED', totalSen: 200_000, totalMyrSen: 200_000 }],
    };
    draw();
    fireEvent.click(screen.getByText('BEST BED SDN BHD'));
    const dialog = screen.getByRole('dialog', { name: 'Supplier 400-B001' });
    const d = within(dialog);
    expect(d.getByText('Owed — the books (400-0000)')).toBeTruthy();
    expect(d.getByText('AutoCount')).toBeTruthy();
    expect(d.getByText('PI-2609-002').getAttribute('href')).toBe('/scm/purchase-invoices/pi-1');
    expect(d.getByText('PV-2609-003')).toBeTruthy();
    expect(d.getByText('PV-2609-001')).toBeTruthy();
    expect(d.getByText('5123 4567 8901')).toBeTruthy();
    expect(d.getByText('Edit')).toBeTruthy();
  });
});

describe('the form', () => {
  test('a supplier Finance opens is Finance\'s alone, with its bank', async () => {
    draw();
    fireEvent.click(screen.getByText('New supplier'));
    fireEvent.change(screen.getByLabelText('Credit Account (code)'), { target: { value: '405-T009' } });
    fireEvent.change(screen.getByLabelText('Company name *'), { target: { value: 'TENAGA NASIONAL BERHAD' } });
    fireEvent.change(screen.getByLabelText('Bank'), { target: { value: 'Maybank' } });
    fireEvent.change(screen.getByLabelText('Account no.'), { target: { value: '5123 0000 1111' } });
    expect((screen.getByLabelText('采购也用 · Purchasing uses it too') as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText('Other creditor — posts to 405-0000.')).toBeTruthy();
    fireEvent.click(screen.getByText('Create supplier'));
    await waitFor(() => expect(createSupplier).toHaveBeenCalled());
    expect(createSupplier.mock.calls[0]![0]).toMatchObject({ code: '405-T009', name: 'TENAGA NASIONAL BERHAD', forPurchasing: false, bankName: 'Maybank', bankAccountNo: '5123 0000 1111' });
  });

  test('an edit sends the code only when it changed; the tick shares the supplier', async () => {
    detail = {
      supplier: { id: 's-land', code: '405-L001', name: 'MAJU PROPERTY SDN BHD', status: 'ACTIVE', currency: 'MYR', for_purchasing: false, bank_name: null },
      finance: true, controlCode: '405-0000', balanceSen: 300_000, openInvoices: [], advances: [], credits: [], payments: [],
    };
    draw();
    fireEvent.click(screen.getByText('MAJU PROPERTY SDN BHD'));
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.click(screen.getByLabelText('采购也用 · Purchasing uses it too'));
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(updateSupplier).toHaveBeenCalled());
    const body = updateSupplier.mock.calls[0]![0] as Row;
    expect(body).toMatchObject({ id: 's-land', forPurchasing: true });
    expect('code' in body).toBe(false);
  });

  test('a code that names neither control is flagged — the bank goes in the bank fields', () => {
    expect(codeNote('23600599248')).toMatch(/neither 400- nor 405-/);
    expect(codeNote('400-B001')).toBe('Trade creditor — posts to 400-0000.');
    expect(codeNote('')).toBeNull();
  });
});
