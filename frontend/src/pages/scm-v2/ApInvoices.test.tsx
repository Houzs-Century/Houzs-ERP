/* AP Invoices — the Finance list shows BOTH kinds (owner 2026-09-06: 我想要
   两个都看到, 现有的 purchase invoice remain): purchase invoices as a
   read-only mirror linking to their own page, AP invoices raised here.
   Round 2: the list filters by supplier and prints what it shows, the bill
   carries an overall description. Round 3: a bill opens in a pop-out over
   the list; every field can be edited (a posted bill re-posts); a bill can
   be copied; the form's lines are a table in the owner's order with Insert
   adding a line and landing on it, amounts reading 1,800.00; the form scans
   a bill and attaches its pages after save. The server half is
   backend/tests/apInvoices.test.ts + apInvoiceEdit.test.ts. */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';

const createAsync = vi.fn(async (_b: unknown) => ({ ok: true, invoice: { id: 'api-2', invoice_number: '2990-API-2609-002', total_sen: 42_000 } }));
const updateAsync = vi.fn(async (_v: unknown) => ({ ok: true, invoice: { id: 'api-1', invoice_number: '2990-API-2609-001', total_sen: 420_000 }, reposted: false }));
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
/* The detail's status — flipped by tests: a DRAFT may lose a file and edits plainly, a POSTED bill keeps files and re-posts on edit. */
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
  useUpdateApInvoice: () => ({ mutateAsync: updateAsync, isPending: false }),
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
    { account_code: '900-A002', account_name: 'SERVICE FEE', account_type: 'EXPENSE', parent_code: '900-0000', is_active: true, acc_money: false, special_type: null },
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
const dialog = () => screen.getByRole('dialog');
const setAmount = (label: string, rm: string) => {
  const box = screen.getByLabelText(label);
  fireEvent.focus(box);
  fireEvent.change(box, { target: { value: rm } });
  fireEvent.blur(box);
};

describe('both kinds on one list', () => {
  test('a purchase invoice mirrors with a link to its own page; the description shows', () => {
    draw();
    expect(screen.getByText('Purchase Invoice')).toBeTruthy();
    expect(screen.getByText('AP Invoice')).toBeTruthy();
    expect(screen.getByText('2990-PI-2607-005').closest('a')!.getAttribute('href')).toBe('/scm/purchase-invoices/pi-1');
    expect(screen.getByText('2990-PI-2607-005').closest('tr')!.textContent).toContain('2,000.00');
    expect(screen.getByText('Rent September')).toBeTruthy();
  });

  test('an AP invoice opens in a pop-out OVER the list with its lines and description; Post confirms then calls the post', async () => {
    postAsync.mockClear(); confirmFn.mockClear();
    draw();
    fireEvent.click(screen.getByText('2990-API-2609-001'));
    const d = dialog();
    expect(within(d).getByText('Rent Sept')).toBeTruthy();
    expect(within(d).getByText('Rent September')).toBeTruthy();
    /* The list is still there behind it — nothing was pushed in above it. */
    expect(screen.getByText('2990-PI-2607-005')).toBeTruthy();
    fireEvent.click(within(d).getByText('Post'));
    await waitFor(() => expect(postAsync).toHaveBeenCalledWith('api-1'));
    expect(JSON.stringify(confirmFn.mock.calls[0]![0])).toMatch(/Post 2990-API-2609-001/);
    fireEvent.click(within(d).getByLabelText('Close'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('the supplier filter narrows the list, and Print listing prints exactly what is shown', () => {
    listingAsync.mockClear();
    draw();
    fireEvent.click(screen.getByText('Print listing'));
    expect((listingAsync.mock.calls[0]![0] as unknown[]).length).toBe(2);
    expect(listingAsync.mock.calls[0]![1]).toEqual({ kind: 'ALL', supplierName: null });
    fireEvent.focus(screen.getByLabelText('Filter by supplier'));
    fireEvent.mouseDown(screen.getByText('400-H004 · HOOKKA INDUSTRIES SDN. BHD.'));
    expect(screen.queryByText('2990-API-2609-001')).toBeNull();
    fireEvent.click(screen.getByText('Print listing'));
    expect((listingAsync.mock.calls[1]![0] as unknown[]).length).toBe(1);
    expect(listingAsync.mock.calls[1]![1]).toEqual({ kind: 'ALL', supplierName: 'HOOKKA INDUSTRIES SDN. BHD.' });
  });
});

describe('raising an AP invoice', () => {
  test('supplier, a line on a LEAF account (headers and controls never offered), an amount that reads 420.00 → the create payload', async () => {
    createAsync.mockClear();
    draw();
    fireEvent.click(screen.getByText('New AP invoice'));
    const d = dialog();
    fireEvent.focus(within(d).getByLabelText('AP invoice supplier'));
    fireEvent.mouseDown(screen.getByText('405-H001 · HOUZS VENTURE HOLDING SDN BHD'));
    fireEvent.change(within(d).getByLabelText('Supplier invoice ref'), { target: { value: 'HVH-1001' } });
    fireEvent.change(within(d).getByLabelText('AP invoice description'), { target: { value: 'Rent October' } });
    fireEvent.change(within(d).getByLabelText('line 1 description'), { target: { value: 'Rent Oct' } });
    const accountBox = within(d).getAllByRole('combobox').find((el) => (el as HTMLInputElement).placeholder.includes('account this line'))!;
    fireEvent.focus(accountBox);
    expect(screen.queryByText(/Operating Expense/)).toBeNull();
    expect(screen.queryByText(/ACCOUNT PAYABLE/)).toBeNull();
    fireEvent.mouseDown(screen.getByText('900-A001 · RENTAL'));
    setAmount('line 1 amount', '420');
    expect((within(d).getByLabelText('line 1 amount') as HTMLInputElement).value).toBe('420.00');
    fireEvent.click(within(d).getByText('Save as draft'));
    await waitFor(() => expect(createAsync).toHaveBeenCalled());
    expect(createAsync.mock.calls[0]![0]).toMatchObject({
      supplierId: 'sup-h', supplierInvoiceRef: 'HVH-1001', notes: 'Rent October',
      lines: [{ description: 'Rent Oct', debitAccountCode: '900-A001', amountSen: 42_000 }],
    });
  });

  test("the lines are a table in the owner's order; Insert adds a line and lands on its account; Enter on an amount moves down; a line can be removed", () => {
    draw();
    fireEvent.click(screen.getByText('New AP invoice'));
    const d = dialog();
    const amountHead = within(d).getByText('Amount (RM)');
    expect([...amountHead.parentElement!.children].map((c) => c.textContent)).toEqual(['Account', 'Description', 'Amount (RM)', '']);

    fireEvent.keyDown(within(d).getByLabelText('line 1 amount'), { key: 'Insert' });
    expect(within(d).getByLabelText('line 2 amount')).toBeTruthy();
    const landed = document.activeElement as HTMLElement | null;
    expect(landed?.getAttribute('role')).toBe('combobox');
    expect(landed?.closest('tr')?.getAttribute('data-line')).toBe('2');

    fireEvent.keyDown(within(d).getByLabelText('line 2 amount'), { key: 'Enter' });
    expect(within(d).getByLabelText('line 3 amount')).toBeTruthy();
    expect((document.activeElement as HTMLElement | null)?.closest('tr')?.getAttribute('data-line')).toBe('3');

    fireEvent.click(within(d).getByLabelText('remove line 3'));
    expect(within(d).queryByLabelText('line 3 amount')).toBeNull();
  });
});

describe('the scanned bill (OCR) and its files', () => {
  test("Scan bill pre-fills the supplier, the bill's number, dates and lines with the remembered account; the pages attach after save", async () => {
    createAsync.mockClear(); uploadAsync.mockClear();
    draw();
    fireEvent.click(screen.getByText('New AP invoice'));
    const d = dialog();
    const page = new File(['%PDF'], 'rent.pdf', { type: 'application/pdf' });
    fireEvent.change(within(d).getByLabelText('Scan bill files'), { target: { files: [page] } });
    await waitFor(() => expect(within(d).getByText(/Read — check every figure/)).toBeTruthy());
    expect(extractAsync).toHaveBeenCalledWith([{ files: [{ name: 'rent.pdf', mime: 'application/pdf', dataBase64: 'b64:rent.pdf' }] }]);
    expect((within(d).getByLabelText('Supplier invoice ref') as HTMLInputElement).value).toBe('HVH-0912');
    /* The amount re-dresses from the new line value in a passive effect — a tick after the note. */
    await waitFor(() => expect((within(d).getByLabelText('line 1 amount') as HTMLInputElement).value).toBe('4,000.00'));
    expect(within(d).getByText(/Account 900-A001 filled/)).toBeTruthy();
    expect(within(d).getByText(/1 scanned file\(s\) will be attached/)).toBeTruthy();

    fireEvent.click(within(d).getByText('Save as draft'));
    await waitFor(() => expect(createAsync).toHaveBeenCalled());
    expect(createAsync.mock.calls[0]![0]).toMatchObject({
      supplierId: 'sup-h', supplierInvoiceRef: 'HVH-0912', invoiceDate: '2026-09-01', dueDate: '2026-09-30',
      lines: [{ description: 'Rent Sept', debitAccountCode: '900-A001', amountSen: 400_000 }],
    });
    await waitFor(() => expect(uploadAsync).toHaveBeenCalledWith({ invoiceId: 'api-2', file: { name: 'rent.pdf', mime: 'application/pdf', dataBase64: 'b64:rent.pdf' } }));
  });

  test('the Files card in the pop-out: a draft bill may lose a file; a posted bill keeps its files but still takes one', () => {
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

describe('editing and copying a bill (round 3)', () => {
  test('Edit opens the form filled from the bill and saving sends the PATCH; a posted bill says it will re-post', async () => {
    updateAsync.mockClear();
    detailStatus = 'DRAFT';
    const first = draw();
    fireEvent.click(screen.getByText('2990-API-2609-001'));
    fireEvent.click(screen.getByText('Edit'));
    const form = screen.getAllByRole('dialog')[1]!;
    expect((within(form).getByLabelText('Supplier invoice ref') as HTMLInputElement).value).toBe('HVH-0912');
    expect((within(form).getByLabelText('line 1 amount') as HTMLInputElement).value).toBe('4,000.00');
    fireEvent.change(within(form).getByLabelText('AP invoice description'), { target: { value: 'Rent Sept revised' } });
    fireEvent.click(within(form).getByText('Save changes'));
    await waitFor(() => expect(updateAsync).toHaveBeenCalled());
    expect(updateAsync.mock.calls[0]![0]).toMatchObject({
      id: 'api-1',
      body: { supplierId: 'sup-h', supplierInvoiceRef: 'HVH-0912', invoiceDate: '2026-09-01', notes: 'Rent Sept revised',
        lines: [{ description: 'Rent Sept', debitAccountCode: '900-A001', amountSen: 400_000 }, { debitAccountCode: '900-A002', amountSen: 20_000 }] },
    });
    first.unmount();

    detailStatus = 'POSTED';
    draw();
    fireEvent.click(screen.getByText('2990-API-2609-001'));
    fireEvent.click(screen.getByText('Edit'));
    const posted = screen.getAllByRole('dialog')[1]!;
    expect(within(posted).getByText(/saving re-posts it/)).toBeTruthy();
    expect(within(posted).getByText('Save & re-post')).toBeTruthy();
    detailStatus = 'DRAFT';
  });

  test("Copy opens the form with the bill's supplier, description and lines, no supplier number and today's date; saving raises a new bill", async () => {
    createAsync.mockClear();
    draw();
    fireEvent.click(screen.getByText('2990-API-2609-001'));
    fireEvent.click(screen.getByText('Copy'));
    const form = screen.getAllByRole('dialog')[1]!;
    expect((within(form).getByLabelText('Supplier invoice ref') as HTMLInputElement).value).toBe('');
    expect((within(form).getByLabelText('AP invoice description') as HTMLInputElement).value).toBe('Rent September');
    expect((within(form).getByLabelText('line 1 amount') as HTMLInputElement).value).toBe('4,000.00');
    expect((within(form).getByLabelText('line 2 amount') as HTMLInputElement).value).toBe('200.00');
    fireEvent.click(within(form).getByText('Save as draft'));
    await waitFor(() => expect(createAsync).toHaveBeenCalled());
    const body = createAsync.mock.calls[0]![0] as { supplierId: string; supplierInvoiceRef?: string; notes?: string; lines: unknown[] };
    expect(body.supplierId).toBe('sup-h');
    expect(body.supplierInvoiceRef).toBeUndefined();
    expect(body.notes).toBe('Rent September');
    expect(body.lines).toHaveLength(2);
  });
});
