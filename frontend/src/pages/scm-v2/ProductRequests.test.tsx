/* Product request (owner 2026-10-06; 2026-10-15 方案 A: header + lines) — the
   Product Requests page. Pinned:
     • a salesperson raises a request with SEVERAL lines — each an existing SKU
       or a new Model by name, fabric / size / leg, qty — plus the
       use, where and when, and it is sent with the fields the server reads;
     • a repack line is always an existing SKU; a new product line may name a
       new Model; a line can be added and removed;
     • the requester edits or withdraws their own waiting request; a rejected one
       shows the Purchaser's note and goes back with "Fix and send again";
     • the Purchaser approves the whole request, rejects with a note it must
       give, builds the Model + SKU PER LINE that asks for a new Model, and is
       sent to PC Order New (?fromProductRequest=) once every line has a SKU. */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';

type Req = Record<string, unknown>;
type Line = Record<string, unknown>;
const line = (over: Line): Line => ({
  id: 'l1', line_no: 1, item_code: null, proposed_model_name: 'Aurora', model_id: null, category: 'SOFA', compartment: '2S', fabric_code: 'LIN-01', seat_size: '22', leg_size: '4',
  qty: 2, unit_price_sen: null, remarks: 'Deeper seat', model: null,
  ...over,
});
const base = (over: Req): Req => ({
  id: 'r1', request_no: 'HC-PDR-2610-001', request_type: 'NEW_PRODUCT', application: 'SHOWROOM', requested_by: 31, requested_by_name: 'Amy Tan',
  special_remarks: 'For the corner', delivery_location_id: 'wh-kl', expected_delivery_date: '2026-10-25', status: 'REQUESTED',
  decision_note: null, decided_by: null, decided_at: null, pco_id: null, created_at: '2026-10-06T02:00:00Z', updated_at: '2026-10-06T02:00:00Z',
  lines: [line({})],
  pco: null, deliveryLocation: { id: 'wh-kl', code: 'KL', name: 'KL Showroom' },
  supplier_id: null, supplier: null,
  ...over,
});
let requests: Req[] = [];
let approver = false;
const createAsync = vi.fn(async (_b: Req) => ({ ok: true, request: base({ id: 'r-new' }) }));
const updateAsync = vi.fn(async (_b: Req) => ({ ok: true, request: base({}) }));
const withdrawMutate = vi.fn();
const approveMutate = vi.fn();
const rejectMutate = vi.fn();
const buildAsync = vi.fn(async (_b: Req) => ({ ok: true, model: { id: 'm1', modelCode: 'AURORA', created: true }, sku: { id: 's1', code: 'AURORA-2S' }, lineId: 'l1', request: base({ status: 'APPROVED', lines: [line({ item_code: 'AURORA-2S' })] }) }));
const closeMutate = vi.fn();
let files: Array<Record<string, unknown>> = [];
const uploadAsync = vi.fn(async (_b: Req) => ({ ok: true, file: { id: 'f-new' } }));
const removeFileAsync = vi.fn(async (_b: Req) => ({ ok: true }));

vi.mock('../../vendor/scm/lib/product-request-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/product-request-queries')>()),
  useProductRequests: () => ({ data: { requests, approver, mayRequest: true }, isLoading: false, isError: false, error: null }),
  useProductRequestSupplierOptions: () => ({ data: { suppliers: [{ id: 'sup-1', code: '400-D001', name: 'DIGLANT FURNITURE' }] }, isLoading: false }),
  useProductRequest: (id: string | null) => ({ data: id ? { request: requests.find((r) => r.id === id), approver, mayRequest: true } : undefined, isLoading: false }),
  useCreateProductRequest: () => ({ mutateAsync: createAsync, isPending: false }),
  useUpdateProductRequest: () => ({ mutateAsync: updateAsync, isPending: false }),
  useWithdrawProductRequest: () => ({ mutate: withdrawMutate, isPending: false }),
  useApproveProductRequest: () => ({ mutate: approveMutate, isPending: false }),
  useRejectProductRequest: () => ({ mutate: rejectMutate, isPending: false }),
  useCreateModelFromRequest: () => ({ mutateAsync: buildAsync, isPending: false }),
  useCloseProductRequest: () => ({ mutate: closeMutate, isPending: false }),
  useProductRequestFiles: (id: string | null) => ({ data: id ? { files } : undefined, isLoading: false }),
  useUploadProductRequestFile: () => ({ mutateAsync: uploadAsync, isPending: false }),
  useDeleteProductRequestFile: () => ({ mutateAsync: removeFileAsync, isPending: false }),
}));
vi.mock('../../vendor/scm/lib/mfg-products-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/mfg-products-queries')>()),
  useMfgProducts: () => ({ data: [{ id: 'mfg-1', code: '5530-3S', name: 'SOFA 5530 3 SEATER', category: 'SOFA' }], isLoading: false }),
  useMaintenanceConfig: () => ({ data: { data: { sofaCompartments: ['2S', '3S'], sofaSizes: ['22', '24'], sofaLegHeights: [{ value: '4' }, { value: '6' }], legHeights: [] } } }),
}));
vi.mock('../../vendor/scm/lib/fabric-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/fabric-queries')>()),
  useFabricTrackings: () => ({ data: [{ id: 'f1', fabric_code: 'LIN-01', fabric_description: 'Linen', supplier_code: null, series: null, is_active: true }] }),
}));
vi.mock('../../vendor/scm/lib/inventory-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/inventory-queries')>()),
  useWarehouses: () => ({ data: [{ id: 'wh-kl', code: 'KL', name: 'KL Showroom', location: null }] }),
}));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 31 }, can: () => true }) }));
const confirmFn = vi.fn(async (_o: unknown) => true);
const promptFn = vi.fn(async (_o: unknown) => 'We have 5530 in that fabric' as string | null);
vi.mock('../../vendor/scm/components/ConfirmDialog', () => ({ useConfirm: () => confirmFn, usePrompt: () => promptFn }));
vi.mock('../../vendor/scm/components/NotifyDialog', () => ({ useNotify: () => vi.fn() }));

import { ProductRequests } from './ProductRequests';

const draw = () => render(
  <MemoryRouter initialEntries={['/scm/product-requests']}>
    <Routes>
      <Route path="/scm/product-requests" element={<ProductRequests />} />
      <Route path="/scm/purchase-consignment-orders/new" element={<div>PC Order New opened</div>} />
    </Routes>
  </MemoryRouter>,
);
const openDetail = (no: string) => fireEvent.click(screen.getByRole('button', { name: no }));

describe('Product Requests — the requester', () => {
  test('raises a two-line request — a new Model and an existing SKU — with the fields the server reads', async () => {
    requests = []; approver = false; createAsync.mockClear();
    draw();
    fireEvent.click(screen.getByRole('button', { name: /New request/ }));
    const dialog = screen.getByRole('dialog', { name: 'New product request' });
    fireEvent.change(within(dialog).getByLabelText('Application'), { target: { value: 'SAMPLE' } });
    /* Line 1: a Model the catalogue has not got. */
    fireEvent.change(within(dialog).getByLabelText('Product kind line 1'), { target: { value: 'new' } });
    fireEvent.change(within(dialog).getByLabelText('New Model name line 1'), { target: { value: 'Aurora 2-seater' } });
    fireEvent.change(within(dialog).getByLabelText('Fabric line 1'), { target: { value: 'LIN-01' } });
    fireEvent.change(within(dialog).getByLabelText('Sofa size line 1'), { target: { value: '22' } });
    fireEvent.change(within(dialog).getByLabelText('Leg size line 1'), { target: { value: '4' } });
    fireEvent.change(within(dialog).getByLabelText('Remarks line 1'), { target: { value: 'Deeper seat' } });
    /* Line 2: an existing SKU, three of them. */
    fireEvent.click(within(dialog).getByRole('button', { name: /Add line/ }));
    fireEvent.change(within(dialog).getByLabelText('SKU line 2'), { target: { value: '5530-3S' } });
    fireEvent.change(within(dialog).getByLabelText('Qty line 2'), { target: { value: '3' } });
    /* A third line, then removed: it must not be sent. */
    fireEvent.click(within(dialog).getByRole('button', { name: /Add line/ }));
    expect(within(dialog).getByLabelText('SKU line 3')).toBeTruthy();
    fireEvent.click(within(dialog).getByLabelText('Remove line 3'));
    expect(within(dialog).queryByLabelText('SKU line 3')).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('Delivery location'), { target: { value: 'wh-kl' } });
    fireEvent.change(within(dialog).getByLabelText('Special remarks'), { target: { value: 'For the corner' } });
    /* 方案 C: the supplier the requester agreed with rides the request. */
    fireEvent.change(within(dialog).getByLabelText('Supplier'), { target: { value: 'sup-1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send to the Purchaser' }));
    await waitFor(() => expect(createAsync).toHaveBeenCalledTimes(1));
    expect(createAsync.mock.calls[0][0]).toMatchObject({
      requestType: 'NEW_PRODUCT', application: 'SAMPLE', specialRemarks: 'For the corner', deliveryLocationId: 'wh-kl', supplierId: 'sup-1',
      lines: [
        { itemCode: null, proposedModelName: 'Aurora 2-seater', category: 'SOFA', compartment: null, fabricCode: 'LIN-01', seatSize: '22', legSize: '4', qty: 1, unitPriceSen: null, remarks: 'Deeper seat' },
        { itemCode: '5530-3S', proposedModelName: null, category: 'SOFA', qty: 3 },
      ],
    });
    expect((createAsync.mock.calls[0][0] as { lines: unknown[] }).lines).toHaveLength(2);
  });

  test('a repack names existing SKUs — the SKU picker is the only product field on a line', async () => {
    requests = []; approver = false; createAsync.mockClear();
    draw();
    fireEvent.click(screen.getByRole('button', { name: /New request/ }));
    const dialog = screen.getByRole('dialog', { name: 'New product request' });
    fireEvent.click(within(dialog).getByLabelText('Repack'));
    expect(within(dialog).queryByLabelText('Product kind line 1')).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('SKU line 1'), { target: { value: '5530-3S' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send to the Purchaser' }));
    await waitFor(() => expect(createAsync).toHaveBeenCalledTimes(1));
    expect(createAsync.mock.calls[0][0]).toMatchObject({ requestType: 'REPACK', lines: [{ itemCode: '5530-3S', proposedModelName: null, category: 'SOFA' }] });
  });

  test('edits and withdraws their own waiting request; a rejected one shows the note and resends', async () => {
    requests = [base({}), base({ id: 'r2', request_no: 'HC-PDR-2610-002', status: 'REJECTED', decision_note: 'Pick 5530 instead', decided_by: 'Chong' })];
    approver = false; withdrawMutate.mockClear(); updateAsync.mockClear();
    draw();
    openDetail('HC-PDR-2610-001');
    const dialog = screen.getByRole('dialog', { name: 'Product request HC-PDR-2610-001' });
    expect(within(dialog).getByText('Requested')).toBeTruthy();
    expect(within(dialog).getAllByText('Aurora (new)', { exact: false }).length).toBeGreaterThan(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(withdrawMutate).toHaveBeenCalledWith('r1'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit' }));
    const edit = screen.getByRole('dialog', { name: 'Edit HC-PDR-2610-001' });
    /* The stored line comes back as line 1, editable. */
    expect((within(edit).getByLabelText('New Model name line 1') as HTMLInputElement).value).toBe('Aurora');
    fireEvent.change(within(edit).getByLabelText('Qty line 1'), { target: { value: '3' } });
    fireEvent.click(within(edit).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateAsync).toHaveBeenCalledTimes(1));
    expect(updateAsync.mock.calls[0][0]).toMatchObject({ id: 'r1', lines: [{ proposedModelName: 'Aurora', qty: 3 }] });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    openDetail('HC-PDR-2610-002');
    const rejected = screen.getByRole('dialog', { name: 'Product request HC-PDR-2610-002' });
    expect(within(rejected).getByText(/Rejected by Chong/)).toBeTruthy();
    expect(within(rejected).getByText(/Pick 5530 instead/)).toBeTruthy();
    expect(within(rejected).getByRole('button', { name: 'Fix and send again' })).toBeTruthy();
    expect(within(rejected).queryByRole('button', { name: 'Approve' })).toBeNull();
  });
});

describe('Product Requests — files (owner 2026-10-15)', () => {
  test('the detail shows the files card; the requester attaches while it waits and sees a decided request keep its files', async () => {
    files = [{ id: 'f1', file_name: 'quotation.pdf', mime: 'application/pdf', size_bytes: 20480, sort_no: 1, created_at: '2026-10-15T01:00:00Z' }];
    requests = [base({}), base({ id: 'r3', request_no: 'HC-PDR-2610-003', status: 'APPROVED' })];
    approver = false; uploadAsync.mockClear();
    draw();
    openDetail('HC-PDR-2610-001');
    let dialog = screen.getByRole('dialog', { name: 'Product request HC-PDR-2610-001' });
    expect(within(dialog).getByText('quotation.pdf')).toBeTruthy();
    expect(within(dialog).getByLabelText('Attach a file')).toBeTruthy();
    expect(within(dialog).getByLabelText('Remove quotation.pdf')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    /* Approved: the requester may still attach, but the files stay. */
    openDetail('HC-PDR-2610-003');
    dialog = screen.getByRole('dialog', { name: 'Product request HC-PDR-2610-003' });
    expect(within(dialog).getByLabelText('Attach a file')).toBeTruthy();
    expect(within(dialog).queryByLabelText('Remove quotation.pdf')).toBeNull();
  });

  test('files picked on the new-request form are uploaded once the request exists', async () => {
    requests = []; approver = false; createAsync.mockClear(); uploadAsync.mockClear();
    draw();
    fireEvent.click(screen.getByRole('button', { name: /New request/ }));
    const dialog = screen.getByRole('dialog', { name: 'New product request' });
    fireEvent.change(within(dialog).getByLabelText('SKU line 1'), { target: { value: '5530-3S' } });
    const picker = within(dialog).getByLabelText('Pick files to attach') as HTMLInputElement;
    const quote = new File(['%PDF-1.4 q'], 'quotation.pdf', { type: 'application/pdf' });
    /* A real browser empties `files` the moment `value` is reset to '' — the
       handler must read the list BEFORE resetting (owner 2026-10-15: 选了 PDF 之后是空的). */
    let served: File[] = [quote];
    Object.defineProperty(picker, 'files', { configurable: true, get: () => served });
    Object.defineProperty(picker, 'value', { configurable: true, get: () => '', set: (v: string) => { if (v === '') served = []; } });
    fireEvent.change(picker);
    expect(within(dialog).getByText('quotation.pdf')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send to the Purchaser' }));
    await waitFor(() => expect(uploadAsync).toHaveBeenCalledTimes(1));
    expect(uploadAsync.mock.calls[0][0]).toMatchObject({ id: 'r-new', file: { name: 'quotation.pdf', mime: 'application/pdf' } });
  });
});

describe('Product Requests — the Purchaser', () => {
  test('approves, rejects with a note, builds the Model + SKU per line, then is sent to PC Order New once every line has a SKU', async () => {
    requests = [
      base({ id: 'r1', requested_by: 99 }),
      /* Approved, two lines: one new Model still to build, one existing SKU. */
      base({ id: 'r3', request_no: 'HC-PDR-2610-003', requested_by: 99, status: 'APPROVED', lines: [line({}), line({ id: 'l2', line_no: 2, item_code: '5530-3S', proposed_model_name: null, qty: 3 })] }),
      base({ id: 'r4', request_no: 'HC-PDR-2610-004', requested_by: 99, status: 'APPROVED', lines: [line({ item_code: 'AURORA-2S', proposed_model_name: null })] }),
    ];
    approver = true; approveMutate.mockClear(); rejectMutate.mockClear(); buildAsync.mockClear(); promptFn.mockClear();
    draw();
    expect(screen.getAllByText('Amy Tan').length).toBeGreaterThan(0);
    openDetail('HC-PDR-2610-001');
    let dialog = screen.getByRole('dialog', { name: 'Product request HC-PDR-2610-001' });
    /* Another person's request: the Purchaser decides, never edits or withdraws. */
    expect(within(dialog).queryByRole('button', { name: 'Withdraw' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(approveMutate).toHaveBeenCalledTimes(1));
    expect(approveMutate.mock.calls[0][0]).toMatchObject({ id: 'r1' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject…' }));
    await waitFor(() => expect(rejectMutate).toHaveBeenCalledWith({ id: 'r1', note: 'We have 5530 in that fabric' }));
    expect((promptFn.mock.calls[0][0] as { input: { required: boolean } }).input.required).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    /* Approved but line 1 has no SKU yet: build it on that line, not an order. */
    openDetail('HC-PDR-2610-003');
    dialog = screen.getByRole('dialog', { name: 'Product request HC-PDR-2610-003' });
    expect(within(dialog).queryByRole('button', { name: 'Raise PC Order' })).toBeNull();
    const buildButtons = within(dialog).getAllByRole('button', { name: 'Create Model + SKU' });
    expect(buildButtons).toHaveLength(1);
    fireEvent.click(buildButtons[0]);
    const build = screen.getByRole('dialog', { name: 'Create Model and SKU' });
    fireEvent.change(within(build).getByLabelText('Model code'), { target: { value: 'aurora' } });
    fireEvent.click(within(build).getByRole('button', { name: 'Create Model + SKU' }));
    await waitFor(() => expect(buildAsync).toHaveBeenCalledTimes(1));
    expect(buildAsync.mock.calls[0][0]).toMatchObject({ id: 'r3', lineId: 'l1', modelCode: 'AURORA', skuCode: null, name: 'Aurora' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    /* Every line has its SKU: the order is raised on PC Order New, from the request. */
    openDetail('HC-PDR-2610-004');
    dialog = screen.getByRole('dialog', { name: 'Product request HC-PDR-2610-004' });
    expect(within(dialog).queryByRole('button', { name: 'Create Model + SKU' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Raise PC Order' }));
    expect(await screen.findByText('PC Order New opened')).toBeTruthy();
  });

  test('a built line links its SKU code to the new catalogue Model; an unbuilt line stays plain text', () => {
    requests = [base({ id: 'r1', request_no: 'HC-PDR-2610-001', status: 'APPROVED', lines: [
      line({ id: 'l1', line_no: 1, item_code: 'AURORA-2S', proposed_model_name: 'Aurora', model_id: 'm1', model: { id: 'm1', modelCode: 'AURORA', name: 'Aurora' } }),
      line({ id: 'l2', line_no: 2, item_code: null, proposed_model_name: 'Nimbus', model: null }),
    ] })];
    approver = true;
    draw();
    openDetail('HC-PDR-2610-001');
    const dialog = screen.getByRole('dialog', { name: 'Product request HC-PDR-2610-001' });
    /* The built line's code is a link straight to the Model it created. */
    const link = within(dialog).getByRole('link', { name: 'AURORA-2S' });
    expect(link.getAttribute('href')).toBe('/scm/product-models/m1');
    /* The line still to be built shows its name as plain text, not a link. */
    expect(within(dialog).queryByRole('link', { name: 'Nimbus (new)' })).toBeNull();
    expect(within(dialog).getAllByText('Nimbus (new)', { exact: false }).length).toBeGreaterThan(0);
  });
});
