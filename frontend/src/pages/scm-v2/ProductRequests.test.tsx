/* Product request (owner 2026-10-06) — the Product Requests page. Pinned:
     • a salesperson raises a request — new product or repack, existing SKU or a
       new Model by name, fabric / seat / leg, qty, where and when — and it is sent
       with the fields the server reads;
     • a repack is always an existing SKU; a new product may name a new Model;
     • the requester edits or withdraws their own waiting request; a rejected one
       shows the Purchaser's note and goes back with "Fix and send again";
     • the Purchaser approves, rejects with a note it must give, builds the Model
       + SKU for a new-Model request, and is sent to PC Order New
       (?fromProductRequest=) to raise the order once the SKU exists. */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';

type Req = Record<string, unknown>;
const base = (over: Req): Req => ({
  id: 'r1', request_no: 'HC-PDR-2610-001', request_type: 'NEW_PRODUCT', application: 'SHOWROOM', requested_by: 31, requested_by_name: 'Amy Tan',
  item_code: null, proposed_model_name: 'Aurora', model_id: null, category: 'SOFA', compartment: '2S', fabric_code: 'LIN-01', seat_size: '22', leg_size: '4',
  qty: 2, special_remarks: 'Deeper seat', delivery_location_id: 'wh-kl', expected_delivery_date: '2026-10-25', status: 'REQUESTED',
  decision_note: null, decided_by: null, decided_at: null, pco_id: null, created_at: '2026-10-06T02:00:00Z', updated_at: '2026-10-06T02:00:00Z',
  pco: null, deliveryLocation: { id: 'wh-kl', code: 'KL', name: 'KL Showroom' }, model: null,
  ...over,
});
let requests: Req[] = [];
let approver = false;
const createAsync = vi.fn(async (_b: Req) => ({ ok: true, request: base({ id: 'r-new' }) }));
const updateAsync = vi.fn(async (_b: Req) => ({ ok: true, request: base({}) }));
const withdrawMutate = vi.fn();
const approveMutate = vi.fn();
const rejectMutate = vi.fn();
const buildAsync = vi.fn(async (_b: Req) => ({ ok: true, model: { id: 'm1', modelCode: 'AURORA', created: true }, sku: { id: 's1', code: 'AURORA-2S' }, request: base({ item_code: 'AURORA-2S', status: 'APPROVED' }) }));
const closeMutate = vi.fn();

vi.mock('../../vendor/scm/lib/product-request-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/product-request-queries')>()),
  useProductRequests: () => ({ data: { requests, approver, mayRequest: true }, isLoading: false, isError: false, error: null }),
  useProductRequest: (id: string | null) => ({ data: id ? { request: requests.find((r) => r.id === id), approver, mayRequest: true } : undefined, isLoading: false }),
  useCreateProductRequest: () => ({ mutateAsync: createAsync, isPending: false }),
  useUpdateProductRequest: () => ({ mutateAsync: updateAsync, isPending: false }),
  useWithdrawProductRequest: () => ({ mutate: withdrawMutate, isPending: false }),
  useApproveProductRequest: () => ({ mutate: approveMutate, isPending: false }),
  useRejectProductRequest: () => ({ mutate: rejectMutate, isPending: false }),
  useCreateModelFromRequest: () => ({ mutateAsync: buildAsync, isPending: false }),
  useCloseProductRequest: () => ({ mutate: closeMutate, isPending: false }),
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
  test('raises a new-Model request with the fields the server reads', async () => {
    requests = []; approver = false; createAsync.mockClear();
    draw();
    fireEvent.click(screen.getByRole('button', { name: /New request/ }));
    const dialog = screen.getByRole('dialog', { name: 'New product request' });
    fireEvent.click(within(dialog).getByLabelText('New Model'));
    fireEvent.change(within(dialog).getByLabelText('New Model name'), { target: { value: 'Aurora 2-seater' } });
    fireEvent.change(within(dialog).getByLabelText('Compartment'), { target: { value: '2S' } });
    fireEvent.change(within(dialog).getByLabelText('Fabric'), { target: { value: 'LIN-01' } });
    fireEvent.change(within(dialog).getByLabelText('Sofa size (seat)'), { target: { value: '22' } });
    fireEvent.change(within(dialog).getByLabelText('Leg size'), { target: { value: '4' } });
    fireEvent.change(within(dialog).getByLabelText('Application'), { target: { value: 'SAMPLE' } });
    fireEvent.change(within(dialog).getByLabelText('Delivery location'), { target: { value: 'wh-kl' } });
    fireEvent.change(within(dialog).getByLabelText('Special remarks'), { target: { value: 'Deeper seat' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send to the Purchaser' }));
    await waitFor(() => expect(createAsync).toHaveBeenCalledTimes(1));
    expect(createAsync.mock.calls[0][0]).toMatchObject({
      requestType: 'NEW_PRODUCT', application: 'SAMPLE', itemCode: null, proposedModelName: 'Aurora 2-seater', category: 'SOFA',
      compartment: '2S', fabricCode: 'LIN-01', seatSize: '22', legSize: '4', qty: 1, specialRemarks: 'Deeper seat', deliveryLocationId: 'wh-kl',
    });
  });

  test('a repack names an existing SKU — the SKU picker is the only product field', async () => {
    requests = []; approver = false; createAsync.mockClear();
    draw();
    fireEvent.click(screen.getByRole('button', { name: /New request/ }));
    const dialog = screen.getByRole('dialog', { name: 'New product request' });
    fireEvent.click(within(dialog).getByLabelText('Repack'));
    expect(within(dialog).queryByLabelText('New Model')).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('SKU'), { target: { value: '5530-3S' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send to the Purchaser' }));
    await waitFor(() => expect(createAsync).toHaveBeenCalledTimes(1));
    expect(createAsync.mock.calls[0][0]).toMatchObject({ requestType: 'REPACK', itemCode: '5530-3S', proposedModelName: null, category: 'SOFA' });
  });

  test('edits and withdraws their own waiting request; a rejected one shows the note and resends', async () => {
    requests = [base({}), base({ id: 'r2', request_no: 'HC-PDR-2610-002', status: 'REJECTED', decision_note: 'Pick 5530 instead', decided_by: 'Chong' })];
    approver = false; withdrawMutate.mockClear(); updateAsync.mockClear();
    draw();
    openDetail('HC-PDR-2610-001');
    const dialog = screen.getByRole('dialog', { name: 'Product request HC-PDR-2610-001' });
    expect(within(dialog).getByText('Requested · 待审批')).toBeTruthy();
    expect(within(dialog).getAllByText('Aurora (new)', { exact: false }).length).toBeGreaterThan(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(withdrawMutate).toHaveBeenCalledWith('r1'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit' }));
    const edit = screen.getByRole('dialog', { name: 'Edit HC-PDR-2610-001' });
    fireEvent.change(within(edit).getByLabelText('Qty'), { target: { value: '3' } });
    fireEvent.click(within(edit).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateAsync).toHaveBeenCalledTimes(1));
    expect(updateAsync.mock.calls[0][0]).toMatchObject({ id: 'r1', qty: 3 });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    openDetail('HC-PDR-2610-002');
    const rejected = screen.getByRole('dialog', { name: 'Product request HC-PDR-2610-002' });
    expect(within(rejected).getByText(/Rejected by Chong/)).toBeTruthy();
    expect(within(rejected).getByText(/Pick 5530 instead/)).toBeTruthy();
    expect(within(rejected).getByRole('button', { name: 'Fix and send again' })).toBeTruthy();
    expect(within(rejected).queryByRole('button', { name: 'Approve' })).toBeNull();
  });
});

describe('Product Requests — the Purchaser', () => {
  test('approves, rejects with a note, builds the Model + SKU, then is sent to PC Order New', async () => {
    requests = [
      base({ id: 'r1', requested_by: 99 }),
      base({ id: 'r3', request_no: 'HC-PDR-2610-003', requested_by: 99, status: 'APPROVED' }),
      base({ id: 'r4', request_no: 'HC-PDR-2610-004', requested_by: 99, status: 'APPROVED', item_code: 'AURORA-2S', proposed_model_name: null }),
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

    /* Approved but no SKU yet: build it, not an order. */
    openDetail('HC-PDR-2610-003');
    dialog = screen.getByRole('dialog', { name: 'Product request HC-PDR-2610-003' });
    expect(within(dialog).queryByRole('button', { name: 'Raise PC Order' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Model + SKU' }));
    const build = screen.getByRole('dialog', { name: 'Create Model and SKU' });
    fireEvent.change(within(build).getByLabelText('Model code'), { target: { value: 'aurora' } });
    fireEvent.click(within(build).getByRole('button', { name: 'Create Model + SKU' }));
    await waitFor(() => expect(buildAsync).toHaveBeenCalledTimes(1));
    expect(buildAsync.mock.calls[0][0]).toMatchObject({ id: 'r3', modelCode: 'AURORA', skuCode: null, name: 'Aurora' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    /* Approved with its SKU: the order is raised on PC Order New, from the request. */
    openDetail('HC-PDR-2610-004');
    dialog = screen.getByRole('dialog', { name: 'Product request HC-PDR-2610-004' });
    expect(within(dialog).queryByRole('button', { name: 'Create Model + SKU' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Raise PC Order' }));
    expect(await screen.findByText('PC Order New opened')).toBeTruthy();
  });
});
