/* Owner 2026-09-24: 「当有 SO request cancel bill - 需要在 SO amendment 出现」.
 * A request to cancel a Sales Order now shows in the SO Amendment queue — on
 * the desktop grid and on the phone — with the approver's own buttons on the
 * row, so a signature does not cost a second screen.
 *
 * Rendered with the DATA hooks faked and the action flow REAL: what is asserted
 * is that the queue shows the request, that the buttons a person is shown match
 * what the server would let them do, and that pressing Approve as the final
 * signer signs the request AND runs the Sales Order's own cancel — the step a
 * second copy of this flow would be the one to forget. */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = import('../../vendor/scm/lib/document-cancel-queries').CancelRequestRow;
type Amd = import('../../vendor/scm/lib/so-amendment-queries').AmendmentRow;

const cancelRow = (over: Partial<Row> = {}): Row => ({
  id: 'c1', company_id: 1, doc_type: 'SO', doc_key: 'HC-SO-000002', doc_number: 'HC-SO-000002',
  doc_status_at_request: 'CONFIRMED', status: 'REQUESTED', reason: 'Customer no longer wants it',
  requested_by: 11, requested_by_name: 'Amy', requested_at: '2026-09-24T01:00:00Z',
  l1_by: null, l1_by_name: null, l1_at: null, l2_by: null, l2_by_name: null, l2_at: null,
  rejected_by: null, rejected_by_name: null, rejected_at: null, reject_reason: null,
  executed_by: null, executed_at: null,
  ...over,
});

const amendment = (over: Partial<Amd> = {}): Amd => ({
  id: 'a1', so_doc_no: 'HC-SO-000001', amendment_no: 3, status: 'REQUESTED',
  reason: 'Fabric change', requested_by: null, created_at: '2026-09-23T01:00:00Z',
  updated_at: null, lane: 'LINES', ...over,
} as Amd);

let CANCELS: Row[] = [];
let AMENDMENTS: Amd[] = [];
let viewer = { id: 31, perms: ['scm.so_cancel.approve_l1'] };

const approveSo = vi.fn(async (_v: unknown) => ({ request: {}, execute: false }));
const rejectSo = vi.fn(async (_v: unknown) => ({ request: {} }));
const withdrawSo = vi.fn(async (_v: unknown) => ({ request: {} }));
const cancelSo = vi.fn(async (_v: unknown) => ({}));
const confirm = vi.fn(async (_o: unknown) => true);
const refreshBadges = vi.fn();

vi.mock('../../vendor/scm/lib/so-amendment-queries', async (orig) => ({
  ...(await orig<typeof import('../../vendor/scm/lib/so-amendment-queries')>()),
  useAmendments: () => ({ data: { amendments: AMENDMENTS }, isLoading: false, error: null }),
}));
vi.mock('../../vendor/scm/lib/document-cancel-queries', async (orig) => ({
  ...(await orig<typeof import('../../vendor/scm/lib/document-cancel-queries')>()),
  useCancelRequests: () => ({ data: { requests: CANCELS }, isLoading: false, isError: false, error: null }),
  useApproveCancelRequest: () => ({ mutateAsync: approveSo }),
  useRejectCancelRequest: () => ({ mutateAsync: rejectSo }),
  useWithdrawCancelRequest: () => ({ mutateAsync: withdrawSo }),
}));
vi.mock('../../vendor/scm/lib/sales-order-queries', () => ({ useUpdateMfgSalesOrderStatus: () => ({ mutateAsync: cancelSo }) }));
vi.mock('../../vendor/scm/lib/suppliers-queries', () => ({ useCancelPurchaseOrder: () => ({ mutateAsync: vi.fn() }) }));
vi.mock('../../vendor/scm/components/ConfirmDialog', () => ({ useConfirm: () => confirm }));
vi.mock('../../vendor/scm/components/PromptDialog', () => ({ usePrompt: () => vi.fn(async () => 'Not a real cancellation') }));
vi.mock('../../vendor/scm/lib/dialog-service', () => ({ serviceNotify: vi.fn(async () => undefined) }));
vi.mock('../../hooks/useStaffLookup', () => ({ useStaffLookup: () => ({ actorNameOf: () => 'Staffer' }) }));
vi.mock('../../hooks/useAmendmentApprovals', () => ({ useRefreshApprovalBadges: () => refreshBadges }));
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: viewer.id }, can: (p: string) => viewer.perms.includes('*') || viewer.perms.includes(p) }),
}));

const { Amendments } = await import('./Amendments');
const { MobileAmendments } = await import('../../mobile/MobileAmendments');

const desktop = () => render(<MemoryRouter initialEntries={['/scm/amendments']}><Amendments /></MemoryRouter>);
const phone = () => render(<MobileAmendments onBack={() => {}} onOpen={() => {}} />);

const rowFor = (container: HTMLElement, text: string): HTMLElement => {
  const tr = [...container.querySelectorAll('tr[data-vrow]')].find((r) => r.textContent.includes(text));
  if (!tr) throw new Error(`no row for ${text}`);
  return tr as HTMLElement;
};

const cardFor = (text: string): HTMLElement => {
  const card = [...document.querySelectorAll('.amd')].find((c) => c.textContent.includes(text));
  if (!card) throw new Error(`no card for ${text}`);
  return card as HTMLElement;
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  viewer = { id: 31, perms: ['scm.so_cancel.approve_l1'] };
  CANCELS = [cancelRow()];
  AMENDMENTS = [amendment()];
});

describe('desktop SO Amendment queue', () => {
  it('lists a cancellation request beside the amendments, saying what it is and whose it is', () => {
    const { container } = desktop();
    const row = rowFor(container, 'HC-SO-000002');
    expect(row.textContent).toContain('Cancellation');
    expect(row.textContent).toContain('Sales Director');
    expect(row.textContent).toContain('Amy');
    expect(row.textContent).toContain('Customer no longer wants it');
    expect(row.textContent).toMatch(/level-1 approval/);
    // The amendment rows are untouched by the merge.
    expect(rowFor(container, 'HC-SO-000001').textContent).toContain('Purchaser');
  });

  it('shows no buttons to someone who cannot sign, and none on an amendment row', () => {
    viewer = { id: 31, perms: [] };
    const { container } = desktop();
    expect(within(rowFor(container, 'HC-SO-000002')).queryByRole('button')).toBeNull();
    expect(within(rowFor(container, 'HC-SO-000001')).queryByRole('button')).toBeNull();
  });

  it('does not offer the signature to the person who raised the request', () => {
    viewer = { id: 11, perms: ['*'] };
    const { container } = desktop();
    const row = rowFor(container, 'HC-SO-000002');
    expect(within(row).queryByText(/Approve/)).toBeNull();
    // An approver may still refuse it or pull it back.
    expect(within(row).getByText('Reject')).toBeTruthy();
  });

  it('a level-1 approval signs the request and cancels nothing yet', async () => {
    const { container } = desktop();
    fireEvent.click(within(rowFor(container, 'HC-SO-000002')).getByText('Approve (level 1)'));
    await waitFor(() => expect(approveSo).toHaveBeenCalledWith({ key: 'HC-SO-000002' }));
    expect(cancelSo).not.toHaveBeenCalled();
    expect(refreshBadges).toHaveBeenCalled();
  });

  it('the final approval signs it AND runs the Sales Order cancel', async () => {
    viewer = { id: 31, perms: ['scm.so_cancel.approve_l2'] };
    CANCELS = [cancelRow({ status: 'L1_APPROVED', l1_by: 12, l1_by_name: 'Dee', l1_at: '2026-09-24T02:00:00Z' })];
    approveSo.mockResolvedValueOnce({ request: {}, execute: true });
    const { container } = desktop();
    fireEvent.click(within(rowFor(container, 'HC-SO-000002')).getByText('Approve & cancel'));
    await waitFor(() => expect(cancelSo).toHaveBeenCalledWith({
      docNo: 'HC-SO-000002', status: 'CANCELLED', expectedStatus: 'CONFIRMED',
    }));
  });

  it('an approved request offers to run the cancel that has not run yet', async () => {
    CANCELS = [cancelRow({ status: 'APPROVED' })];
    const { container } = desktop();
    fireEvent.click(within(rowFor(container, 'HC-SO-000002')).getByText('Cancel now'));
    await waitFor(() => expect(cancelSo).toHaveBeenCalled());
    expect(approveSo).not.toHaveBeenCalled();
  });

  it('a withdrawn request is in the Rejected chip, never in Requested', () => {
    CANCELS = [cancelRow({ status: 'WITHDRAWN' })];
    AMENDMENTS = [];
    const { container } = desktop();
    expect(screen.getByRole('button', { name: /Rejected 1/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Requested 0/ })).toBeTruthy();
    expect(rowFor(container, 'HC-SO-000002').textContent).toContain('Withdrawn');
  });

  it('leaves out a cancellation that is not a Sales Order', () => {
    CANCELS = [cancelRow({ id: 'po', doc_type: 'PO', doc_key: 'po-1', doc_number: 'PO-1' })];
    const { container } = desktop();
    expect(container.textContent).not.toContain('PO-1');
  });
});

describe('phone SO Amendment queue', () => {
  it('shows the same row, with the same button', async () => {
    phone();
    const card = cardFor('HC-SO-000002');
    expect(card.textContent).toContain('Sales Director');
    expect(card.textContent).toContain('Cancellation requested');
    fireEvent.click(within(card).getByText('Approve (level 1)'));
    await waitFor(() => expect(approveSo).toHaveBeenCalledWith({ key: 'HC-SO-000002' }));
  });

  it('gives a phone approver nothing to press when they cannot sign', () => {
    viewer = { id: 31, perms: [] };
    phone();
    const card = cardFor('HC-SO-000002');
    expect(within(card).queryByRole('button')).toBeNull();
  });
});
