/* The card an open cancellation request shows on the document (owner
 * 2026-09-08): what it says, who sees which button, and that the second
 * signature runs the page's OWN cancel rather than one of its own. */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = import('../lib/document-cancel-queries').CancelRequestRow;
let open: Row | null = null;
let viewer = { id: 51, perms: [] as string[] };

const approveAsync = vi.fn(async (_v: unknown) => ({ request: {}, execute: false }));
const rejectAsync = vi.fn(async (_v: unknown) => ({ request: {} }));
const withdrawAsync = vi.fn(async (_v: unknown) => ({ request: {} }));
const confirm = vi.fn(async (_o: unknown) => true);
const prompt = vi.fn(async (_o: unknown): Promise<string | null> => 'Production has already started');
const notify = vi.fn(async (_o: unknown) => undefined);

vi.mock('../lib/document-cancel-queries', async (orig) => ({
  ...(await orig<typeof import('../lib/document-cancel-queries')>()),
  useCancelRequest: () => ({ data: { open, history: open ? [open] : [], needsApproval: true } }),
  useApproveCancelRequest: () => ({ mutateAsync: approveAsync, isPending: false }),
  useRejectCancelRequest: () => ({ mutateAsync: rejectAsync, isPending: false }),
  useWithdrawCancelRequest: () => ({ mutateAsync: withdrawAsync, isPending: false }),
}));
vi.mock('../../../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: viewer.id }, can: (p: string) => viewer.perms.includes('*') || viewer.perms.includes(p) }),
}));
vi.mock('./ConfirmDialog', () => ({ useConfirm: () => confirm }));
vi.mock('./PromptDialog', () => ({ usePrompt: () => prompt }));
vi.mock('../lib/dialog-service', () => ({ serviceNotify: (o: unknown) => notify(o) }));

const { CancelRequestPanel } = await import('./CancelRequestPanel');

const row = (over: Partial<Row> = {}): Row => ({
  id: 'r1', company_id: 1, doc_type: 'SO', doc_key: 'SO-1', doc_number: 'SO-1', doc_status_at_request: 'CONFIRMED',
  status: 'REQUESTED', reason: 'Customer cancelled the order', requested_by: 11, requested_by_name: 'Amy', requested_at: '2026-09-08T01:00:00Z',
  l1_by: null, l1_by_name: null, l1_at: null, l2_by: null, l2_by_name: null, l2_at: null,
  rejected_by: null, rejected_by_name: null, rejected_at: null, reject_reason: null, executed_by: null, executed_at: null,
  ...over,
});

const mount = (onExecute = vi.fn()) => {
  render(<CancelRequestPanel docType="so" docKey="SO-1" docNumber="SO-1" onExecute={onExecute} />);
  return onExecute;
};

beforeEach(() => {
  open = row();
  viewer = { id: 51, perms: [] };
  approveAsync.mockClear(); rejectAsync.mockClear(); withdrawAsync.mockClear(); confirm.mockClear(); prompt.mockClear(); notify.mockClear();
});

describe('CancelRequestPanel', () => {
  it('renders nothing when the document has no open request', () => {
    open = null;
    mount();
    expect(screen.queryByTestId('cancel-request-panel')).toBeNull();
  });

  it('says what is waiting, why, and who signed', () => {
    open = row({ status: 'L1_APPROVED', l1_by: 21, l1_by_name: 'Ben', l1_at: '2026-09-08T02:00:00Z' });
    mount();
    expect(screen.getByText('Cancellation requested')).toBeTruthy();
    expect(screen.getByText('Waiting for level-2 approval (1 of 2)')).toBeTruthy();
    expect(screen.getByText(/Customer cancelled the order/)).toBeTruthy();
    expect(screen.getByText(/Raised by Amy/)).toBeTruthy();
    expect(screen.getByText(/Level 1: Ben/)).toBeTruthy();
    expect(screen.getByText(/Level 2: pending/)).toBeTruthy();
    /* A bystander gets no buttons at all. */
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('level 1: the level-1 desk approves and is told level 2 is next', async () => {
    viewer = { id: 21, perms: ['scm.so_cancel.approve_l1'] };
    const onExecute = mount();
    fireEvent.click(screen.getByText('Approve (level 1)'));
    await waitFor(() => expect(approveAsync).toHaveBeenCalledWith({ key: 'SO-1' }));
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ confirmLabel: 'Approve (level 1)', danger: false }));
    expect(onExecute).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Level-1 approval recorded' }));
  });

  it('level 2: a DIFFERENT person approves and the page\'s own cancel runs', async () => {
    open = row({ status: 'L1_APPROVED', l1_by: 21, l1_by_name: 'Ben', l1_at: '2026-09-08T02:00:00Z' });
    approveAsync.mockResolvedValueOnce({ request: {}, execute: true });
    viewer = { id: 31, perms: ['*'] };
    const onExecute = mount();
    fireEvent.click(screen.getByText('Approve & cancel (level 2)'));
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ danger: true }));
  });

  it('the level-1 signer does not get the level-2 button, and the requester gets neither', () => {
    open = row({ status: 'L1_APPROVED', l1_by: 21, l1_by_name: 'Ben', l1_at: '2026-09-08T02:00:00Z' });
    viewer = { id: 21, perms: ['*'] };
    mount();
    expect(screen.queryByText(/Approve/)).toBeNull();
    expect(screen.getByText('Reject')).toBeTruthy();
  });

  it('the requester may withdraw; an approver may reject with a reason', async () => {
    viewer = { id: 11, perms: [] };
    mount();
    fireEvent.click(screen.getByText('Withdraw request'));
    await waitFor(() => expect(withdrawAsync).toHaveBeenCalledWith({ key: 'SO-1' }));
    expect(screen.queryByText('Reject')).toBeNull();
  });

  it('reject asks why and sends the reason', async () => {
    viewer = { id: 31, perms: ['scm.so_cancel.approve_l2'] };
    mount();
    fireEvent.click(screen.getByText('Reject'));
    await waitFor(() => expect(rejectAsync).toHaveBeenCalledWith({ key: 'SO-1', reason: 'Production has already started' }));
  });

  it('an APPROVED request offers Cancel now to retry the page\'s cancel', () => {
    open = row({ status: 'APPROVED', l1_by: 21, l2_by: 31 });
    const onExecute = mount();
    fireEvent.click(screen.getByText('Cancel now'));
    expect(onExecute).toHaveBeenCalledTimes(1);
  });

  it('a refused approve reaches the person', async () => {
    approveAsync.mockRejectedValueOnce(new Error('You raised this request — someone else has to approve it.'));
    viewer = { id: 21, perms: ['*'] };
    mount();
    fireEvent.click(screen.getByText('Approve (level 1)'));
    await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.objectContaining({ tone: 'error', title: 'Could not approve' })));
  });
});
