/* The cancellation-request inbox (owner 2026-09-08): one queue for both
 * documents, the approver's actions on the row, and the level-2 approve running
 * the document's OWN cancel afterwards.
 *
 * Since 2026-09-09 a PURCHASE ORDER raises no request — it is cancelled on its
 * reason alone — so the only PO rows here are the EXECUTED record of a
 * cancellation that has already run, with nothing to approve. The one PO row
 * that can still be pending is a legacy one raised before that ruling; it is
 * kept as a fixture because the inbox must still be able to finish it. */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = import('../../vendor/scm/lib/document-cancel-queries').CancelRequestRow;

const base = (over: Partial<Row>): Row => ({
  id: 'r', company_id: 1, doc_type: 'SO', doc_key: 'SO-1', doc_number: 'SO-1', doc_status_at_request: 'CONFIRMED',
  status: 'REQUESTED', reason: 'Customer cancelled', requested_by: 11, requested_by_name: 'Amy', requested_at: '2026-09-08T01:00:00Z',
  l1_by: null, l1_by_name: null, l1_at: null, l2_by: null, l2_by_name: null, l2_at: null,
  rejected_by: null, rejected_by_name: null, rejected_at: null, reject_reason: null, executed_by: null, executed_at: null,
  ...over,
});
const freshRows = (): Row[] => [
  base({ id: 'r1' }),
  /* The record of a PO cancelled on its reason: no signature, already done. */
  base({ id: 'r2', doc_type: 'PO', doc_key: 'po-7', doc_number: 'PO-7', reason: 'Supplier cannot deliver', status: 'EXECUTED', requested_by: 12, requested_by_name: 'Dee', executed_by: 12, executed_at: '2026-09-09T02:00:00Z' }),
];
let ROWS: Row[] = freshRows();

let viewer = { id: 31, perms: ['*'] };
const approveSo = vi.fn(async (_v: unknown) => ({ request: {}, execute: false }));
const approvePo = vi.fn(async (_v: unknown) => ({ request: {}, execute: true }));
const cancelSo = vi.fn(async (_v: unknown) => ({}));
const cancelPo = vi.fn(async (_v: unknown) => ({}));
const confirm = vi.fn(async (_o: unknown) => true);
const notify = vi.fn(async (_o: unknown) => undefined);

vi.mock('../../vendor/scm/lib/document-cancel-queries', async (orig) => ({
  ...(await orig<typeof import('../../vendor/scm/lib/document-cancel-queries')>()),
  useCancelRequests: () => ({ data: { requests: ROWS }, isLoading: false, isError: false, error: null }),
  useApproveCancelRequest: (t: string) => ({ mutateAsync: t === 'so' ? approveSo : approvePo }),
  useRejectCancelRequest: () => ({ mutateAsync: vi.fn() }),
  useWithdrawCancelRequest: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('../../vendor/scm/lib/sales-order-queries', () => ({ useUpdateMfgSalesOrderStatus: () => ({ mutateAsync: cancelSo }) }));
vi.mock('../../vendor/scm/lib/suppliers-queries', () => ({ useCancelPurchaseOrder: () => ({ mutateAsync: cancelPo }) }));
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: viewer.id }, can: (p: string) => viewer.perms.includes('*') || viewer.perms.includes(p) }),
}));
vi.mock('../../vendor/scm/components/ConfirmDialog', () => ({ useConfirm: () => confirm }));
vi.mock('../../vendor/scm/components/PromptDialog', () => ({ usePrompt: () => vi.fn(async () => null) }));
vi.mock('../../vendor/scm/lib/dialog-service', () => ({ serviceNotify: (o: unknown) => notify(o) }));

const { CancelRequests } = await import('./CancelRequests');

const mount = () => render(<MemoryRouter initialEntries={['/scm/cancel-requests']}><CancelRequests /></MemoryRouter>);

beforeEach(() => {
  viewer = { id: 31, perms: ['*'] };
  ROWS = freshRows();
  approveSo.mockClear(); approvePo.mockClear(); cancelSo.mockClear(); cancelPo.mockClear(); confirm.mockClear(); notify.mockClear();
  try { window.localStorage.clear(); } catch { /* jsdom without storage */ }
});

describe('CancelRequests', () => {
  it('lists both documents with their state and the requester', async () => {
    mount();
    expect(await screen.findByText('SO-1')).toBeTruthy();
    expect(screen.getByText('PO-7')).toBeTruthy();
    expect(screen.getByText('Waiting for level-1 approval (0 of 2)')).toBeTruthy();
    expect(screen.getByText('Cancelled')).toBeTruthy();
    expect(screen.getByText('Amy')).toBeTruthy();
  });

  it('offers no signature on a purchase order, wildcard or not', async () => {
    mount();
    expect(await screen.findByText('Approve (level 1)')).toBeTruthy();
    expect(screen.queryByText('Approve & cancel')).toBeNull();
  });

  it('a legacy APPROVED purchase-order request still cancels — with its OWN reason', async () => {
    ROWS[1] = base({
      id: 'r2', doc_type: 'PO', doc_key: 'po-7', doc_number: 'PO-7', reason: 'Supplier cannot deliver',
      status: 'APPROVED', requested_by: 12, requested_by_name: 'Dee', l1_by: 21, l1_by_name: 'Ben',
    });
    mount();
    fireEvent.click(await screen.findByText('Cancel now'));
    await waitFor(() => expect(cancelPo).toHaveBeenCalledWith({ id: 'po-7', reason: 'Supplier cannot deliver' }));
    expect(cancelSo).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Purchase Order PO-7 cancelled' }));
  });

  it('the person who raised the SO request cannot sign it, wildcard or not', async () => {
    viewer = { id: 11, perms: ['*'] };
    mount();
    expect(await screen.findByText('SO-1')).toBeTruthy();
    expect(screen.queryByText('Approve (level 1)')).toBeNull();
  });
});
