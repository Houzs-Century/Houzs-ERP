/* The phone's refund approvals (owner 2026-11-27: 「只要一级，但这一级的权限和
 * cancel 的第二级一样」) on the Amendments screen: shown only while one waits
 * for a viewer who may approve; the card opens its order; Approve and Reject
 * run the desktop's own flow, then refresh the badges. */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type PR = import('../vendor/scm/lib/payment-request-queries').PaymentRequest;

const req = (over: Partial<PR>): PR => ({
  id: 'q1', request_no: 'PRQ-1', requested_by: 31, requested_by_name: 'Sales A', payee_name: 'Customer A', amount_sen: 40_000,
  due_date: null, purpose: 'Customer cancelled', project_id: null, bank_name: 'Bank A', bank_account_no: '123456', bank_account_name: 'CUSTOMER A',
  status: 'SUBMITTED', pv_id: null, finance_note: null, decided_by: null, decided_at: null,
  created_at: '2026-11-20T02:00:00Z', updated_at: '2026-11-20T02:00:00Z', stage: 'AWAITING_APPROVAL', voucher: null,
  refund_source_type: 'SO', refund_source_doc_no: 'SO-A', refund_approved_by_name: null, refund_approved_at: null,
  ...over,
});

let DATA: { requests: PR[]; mayApprove: boolean; me: number | null } | undefined;
const approve = vi.fn(async (_id: string) => ({ ok: true }));
const sendBack = vi.fn(async (_v: { id: string; note: string }) => ({ ok: true }));
const confirm = vi.fn(async (_o: unknown) => true);

vi.mock('../vendor/scm/lib/payment-request-queries', async (orig) => ({
  ...(await orig<typeof import('../vendor/scm/lib/payment-request-queries')>()),
  useRefundApprovals: () => ({ data: DATA, isLoading: false, isError: false, error: null }),
  useApproveRefundRequest: () => ({ mutateAsync: approve, isPending: false }),
  useReturnPaymentRequest: () => ({ mutateAsync: sendBack, isPending: false }),
}));
vi.mock('../vendor/scm/components/ConfirmDialog', () => ({ useConfirm: () => confirm, usePrompt: () => async () => '' }));
vi.mock('../vendor/scm/components/PromptDialog', () => ({ usePrompt: () => async () => 'The customer keeps the order' }));

const { MobileRefundApprovals } = await import('./MobileRefundApprovals');

const open = vi.fn();
const changed = vi.fn();
const mount = () => render(<MobileRefundApprovals onOpen={open} onChanged={changed} />);

beforeEach(() => {
  DATA = { requests: [req({})], mayApprove: true, me: 41 };
  approve.mockClear(); sendBack.mockClear(); confirm.mockClear(); open.mockClear(); changed.mockClear();
});

describe('MobileRefundApprovals', () => {
  it('shows nothing while nothing waits, or to a viewer who may not approve', () => {
    DATA = { requests: [], mayApprove: true, me: 41 };
    const first = mount();
    expect(screen.queryByText(/Refunds waiting approval/)).toBeNull();
    first.unmount();
    DATA = { requests: [req({})], mayApprove: false, me: 41 };
    mount();
    expect(screen.queryByText(/Refunds waiting approval/)).toBeNull();
  });

  it('a card per refund: the order opens on a tap; Approve signs it and refreshes the badges', async () => {
    mount();
    expect(screen.getByText('Refunds waiting approval · 1')).toBeTruthy();
    expect(screen.getByText('Refund RM 400.00')).toBeTruthy();
    fireEvent.click(screen.getByText('SO-A'));
    expect(open).toHaveBeenCalledWith('SO-A');
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(approve).toHaveBeenCalledWith('q1'));
    expect(changed).toHaveBeenCalled();
  });

  it('Reject sends the reason; the requester\'s own card has no buttons', async () => {
    const first = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(sendBack).toHaveBeenCalledWith({ id: 'q1', note: 'The customer keeps the order' }));
    first.unmount();
    DATA = { requests: [req({ requested_by: 41 })], mayApprove: true, me: 41 };
    mount();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByText('Your request — someone else approves it')).toBeTruthy();
  });
});
