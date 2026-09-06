/* AP Invoices — the Finance list shows BOTH kinds (owner 2026-09-06: 我想要
   两个都看到, 现有的 purchase invoice remain): purchase invoices as a
   read-only mirror linking to their own page, AP invoices raised here with
   Post / Cancel; the New card scans a bill and attaches its pages after save;
   round 2 — the list filters by supplier and prints what it shows, the lines
   are a table in the owner's order with a remove button, the bill carries an
   overall description. The server half is backend/tests/apInvoices.test.ts. */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';

const createAsync = vi.fn(async (_b: unknown) => ({ ok: true, invoice: { id: 'api-2', invoice_number: '2990-API-2609-002', total_sen: 42_000 } }));
const postAsync = vi.fn(async (_id: unknown) => ({ ok: true, jeNo: '2990-JE-2609-030', status: 'posted' }));
const cancelAsync = vi.fn(async (_id: unknown) => ({ ok: true }));
const uploadAsync = vi.fn(async (_v: unknown) => ({ ok: true, file: { id: 'f9' } }));
const deleteAsync = vi.fn(async (_v: unknown) => ({ ok: true }));
const listingAsync = vi.fn(async (_rows: unknown, _filter: unknown) => undefined);
const extractAsync = vi.fn(async (_bills: unknown) => ({ bills: [{
  index: 0, ok: true,
  extraction: {
    vendorName: 'HOUZS VENTURE HOLDING SDN. BHD.', vendorRegNo: null, documentKind: 'invoice', invoiceNumber: 'HVH-0912',
    invoiceDate: '2026-09-01', dueDate: '2026-09-30', currency: 'MYR', totalSen: 400_000, sstSen: null,
    lines: [{ description: 'Rent Sept', amountSen: 400_000 }],
  },
  supplierMatch: { id: 'sup-h', code: '405-H001', name: 'HOUZS VENTURE HOLDING SDN BHD', confidence: 'contains' },
  memory: { payeeName: 'HOUZS VENTURE HOLDING SDN BHD', debitAccountCode: '900-A001', purpose: 'SUPPLIER_PAYMENT', timesSeen: 1 },
}] }));
/* The detail's status — flipped by the files-card test: a DRAFT may lose a file, a POSTED bill keeps it. */
let detailStatus = 'DRAFT';

const ROWS = [
  { kind: 'API', id: 'api-1', invoiceNumber: '2990-API-2609-001', supplierId: 'sup-h', supplierCode: '405-H001', supplierName: 'HOUZS VENTURE HOLDING SDN BHD', supplierInvoiceRef: 'HVH-0912', description: 'Rent September', invoiceDate: '2026-09-01', dueDate: '2026-09-30', currency: 'MYR', totalSen: 420_000, paidSen: 0, outstandingSen: 420_000, status: 'DRAFT' },
  { kind: 'PI', id: 'pi-1', invoiceNumber: '2990-PI-2607-005', supplierId: 'sup-t', supplierCode: '400-H004', supplierName: 'HOOKKA INDUSTRIES SDN. BHD.', supplierInvoiceRef: null, description: null, invoiceDate: '2026-06-27', dueDate: '2026-07-27', currency: 'MYR', totalSen: 300_000, paidSen: 100_000, outstandingSen: 200_000, status: 'PARTIALLY_PAID' },
];

vi.mock('../../vendor/scm/lib/ap-invoice-queries', () => ({
  useApInvoices: () => ({ data: { rows: ROWS }, isLoading: false, isError: false, error: null }),
  useApInvoiceDetail: (id: string | null) => ({ data: id ? {
    invoice: { id: 'api-1', invoice_number: '2990-API-2609-001', supplier_id: 'sup-h', supplier_invoice_ref: 'HVH-0912', invoice_date: '2026-09-01', due_date: null, currency: 'MYR', total_sen: 420_000, paid_sen: 0, status: detailStatus, notes: 'Rent September', posted_at: null, posted_by: null },
    lines: [{ id: 'l1', line_no: 1, description: 'Rent Sept', debit_account_code: '900-A001', amount_sen: 400_000 }, { id: 'l2', line_no: 2, description: null, debit_account_code: '900-A002', amount_sen: 20_000 }],
    supplier: { id: 'sup-h', code: '405-H001', name: 'HOUZS VENTURE HOLDING SDN BHD' },
  } : undefined, isLoading: false }),
  useCreateApInvoice: () => ({ mutateAsync: createAsync, isPending: false }),
  usePostApInvoice: () => ({ mutateAsync: postAsync, isPending: false }),
  useCancelApInvoice: () => ({ mutateAsync: cancelAsync, isPending: false }),
  useApInvoiceFiles: (id: string | null) => ({ data: id ? { files: [{ id: 'f1', file_name: 'rent.pdf', mime: 'application/pdf', size_bytes: 120_000, sort_no: 1, created_at: '2026-09-06T02:00:00Z' }] } : undefined, isLoading: false }),
  useUploadApInvoiceFile: () => ({ mutateAsync: uploadAsync, isPending: false }),
  useDeleteApInvoiceFile: () => ({ mutateAsync: deleteAsync, isPending: false }),
  fetchApInvoiceFileBlobUrl: vi.fn(),
}));
vi.mock('../../vendor/scm/lib/payment-voucher-queries', () => ({
  useExtractBills: () => ({ mutateAsync: extractAsync, isPending: false }),
  fileToBase64: async (f: File) => `b64:${f.name}`,
  PV_FILE_ACCEPT: 'image/jpeg,image/png,image/webp,application/pdf',
}));
vi.mock('../../vendor/scm/lib/ap-invoice-listing-pdf', () => ({
  generateApListingPdf: (rows: unknown, filter: unknown) => listingAsync(rows, filter),
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
  test('a purchase invoice mirrors with a link to its own page; an AP invoice opens here; the description shows', () => {
    draw();
    expect(screen.getByText('Purchase Invoice')).toBeTruthy();
    expect(screen.getByText('AP Invoice')).toBeTruthy();
    expect(screen.getByText('2990-PI-2607-005').closest('a')!.getAttribute('href')).toBe('/scm/purchase-invoices/pi-1');
    expect(screen.getByText('2990-PI-2607-005').closest('tr')!.textContent).toContain('2,000.00');
    expect(screen.getByText('Rent September')).toBeTruthy();
  });

  test('opening a draft AP invoice shows its lines and its description; Post confirms then calls the post', async () => {
    postAsync.mockClear(); confirmFn.mockClear();
    draw();
    fireEvent.click(screen.getByText('2990-API-2609-001'));
    expect(screen.getByText('Rent Sept')).toBeTruthy();
    expect(screen.getAllByText('Rent September').length).toBe(2);
    fireEvent.click(screen.getByText('Post'));
    await waitFor(() => expect(postAsync).toHaveBeenCalledWith('api-1'));
    expect(JSON.stringify(confirmFn.mock.calls[0]![0])).toMatch(/Post 2990-API-2609-001/);
  });

  test('the supplier filter narrows the list, and Print listing prints exactly what is shown', () => {
    listingAsync.mockClear();
    draw();
    fireEvent.click(screen.getByText('Print listing'));
    expect(listingAsync).toHaveBeenCalledTimes(1);
    expect((listingAsync.mock.calls[0]![0] as unknown[]).length).toBe(2);
    expect(listingAsync.mock.calls[0]![1]).toEqual({ kind: 'ALL', supplierName: null });

    fireEvent.focus(screen.getByLabelText('Filter by supplier'));
    fireEvent.mouseDown(screen.getByText('400-H004 · HOOKKA INDUSTRIES SDN. BHD.'));
    expect(screen.queryByText('2990-API-2609-001')).toBeNull();
    expect(screen.getByText('2990-PI-2607-005')).toBeTruthy();

    fireEvent.click(screen.getByText('Print listing'));
    expect(listingAsync).toHaveBeenCalledTimes(2);
    expect((listingAsync.mock.calls[1]![0] as unknown[]).length).toBe(1);
    expect(listingAsync.mock.calls[1]![1]).toEqual({ kind: 'ALL', supplierName: 'HOOKKA INDUSTRIES SDN. BHD.' });
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
    fireEvent.change(screen.getByLabelText('AP invoice description'), { target: { value: 'Rent October' } });
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
      supplierId: 'sup-h', supplierInvoiceRef: 'HVH-1001', notes: 'Rent October',
      lines: [{ description: 'Rent Oct', debitAccountCode: '900-A001', amountSen: 42_000 }],
    });
  });

  test('the lines are a table in the owner\'s order — account, description, amount — and a line can be removed', () => {
    draw();
    fireEvent.click(screen.getByText('New AP invoice'));
    const amountHead = screen.getByText('Amount (RM)');
    expect([...amountHead.parentElement!.children].map((c) => c.textContent)).toEqual(['Account', 'Description', 'Amount (RM)', '']);
    expect(screen.queryByLabelText('remove line 1')).toBeNull();
    fireEvent.click(screen.getByText('Line'));
    expect(screen.getByLabelText('line 2 amount')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('remove line 2'));
    expect(screen.queryByLabelText('line 2 amount')).toBeNull();
    expect(screen.getByLabelText('line 1 amount')).toBeTruthy();
  });
});

describe('the scanned bill (OCR) and its files', () => {
  test('Scan bill pre-fills the supplier, the bill\'s number, dates and lines with the remembered account; the pages attach after save', async () => {
    createAsync.mockClear(); uploadAsync.mockClear();
    draw();
    fireEvent.click(screen.getByText('New AP invoice'));
    const page = new File(['%PDF'], 'rent.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText('Scan bill files'), { target: { files: [page] } });
    await waitFor(() => expect(screen.getByText(/Read — check every figure/)).toBeTruthy());
    expect(extractAsync).toHaveBeenCalledWith([{ files: [{ name: 'rent.pdf', mime: 'application/pdf', dataBase64: 'b64:rent.pdf' }] }]);
    expect((screen.getByLabelText('Supplier invoice ref') as HTMLInputElement).value).toBe('HVH-0912');
    expect((screen.getByLabelText('line 1 amount') as HTMLInputElement).value).toBe('4000');
    expect(screen.getByText(/Account 900-A001 filled/)).toBeTruthy();
    expect(screen.getByText(/1 scanned file\(s\) will be attached/)).toBeTruthy();

    fireEvent.click(screen.getByText('Save as draft'));
    await waitFor(() => expect(createAsync).toHaveBeenCalled());
    expect(createAsync.mock.calls[0]![0]).toMatchObject({
      supplierId: 'sup-h', supplierInvoiceRef: 'HVH-0912', invoiceDate: '2026-09-01', dueDate: '2026-09-30',
      lines: [{ description: 'Rent Sept', debitAccountCode: '900-A001', amountSen: 400_000 }],
    });
    await waitFor(() => expect(uploadAsync).toHaveBeenCalledWith({ invoiceId: 'api-2', file: { name: 'rent.pdf', mime: 'application/pdf', dataBase64: 'b64:rent.pdf' } }));
  });

  test('the Files card: a draft bill may lose a file; a posted bill keeps its files but still takes one', () => {
    detailStatus = 'DRAFT';
    const first = draw();
    fireEvent.click(screen.getByText('2990-API-2609-001'));
    expect(screen.getByText('rent.pdf')).toBeTruthy();
    expect(screen.getByLabelText('Remove rent.pdf')).toBeTruthy();
    expect(screen.getByLabelText('Attach bill files')).toBeTruthy();
    first.unmount();

    detailStatus = 'POSTED';
    draw();
    fireEvent.click(screen.getByText('2990-API-2609-001'));
    expect(screen.getByText('rent.pdf')).toBeTruthy();
    expect(screen.queryByLabelText('Remove rent.pdf')).toBeNull();
    expect(screen.getByLabelText('Attach bill files')).toBeTruthy();
    expect(screen.getByText(/locked with the posted bill/)).toBeTruthy();
    detailStatus = 'DRAFT';
  });
});
