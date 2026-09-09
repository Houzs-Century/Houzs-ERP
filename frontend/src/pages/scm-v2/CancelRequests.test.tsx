/* The cancellation-request inbox (owner 2026-09-08): one queue for both
 * documents, the approver's actions on the row, and the level-2 approve
 * running the document's OWN cancel afterwards. */
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
const ROWS: Row[] = [
  base({ id: 'r1' }),
  /* A Purchase Order takes ONE signature, so a fresh request is already at its final level. */
  base({ id: 'r2', doc_type: 'PO', doc_key: 'po-7', doc_number: 'PO-7', reason: 'Supplier cannot deliver', status: 'REQUESTED', requested_by: 12, requested_by_name: 'Dee' }),
];

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
  approveSo.mockClear(); approvePo.mockClear(); cancelSo.mockClear(); cancelPo.mockClear(); confirm.mockClear(); notify.mockClear();
  try { window.localStorage.clear(); } catch { /* jsdom without storage */ }
});

describe('CancelRequests', () => {
  it('lists both documents with their state and the requester', async () => {
    mount();
    expect(await screen.findByText('SO-1')).toBeTruthy();
    expect(screen.getByText('PO-7')).toBeTruthy();
    expect(screen.getByText('Waiting for level-1 approval (0 of 2)')).toBeTruthy();
    expect(screen.getByText('Waiting for approval (0 of 1)')).toBeTruthy();
    expect(screen.getByText('Amy')).toBeTruthy();
    expect(screen.getByText(/2 open requests/)).toBeTruthy();
  });

  it('a wildcard holder sees Approve (level 1) on the SO and Approve & cancel on the PO', async () => {
    mount();
    expect(await screen.findByText('Approve (level 1)')).toBeTruthy();
    expect(screen.getByText('Approve & cancel')).toBeTruthy();
  });

  it('the PO\'s single approval runs the PO\'s own cancel afterwards', async () => {
    mount();
    fireEvent.click(await screen.findByText('Approve & cancel'));
    await waitFor(() => expect(approvePo).toHaveBeenCalledWith({ key: 'po-7' }));
    await waitFor(() => expect(cancelPo).toHaveBeenCalledWith('po-7'));
    expect(cancelSo).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Purchase Order PO-7 cancelled' }));
  });

  it('the person who raised PO-7 cannot sign it, wildcard or not', async () => {
    viewer = { id: 12, perms: ['*'] };
    mount();
    expect(await screen.findByText('Approve (level 1)')).toBeTruthy();
    expect(screen.queryByText('Approve & cancel')).toBeNull();
  });
});
