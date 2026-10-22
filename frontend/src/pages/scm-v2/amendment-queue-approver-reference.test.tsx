/* Two asks from the owner on the amendment queues, 2026-09-14:
     「purchaser / logistic - approver需要更明显得看 - 那个是归类purchaser哪个是归类Logistic」
     「要加上reference number」 (on the Sales Order Amendment queue)

   Each surface is rendered with only the data hooks faked, and the assertions
   read what the operator sees: which badge a row carries, and which reference. */

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';

type Row = {
  id: string; so_doc_no: string; po_number: string; amendment_no: string; status: string;
  reason: null; requested_by: null; created_at: string; updated_at: null;
  lane: 'LINES' | 'DELIVERY' | null; bound_pos?: Array<{ id: string; po_number: string; status: string }>;
  so_ref?: string | null; so_customer_so_no?: string | null;
};

/* Dates run newest-first in id order so every row is Requested and the open
   order is simply the order written here. */
const row = (id: string, day: number, over: Partial<Row> = {}): Row => ({
  id, so_doc_no: `SO-${id}`, po_number: `PO-${id}`, amendment_no: `A-${id}`, status: 'REQUESTED',
  reason: null, requested_by: null, created_at: `2026-09-${String(day).padStart(2, '0')}T08:00:00Z`,
  updated_at: null, lane: 'LINES', ...over,
});

let soRows: Row[] = [];
let poRows: Row[] = [];
vi.mock('../../vendor/scm/lib/so-amendment-queries', () => ({
  useAmendments: () => ({ data: { amendments: soRows }, isLoading: false, error: null }),
}));
vi.mock('../../vendor/scm/lib/po-amendment-queries', () => ({
  usePoAmendments: () => ({ data: { amendments: poRows }, isLoading: false, error: null }),
}));
/* The queue also lists CANCELLATION requests since owner 2026-09-24. This file
   is about the amendment rows, so the cancellation half is stubbed empty — and
   its hooks are stubbed rather than provided, because they want a QueryClient,
   an AuthProvider and a ConfirmProvider this render deliberately does without. */
vi.mock('../../vendor/scm/lib/document-cancel-queries', async (orig) => ({
  ...(await orig<typeof import('../../vendor/scm/lib/document-cancel-queries')>()),
  useCancelRequests: () => ({ data: { requests: [] }, isLoading: false, error: null }),
}));
vi.mock('../../vendor/scm/lib/use-cancel-request-actions', async (orig) => ({
  ...(await orig<typeof import('../../vendor/scm/lib/use-cancel-request-actions')>()),
  useCancelRequestActions: () => ({ approve: async () => {}, reject: async () => {}, withdraw: async () => {}, executeNow: async () => {}, busy: false }),
}));
vi.mock('../../hooks/useAmendmentApprovals', () => ({ useRefreshApprovalBadges: () => () => {} }));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 1 }, can: () => false }) }));

vi.mock('../../hooks/useStaffLookup', () => ({
  useStaffLookup: () => ({ actorNameOf: () => '—' }),
}));

import { Amendments } from './Amendments';
import { PoAmendments } from './PoAmendments';
import { MobileAmendments } from '../../mobile/MobileAmendments';
import { MobilePoAmendments } from '../../mobile/MobilePoAmendments';

afterEach(() => {
  localStorage.clear();
  soRows = [];
  poRows = [];
});

const gridBadges = (container: HTMLElement) =>
  [...container.querySelectorAll('tr[data-vrow]')].map((tr) => {
    const badge = tr.querySelector('[data-approver]');
    return badge ? `${badge.getAttribute('data-approver')}:${badge.textContent}` : 'none';
  });

describe('desktop Sales Order Amendment queue', () => {
  test('the Approver column is a badge: Purchaser for product lines, Logistic for delivery, Legacy before the lanes', () => {
    soRows = [
      row('a', 14, { lane: 'LINES' }),
      row('b', 13, { lane: 'DELIVERY' }),
      row('c', 12, { lane: null }),
    ];
    const { container } = render(<MemoryRouter><Amendments /></MemoryRouter>);
    expect(gridBadges(container)).toEqual(['PURCHASER:Purchaser', 'LOGISTIC:Logistic', 'LEGACY:Legacy']);
  });

  test('a Ref No. column shows the Sales Order reference, by the Sales Order list rule', () => {
    soRows = [
      row('a', 14, { so_ref: 'MR TAN / SUNWAY', so_customer_so_no: 'IGNORED WHEN REF IS SET' }),
      row('b', 13, { so_ref: null, so_customer_so_no: 'CUST-PO-7' }),
      row('c', 12, { so_ref: null, so_customer_so_no: null }),
    ];
    const { container } = render(<MemoryRouter><Amendments /></MemoryRouter>);
    expect(screen.getByRole('columnheader', { name: /^Ref No./ })).toBeTruthy();
    const rows = [...container.querySelectorAll('tr[data-vrow]')].map((tr) => tr.textContent);
    expect(rows[0]).toContain('MR TAN / SUNWAY');
    expect(rows[0]).not.toContain('IGNORED WHEN REF IS SET');
    expect(rows[1]).toContain('CUST-PO-7');
  });
});

describe('desktop PO Amendments queue', () => {
  test('a direct PO amendment is Purchaser; a row from an SO amendment follows its lane', () => {
    poRows = [row('p', 14)];
    soRows = [
      row('s', 13, { lane: 'LINES', bound_pos: [{ id: 'po-s', po_number: 'PO-s', status: 'SUBMITTED' }] }),
      row('t', 12, { lane: null, bound_pos: [{ id: 'po-t', po_number: 'PO-t', status: 'SUBMITTED' }] }),
    ];
    const { container } = render(<MemoryRouter><PoAmendments /></MemoryRouter>);
    expect(gridBadges(container)).toEqual(['PURCHASER:Purchaser', 'PURCHASER:Purchaser', 'LEGACY:Legacy']);
  });
});

describe('phone queues', () => {
  test('an SO amendment card carries its approver badge and the order reference', () => {
    soRows = [
      row('a', 14, { lane: 'DELIVERY', so_ref: 'MR TAN / SUNWAY' }),
      row('b', 13, { lane: 'LINES', so_ref: null, so_customer_so_no: null }),
    ];
    render(<MobileAmendments onBack={() => {}} onOpen={() => {}} />);
    const cards = [...document.querySelectorAll('.amd')];
    expect(cards[0]?.textContent).toContain('Logistic');
    expect(cards[0]?.textContent).toContain('Ref MR TAN / SUNWAY');
    expect(cards[1]?.textContent).toContain('Purchaser');
    expect(cards[1]?.textContent).not.toContain('Ref');
  });

  test('a PO amendment card says Purchaser', () => {
    poRows = [row('p', 14)];
    render(<MobilePoAmendments onBack={() => {}} onOpen={() => {}} onOpenSo={() => {}} />);
    expect(document.querySelector('.amd')?.textContent).toContain('Purchaser');
  });
});
