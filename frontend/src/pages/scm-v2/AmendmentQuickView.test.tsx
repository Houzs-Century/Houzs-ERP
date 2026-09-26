/* The amendment queues' quick view (owner 2026-09-14:「SO / PO amendment需要单击打开
 * 弹窗 像SO这样」). What it owes the reader: who asked, why, who signs, what
 * changes — drawn with the job cards' own line cards — and one click through to
 * the job card, where approving happens. Only the detail hooks are faked. */
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Q = { data: unknown; isLoading: boolean; error: unknown };
let soQ: Q = { data: undefined, isLoading: false, error: null };
let poQ: Q = { data: undefined, isLoading: false, error: null };
vi.mock('../../vendor/scm/lib/so-amendment-queries', async (orig) => ({
  ...(await orig<typeof import('../../vendor/scm/lib/so-amendment-queries')>()),
  useAmendmentDetail: () => soQ,
  useChangeAmendmentLane: () => ({ isPending: false, mutateAsync: async () => {} }),
}));
let superAdmin = false;
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: (p: string) => superAdmin && p === '*' }) }));
vi.mock('../../vendor/scm/components/PromptDialog', () => ({ usePrompt: () => async () => null }));
vi.mock('../../vendor/scm/components/NotifyDialog', () => ({ useNotify: () => async () => undefined }));
vi.mock('../../vendor/scm/lib/po-amendment-queries', async (orig) => ({
  ...(await orig<typeof import('../../vendor/scm/lib/po-amendment-queries')>()),
  usePoAmendmentDetail: () => poQ,
}));
vi.mock('../../hooks/useStaffLookup', () => ({
  useStaffLookup: () => ({ actorNameOf: (id: string | null | undefined, empty = '—') => (id === 'staff-syasya' ? 'Syasya' : empty) }),
}));

const { AmendmentQuickView, amendmentJobCardPath } = await import('./AmendmentQuickView');
type Target = import('./AmendmentQuickView').AmendmentQuickViewTarget;

const soData = (over: Record<string, unknown> = {}) => ({
  amendment: {
    id: 'amd-1', so_doc_no: 'HC-SO-012757', amendment_no: 'HC-SO-012757/A1', status: 'REQUESTED',
    reason: 'last min cancellation penalty', requested_by: 'staff-syasya', created_at: '2026-09-14T09:12:29Z',
    updated_at: null, lane: 'DELIVERY', header_changes: null, old_header_snapshot: null, ...over,
  },
  lines: [{
    id: 'l1', amendment_id: 'amd-1', sales_order_item_id: null, change_type: 'ADD',
    new_item_code: 'TRANSPORTATION CHARGES', new_variants: null, new_qty: 1, new_unit_price_sen: 15000, old_snapshot: null,
  }],
  salesOrder: { doc_no: 'HC-SO-012757', status: 'CONFIRMED', revision: 1 },
  purchaseOrders: [],
});

const poData = () => ({
  amendment: {
    id: 'poamd-1', po_id: 'po-1', po_number: 'HC-PO-2609-064', amendment_no: 'HC-PO-2609-064/A1', status: 'REQUESTED',
    reason: 'supplier moved the ship date', requested_by: null, created_at: '2026-09-14T03:00:00Z', updated_at: null,
    header_changes: { expected_at: '2026-10-05' }, old_header_snapshot: { expected_at: '2026-09-30' },
  },
  lines: [{
    id: 'pl1', amendment_id: 'poamd-1', purchase_order_item_id: 'poi-1', change_type: 'QTY', new_item_code: null,
    new_material_name: null, new_variants: null, new_qty: 3, new_unit_price_sen: null, new_delivery_date: null,
    old_snapshot: { item_code: 'HILTON-(Q)', qty: 2, unit_price_sen: 50000 },
  }],
  purchaseOrder: { id: 'po-1', po_number: 'HC-PO-2609-064', status: 'SUBMITTED', revision: 2 },
});

const mount = (target: Target | null) => render(
  <MemoryRouter initialEntries={['/queue']}>
    <Routes>
      <Route path="/queue" element={<AmendmentQuickView target={target} onClose={() => undefined} />} />
      <Route path="/scm/amendments/:id" element={<div>SO job card</div>} />
      <Route path="/scm/po-amendments/:id" element={<div>PO job card</div>} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  soQ = { data: undefined, isLoading: false, error: null };
  poQ = { data: undefined, isLoading: false, error: null };
  superAdmin = false;
  try { window.localStorage.clear(); } catch { /* jsdom without storage */ }
});

describe('AmendmentQuickView — a Sales Order amendment', () => {
  it('offers a super admin, and only a super admin, the change-approver control (owner 2026-09-25)', () => {
    soQ = { data: soData(), isLoading: false, error: null };
    const first = mount({ kind: 'so', id: 'amd-1', label: 'HC-SO-012757/A1' });
    expect(screen.queryByText('Change approver (admin)')).toBeNull();
    first.unmount();
    superAdmin = true;
    mount({ kind: 'so', id: 'amd-1', label: 'HC-SO-012757/A1' });
    fireEvent.click(screen.getByText('Change approver (admin)'));
    expect(screen.getByText('Move to Purchaser')).toBeTruthy();
    expect(screen.getByText('Move to Sales Director')).toBeTruthy();
    expect(screen.queryByText('Move to Logistic')).toBeNull();
  });

  it('says who asked, why, who signs, and shows the line with the job card\'s own card', () => {
    soQ = { data: soData(), isLoading: false, error: null };
    mount({ kind: 'so', id: 'amd-1', label: 'HC-SO-012757/A1' });
    expect(screen.getByRole('dialog', { name: 'Amendment HC-SO-012757/A1' })).toBeTruthy();
    expect(screen.getByText('Sales Order amendment')).toBeTruthy();
    expect(screen.getByText('HC-SO-012757')).toBeTruthy();
    expect(screen.getByText('Logistic')).toBeTruthy();
    expect(screen.getByText('Syasya')).toBeTruthy();
    expect(screen.getByText('last min cancellation penalty')).toBeTruthy();
    expect(screen.getByText('Line changes · 1')).toBeTruthy();
    expect(screen.getByText('Added line')).toBeTruthy();
    expect(screen.getByText('TRANSPORTATION CHARGES')).toBeTruthy();
    expect(screen.getByText('New line — nothing before')).toBeTruthy();
    /* A new line with no remark and no discount has nothing to clear. */
    expect(screen.queryByText('Remark cleared')).toBeNull();
    expect(screen.queryByText('Discount cleared')).toBeNull();
  });

  it('renders the order changes before the lines, and says when nothing else changes', () => {
    soQ = {
      data: { ...soData({ header_changes: { customerDeliveryDate: '2026-10-01' }, old_header_snapshot: { customerDeliveryDate: '2026-09-20' } }), lines: [] },
      isLoading: false, error: null,
    };
    mount({ kind: 'so', id: 'amd-1', label: 'HC-SO-012757/A1' });
    expect(screen.getByText('Order changes · 1')).toBeTruthy();
    expect(screen.getByText('No line changes — only the order details above.')).toBeTruthy();
  });

  it('names a withdrawn request as withdrawn, with its words', () => {
    soQ = { data: soData({ status: 'REJECTED', resolution: 'WITHDRAWN', rejection_reason: 'raised on the wrong order' }), isLoading: false, error: null };
    mount({ kind: 'so', id: 'amd-1', label: 'HC-SO-012757/A1' });
    expect(screen.getByText('Withdrawn by the person who raised it.')).toBeTruthy();
    expect(screen.getByText('“raised on the wrong order”')).toBeTruthy();
  });

  it('Open full page goes to the amendment job card', () => {
    soQ = { data: soData(), isLoading: false, error: null };
    mount({ kind: 'so', id: 'amd-1', label: 'HC-SO-012757/A1' });
    fireEvent.click(screen.getByRole('button', { name: /Open full page/ }));
    expect(screen.getByText('SO job card')).toBeTruthy();
  });
});

describe('AmendmentQuickView — a Purchase Order amendment', () => {
  it('shows the PO, the Purchaser, the delivery-date change and the quantity change', () => {
    poQ = { data: poData(), isLoading: false, error: null };
    mount({ kind: 'po', id: 'poamd-1', label: 'HC-PO-2609-064/A1' });
    expect(screen.getByText('PO amendment')).toBeTruthy();
    expect(screen.getByText('HC-PO-2609-064')).toBeTruthy();
    expect(screen.getByText('Purchaser')).toBeTruthy();
    expect(screen.getByText('Delivery date')).toBeTruthy();
    expect(screen.getByText('Quantity change')).toBeTruthy();
    expect(screen.getByText('Qty 2')).toBeTruthy();
    expect(screen.getByText('Qty 3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Open full page/ }));
    expect(screen.getByText('PO job card')).toBeTruthy();
  });
});

describe('AmendmentQuickView — states', () => {
  it('shows the number at once and says it is loading', () => {
    soQ = { data: undefined, isLoading: true, error: null };
    mount({ kind: 'so', id: 'amd-1', label: 'HC-SO-012757/A1' });
    expect(screen.getByText('HC-SO-012757/A1')).toBeTruthy();
    expect(screen.getByText('Loading amendment…')).toBeTruthy();
  });

  it('a failed load says so — it never reads as an amendment that changes nothing', () => {
    poQ = { data: undefined, isLoading: false, error: new Error('Amendment not found') };
    mount({ kind: 'po', id: 'poamd-9', label: 'HC-PO-2609-064/A9' });
    expect(screen.getByText('Could not load this amendment.')).toBeTruthy();
    expect(screen.getByText(/Amendment not found/)).toBeTruthy();
    expect(screen.queryByText(/Line changes/)).toBeNull();
  });

  it('no target, no content', () => {
    mount(null);
    expect(screen.queryByRole('button', { name: /Open full page/ })).toBeNull();
  });

  it('the job card path follows the row kind', () => {
    expect(amendmentJobCardPath({ kind: 'so', id: 'a' })).toBe('/scm/amendments/a');
    expect(amendmentJobCardPath({ kind: 'po', id: 'b' })).toBe('/scm/po-amendments/b');
  });
});
