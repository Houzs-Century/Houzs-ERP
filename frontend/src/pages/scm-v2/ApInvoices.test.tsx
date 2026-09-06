/* AP Invoices — the Finance list shows BOTH kinds (owner 2026-09-06: 我想要
   两个都看到, 现有的 purchase invoice remain): purchase invoices as a
   read-only mirror linking to their own page, AP invoices raised here with
   Post / Cancel. The server half is backend/tests/apInvoices.test.ts. */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';

const createAsync = vi.fn(async (_b: unknown) => ({ ok: true, invoice: { id: 'api-2', invoice_number: '2990-API-2609-002', total_sen: 42_000 } }));
const postAsync = vi.fn(async (_id: unknown) => ({ ok: true, jeNo: '2990-JE-2609-030', status: 'posted' }));
const cancelAsync = vi.fn(async (_id: unknown) => ({ ok: true }));

vi.mock('../../vendor/scm/lib/ap-invoice-queries', () => ({
  useApInvoices: () => ({ data: { rows: [
    { kind: 'API', id: 'api-1', invoiceNumber: '2990-API-2609-001', supplierId: 'sup-h', supplierCode: '405-H001', supplierName: 'HOUZS VENTURE HOLDING SDN BHD', supplierInvoiceRef: 'HVH-0912', invoiceDate: '2026-09-01', dueDate: '2026-09-30', currency: 'MYR', totalSen: 420_000, paidSen: 0, outstandingSen: 420_000, status: 'DRAFT' },
    { kind: 'PI', id: 'pi-1', invoiceNumber: '2990-PI-2607-005', supplierId: 'sup-t', supplierCode: '400-H004', supplierName: 'HOOKKA INDUSTRIES SDN. BHD.', supplierInvoiceRef: null, invoiceDate: '2026-06-27', dueDate: '2026-07-27', currency: 'MYR', totalSen: 300_000, paidSen: 100_000, outstandingSen: 200_000, status: 'PARTIALLY_PAID' },
  ] }, isLoading: false }),
  useApInvoiceDetail: (id: string | null) => ({ data: id ? {
    invoice: { id: 'api-1', invoice_number: '2990-API-2609-001', supplier_id: 'sup-h', supplier_invoice_ref: 'HVH-0912', invoice_date: '2026-09-01', due_date: null, currency: 'MYR', total_sen: 420_000, paid_sen: 0, status: 'DRAFT', notes: null, posted_at: null, posted_by: null },
    lines: [{ id: 'l1', line_no: 1, description: 'Rent Sept', debit_account_code: '900-A001', amount_sen: 400_000 }, { id: 'l2', line_no: 2, description: null, debit_account_code: '900-A002', amount_sen: 20_000 }],
    supplier: { id: 'sup-h', code: '405-H001', name: 'HOUZS VENTURE HOLDING SDN BHD' },
  } : undefined, isLoading: false }),
  useCreateApInvoice: () => ({ mutateAsync: createAsync, isPending: false }),
  usePostApInvoice: () => ({ mutateAsync: postAsync, isPending: false }),
  useCancelApInvoice: () => ({ mutateAsync: cancelAsync, isPending: false }),
}));
vi.mock('../../vendor/scm/lib/accounting-queries', () => ({
  isControlSpecial: (s: string | null | undefined) => s === 'SDC' || s === 'SCC' || s === 'SBS',
  useAccounts: () => ({ data: { accounts: [
    { account_code: '900-0000', account_name: 'Operating Expense', account_type: 'EXPENSE', parent_code: null, is_active: true, acc_money: false, special_type: null },
    { account_code: '900-A001', account_name: 'RENTAL', account_type: 'EXPENSE', parent_code: '900-0000', is_active: true, acc_money: false, special_type: null },
    { account_code: '400-0000', account_name: 'ACCOUNT PAYABLE', account_type: 'LIABILITY', parent_code: null, is_active: true, acc_money: false, special_type: 'SCC' },
  ] }, isLoading: false }),
}));
vi.mock('../../vendor/scm/lib/suppliers-queries', () => ({
  useSuppliers: () => ({ data: [{ id: 'sup-h', code: '405-H001', name: 'HOUZS VENTURE HOLDING SDN BHD' }], isLoading: false }),
}));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
const confirmFn = vi.fn(async (_a: unknown) => true);
vi.mock('../../vendor/scm/components/ConfirmDialog', () => ({ useConfirm: () => confirmFn }));
vi.mock('../../vendor/scm/components/NotifyDialog', () => ({ useNotify: () => vi.fn() }));

import { ApInvoices } from './ApInvoices';

const draw = () => render(<MemoryRouter><ApInvoices /></MemoryRouter>);

describe('both kinds on one list', () => {
  test('a purchase invoice mirrors with a link to its own page; an AP invoice opens here', () => {
    draw();
    expect(screen.getByText('Purchase Invoice')).toBeTruthy();
    expect(screen.getByText('AP Invoice')).toBeTruthy();
    expect(screen.getByText('2990-PI-2607-005').closest('a')!.getAttribute('href')).toBe('/scm/purchase-invoices/pi-1');
    expect(screen.getByText('2990-PI-2607-005').closest('tr')!.textContent).toContain('2,000.00');
  });

  test('opening a draft AP invoice shows its lines; Post confirms then calls the post', async () => {
    postAsync.mockClear(); confirmFn.mockClear();
    draw();
    fireEvent.click(screen.getByText('2990-API-2609-001'));
    expect(screen.getByText('Rent Sept')).toBeTruthy();
    fireEvent.click(screen.getByText('Post'));
    await waitFor(() => expect(postAsync).toHaveBeenCalledWith('api-1'));
    expect(JSON.stringify(confirmFn.mock.calls[0]![0])).toMatch(/Post 2990-API-2609-001/);
  });
});

describe('raising an AP invoice', () => {
  test('supplier, a line on a LEAF account (headers and controls never offered), amount → the create payload', async () => {
    createAsync.mockClear();
    draw();
    fireEvent.click(screen.getByText('New AP invoice'));
    fireEvent.focus(screen.getByLabelText('AP invoice supplier'));
    fireEvent.mouseDown(screen.getByText('405-H001 · HOUZS VENTURE HOLDING SDN BHD'));
    fireEvent.change(screen.getByLabelText('Supplier invoice ref'), { target: { value: 'HVH-1001' } });
    fireEvent.change(screen.getByLabelText('line 1 description'), { target: { value: 'Rent Oct' } });
    /* The account combobox: the header 900-0000 and the control 400-0000 are absent. */
    const accountBox = screen.getAllByRole('combobox').find((el) => (el as HTMLInputElement).placeholder.includes('account this line'))!;
    fireEvent.focus(accountBox);
    expect(screen.queryByText(/Operating Expense/)).toBeNull();
    expect(screen.queryByText(/ACCOUNT PAYABLE/)).toBeNull();
    fireEvent.mouseDown(screen.getByText('900-A001 · RENTAL'));
    fireEvent.change(screen.getByLabelText('line 1 amount'), { target: { value: '420' } });
    fireEvent.click(screen.getByText('Save as draft'));
    await waitFor(() => expect(createAsync).toHaveBeenCalled());
    expect(createAsync.mock.calls[0]![0]).toMatchObject({
      supplierId: 'sup-h', supplierInvoiceRef: 'HVH-1001',
      lines: [{ description: 'Rent Oct', debitAccountCode: '900-A001', amountSen: 42_000 }],
    });
  });
});
