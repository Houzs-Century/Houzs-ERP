/* The client half of the cancellation approval (owner 2026-09-08): the
 * display rules every screen shares, and the hooks' wire shape — which path,
 * which method, which caches drop. Nothing here cancels a document; that is
 * the property the module header promises and the last test pins. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => ({}) as unknown);
vi.mock('./authed-fetch', () => ({ authedFetch: (p: string, i?: RequestInit) => fetchMock(p, i) }));

const {
  CANCEL_APPROVE_KEY, cancelRequestLine, pendingLevel, signaturesGiven, isOpenCancelStatus,
  viewerCanApprove, viewerCanReject, viewerCanWithdraw,
  useCancelRequest, useCancelRequests, useRaiseCancelRequest, useApproveCancelRequest,
  useRejectCancelRequest, useWithdrawCancelRequest,
} = await import('./document-cancel-queries');
type Row = import('./document-cancel-queries').CancelRequestRow;

const row = (over: Partial<Row> = {}): Row => ({
  id: 'r1', company_id: 1, doc_type: 'SO', doc_key: 'SO-1', doc_number: 'SO-1', doc_status_at_request: 'CONFIRMED',
  status: 'REQUESTED', reason: 'Customer cancelled', requested_by: 11, requested_by_name: 'Amy', requested_at: '2026-09-08T01:00:00Z',
  l1_by: null, l1_by_name: null, l1_at: null, l2_by: null, l2_by_name: null, l2_at: null,
  rejected_by: null, rejected_by_name: null, rejected_at: null, reject_reason: null, executed_by: null, executed_at: null,
  ...over,
});

const viewer = (userId: number, perms: string[]) => ({ userId, can: (p: string) => perms.includes('*') || perms.includes(p) });

describe('display rules', () => {
  it('says which signature is next and how many are on it', () => {
    expect(pendingLevel('REQUESTED')).toBe(1);
    expect(pendingLevel('L1_APPROVED')).toBe(2);
    expect(pendingLevel('APPROVED')).toBeNull();
    expect(signaturesGiven('L1_APPROVED')).toBe(1);
    expect(signaturesGiven('EXECUTED')).toBe(2);
    expect(cancelRequestLine(row())).toBe('Waiting for level-1 approval (0 of 2)');
    expect(cancelRequestLine(row({ status: 'L1_APPROVED' }))).toBe('Waiting for level-2 approval (1 of 2)');
    expect(cancelRequestLine(row({ status: 'APPROVED' }))).toContain('2 of 2');
    expect(cancelRequestLine(row({ status: 'EXECUTED' }))).toBe('Cancelled');
    expect(isOpenCancelStatus('WITHDRAWN')).toBe(false);
  });

  it('shows Approve only to the right desk, never to the requester or the same signer twice', () => {
    expect(viewerCanApprove(row(), viewer(21, [CANCEL_APPROVE_KEY.so[1]]))).toBe(true);
    expect(viewerCanApprove(row(), viewer(21, [CANCEL_APPROVE_KEY.so[2]]))).toBe(false);
    expect(viewerCanApprove(row(), viewer(11, ['*']))).toBe(false);
    const l1Done = row({ status: 'L1_APPROVED', l1_by: 21 });
    expect(viewerCanApprove(l1Done, viewer(21, ['*']))).toBe(false);
    expect(viewerCanApprove(l1Done, viewer(31, ['*']))).toBe(true);
    expect(viewerCanApprove(row({ doc_type: 'PO' }), viewer(21, [CANCEL_APPROVE_KEY.so[1]]))).toBe(false);
    expect(viewerCanApprove(row({ status: 'APPROVED' }), viewer(31, ['*']))).toBe(false);
  });

  it('Reject for either desk while pending; Withdraw for the requester or a desk while open', () => {
    expect(viewerCanReject(row(), viewer(31, [CANCEL_APPROVE_KEY.so[2]]))).toBe(true);
    expect(viewerCanReject(row(), viewer(51, []))).toBe(false);
    expect(viewerCanReject(row({ status: 'APPROVED' }), viewer(31, ['*']))).toBe(false);
    expect(viewerCanWithdraw(row(), viewer(11, []))).toBe(true);
    expect(viewerCanWithdraw(row({ status: 'APPROVED' }), viewer(11, []))).toBe(true);
    expect(viewerCanWithdraw(row(), viewer(51, []))).toBe(false);
    expect(viewerCanWithdraw(row({ status: 'EXECUTED' }), viewer(11, []))).toBe(false);
  });
});

describe('the hooks', () => {
  let qc: QueryClient;
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ open: null, history: [], needsApproval: true });
  });

  it('reads the document\'s request and the inbox from their paths', async () => {
    const r = renderHook(() => useCancelRequest('so', 'SO 1'), { wrapper });
    await waitFor(() => expect(r.result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith('/mfg-sales-orders/SO%201/cancel-request', undefined);
    const inbox = renderHook(() => useCancelRequests('all'), { wrapper });
    await waitFor(() => expect(inbox.result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith('/cancel-requests?scope=all', undefined);
    expect(renderHook(() => useCancelRequest('po', null), { wrapper }).result.current.fetchStatus).toBe('idle');
  });

  it('writes the four verbs to the PO paths and drops the document + inbox caches', async () => {
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const raise = renderHook(() => useRaiseCancelRequest('po'), { wrapper });
    await raise.result.current.mutateAsync({ key: 'po-1', reason: 'Supplier cannot deliver' });
    expect(fetchMock).toHaveBeenLastCalledWith('/mfg-purchase-orders/po-1/cancel-request', { method: 'POST', body: JSON.stringify({ reason: 'Supplier cannot deliver' }) });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['document-cancel-request', 'po', 'po-1'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['document-cancel-requests'] });

    await renderHook(() => useApproveCancelRequest('po'), { wrapper }).result.current.mutateAsync({ key: 'po-1' });
    expect(fetchMock).toHaveBeenLastCalledWith('/mfg-purchase-orders/po-1/cancel-request/approve', { method: 'POST' });
    await renderHook(() => useRejectCancelRequest('po'), { wrapper }).result.current.mutateAsync({ key: 'po-1', reason: 'Already received' });
    expect(fetchMock).toHaveBeenLastCalledWith('/mfg-purchase-orders/po-1/cancel-request/reject', { method: 'POST', body: JSON.stringify({ reason: 'Already received' }) });
    await renderHook(() => useWithdrawCancelRequest('po'), { wrapper }).result.current.mutateAsync({ key: 'po-1' });
    expect(fetchMock).toHaveBeenLastCalledWith('/mfg-purchase-orders/po-1/cancel-request/withdraw', { method: 'POST' });
  });

  it('never sends a status — nothing in this module cancels a document', async () => {
    await renderHook(() => useApproveCancelRequest('so'), { wrapper }).result.current.mutateAsync({ key: 'SO-1' });
    for (const [path, init] of fetchMock.mock.calls) {
      expect(path).not.toMatch(/\/status$|\/cancel$/);
      expect(String(init?.body ?? '')).not.toMatch(/CANCELLED/i);
    }
  });
});
