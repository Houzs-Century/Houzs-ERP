/* Amendment queues open with what still needs an action on top (staff request,
   2026-09-14): Requested, then Approved, then Rejected, newest first inside
   each. Before this the SO and PO queues opened in fetch order (newest first,
   so a week-old Requested row sat under a page of Approved ones) and clicking
   Status sorted the bucket NAMES A-Z, which put Approved above Requested.

   One order, owned by status-pill.ts beside the buckets it ranks, read by the
   desktop grids (as DataGrid's defaultSort + the Status column's sortFn) and
   by the two phone queues. Each surface is rendered here, not just the helper,
   because the bug was a surface that never asked for an order at all. */

import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';

type Row = { id: string; so_doc_no: string; po_id: string; po_number: string; amendment_no: string; status: string; reason: null; requested_by: null; created_at: string; updated_at: null; lane: 'LINES' | null; bound_pos?: Array<{ po_number: string }> };

const row = (id: string, status: string, createdAt: string): Row => ({
  id, so_doc_no: `SO-${id}`, po_id: `po-${id}`, po_number: `PO-${id}`, amendment_no: id, status, reason: null,
  requested_by: null, created_at: createdAt, updated_at: null, lane: 'LINES',
});

/* Fetch order = newest first, exactly what both list endpoints return. The
   granular SO statuses are in here on purpose: SUPPLIER_PENDING is a Requested
   row, SENT and SO_APPROVED are Approved rows. */
const SO_ROWS: Row[] = [
  row('a', 'SENT', '2026-09-10T08:00:00Z'),
  row('b', 'REJECTED', '2026-09-09T08:00:00Z'),
  row('c', 'SO_APPROVED', '2026-09-08T08:00:00Z'),
  row('d', 'REQUESTED', '2026-09-07T08:00:00Z'),
  row('e', 'SUPPLIER_PENDING', '2026-09-06T08:00:00Z'),
  row('f', 'REJECTED', '2026-09-05T08:00:00Z'),
];
const EXPECTED = ['d', 'e', 'a', 'c', 'b', 'f'];

let soRows: Row[] = SO_ROWS;
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
import { AMENDMENT_BUCKET_ORDER, compareAmendmentsForList } from '../../vendor/scm/lib/status-pill';

const gridIds = (container: HTMLElement, prefix: string): string[] =>
  [...container.querySelectorAll('tr[data-vrow]')].map((tr) => {
    const m = tr.textContent.match(new RegExp(`${prefix}-([a-z])`));
    return m ? m[1]! : '?';
  });

afterEach(() => {
  localStorage.clear();
  soRows = SO_ROWS;
  poRows = [];
});

describe('the shared amendment list order', () => {
  test('Requested, then Approved, then Rejected — newest first inside each', () => {
    expect(AMENDMENT_BUCKET_ORDER).toEqual(['REQUESTED', 'APPROVED', 'REJECTED']);
    const sorted = [...SO_ROWS].sort(compareAmendmentsForList((r) => r.status, (r) => r.created_at));
    expect(sorted.map((r) => r.id)).toEqual(EXPECTED);
  });

  test('a row with no date sinks below the dated rows of its status', () => {
    const undated = { ...row('z', 'REQUESTED', ''), created_at: null as unknown as string };
    const sorted = [undated, ...SO_ROWS].sort(compareAmendmentsForList((r) => r.status, (r) => r.created_at));
    expect(sorted.map((r) => r.id)).toEqual(['d', 'e', 'z', 'a', 'c', 'b', 'f']);
  });
});

describe('desktop SO amendment queue', () => {
  test('opens with Requested on top', () => {
    const { container } = render(<MemoryRouter><Amendments /></MemoryRouter>);
    expect(gridIds(container, 'SO')).toEqual(EXPECTED);
  });

  test('clicking Status sorts by the same order, not by the bucket names A-Z', () => {
    const { container } = render(<MemoryRouter><Amendments /></MemoryRouter>);
    fireEvent.click(screen.getByRole('columnheader', { name: /^Status/ }));
    const ids = gridIds(container, 'SO');
    const bucketOf = (id: string) => ({ a: 1, b: 2, c: 1, d: 0, e: 0, f: 2 } as Record<string, number>)[id];
    expect(ids.map(bucketOf)).toEqual([0, 0, 1, 1, 2, 2]);
  });

  /* The owner's screen on 2026-09-14: the Status header read "↓", a sort clicked
     on an earlier visit and remembered by the browser, so Requested sat at the
     BOTTOM of "All" even though the queue's own order puts it on top. */
  test('a Status sort left from an earlier visit does not decide the order the next time it opens', () => {
    const bucketOf = (id: string) => ({ a: 1, b: 2, c: 1, d: 0, e: 0, f: 2 } as Record<string, number>)[id];
    const first = render(<MemoryRouter><Amendments /></MemoryRouter>);
    const status = screen.getByRole('columnheader', { name: /^Status/ });
    fireEvent.click(status); // ascending
    fireEvent.click(status); // descending: Requested at the bottom for THIS visit
    expect(gridIds(first.container, 'SO').map(bucketOf)).toEqual([2, 2, 1, 1, 0, 0]);
    first.unmount();
    const { container } = render(<MemoryRouter><Amendments /></MemoryRouter>);
    expect(gridIds(container, 'SO')).toEqual(EXPECTED);
  });
});

describe('desktop PO amendment queue', () => {
  test('opens with Requested on top across BOTH sources', () => {
    soRows = [
      { ...row('m', 'SENT', '2026-09-12T08:00:00Z'), bound_pos: [{ po_number: 'PO-m' }] },
      { ...row('n', 'SUPPLIER_PENDING', '2026-09-01T08:00:00Z'), bound_pos: [{ po_number: 'PO-n' }] },
    ];
    poRows = [
      row('p', 'APPROVED', '2026-09-11T08:00:00Z'),
      row('q', 'REQUESTED', '2026-09-03T08:00:00Z'),
      row('r', 'REJECTED', '2026-09-13T08:00:00Z'),
    ];
    const { container } = render(<MemoryRouter><PoAmendments /></MemoryRouter>);
    expect(gridIds(container, 'PO')).toEqual(['q', 'n', 'm', 'p', 'r']);
  });

  test('a sort left from an earlier visit does not decide the order the next time it opens', () => {
    poRows = [
      row('p', 'APPROVED', '2026-09-11T08:00:00Z'),
      row('q', 'REQUESTED', '2026-09-03T08:00:00Z'),
      row('r', 'REJECTED', '2026-09-13T08:00:00Z'),
    ];
    const first = render(<MemoryRouter><PoAmendments /></MemoryRouter>);
    const created = screen.getByRole('columnheader', { name: /^Created/ });
    fireEvent.click(created); // oldest first
    fireEvent.click(created); // newest first: the Rejected row leads this visit
    expect(gridIds(first.container, 'PO')[0]).toBe('r');
    first.unmount();
    const { container } = render(<MemoryRouter><PoAmendments /></MemoryRouter>);
    expect(gridIds(container, 'PO')).toEqual(['q', 'p', 'r']);
  });
});

describe('phone amendment queues', () => {
  const cardIds = (prefix: string) =>
    [...document.querySelectorAll('.amd .sono')].map((el) => el.textContent.replace(`${prefix}-`, ''));

  test('SO queue opens with Requested on top', () => {
    render(<MobileAmendments onBack={() => {}} onOpen={() => {}} />);
    expect(cardIds('SO')).toEqual(EXPECTED);
  });

  test('PO queue opens with Requested on top', () => {
    poRows = [
      row('p', 'APPROVED', '2026-09-11T08:00:00Z'),
      row('r', 'REJECTED', '2026-09-13T08:00:00Z'),
      row('q', 'REQUESTED', '2026-09-03T08:00:00Z'),
    ];
    render(<MobilePoAmendments onBack={() => {}} onOpen={() => {}} onOpenSo={() => {}} />);
    expect(cardIds('PO')).toEqual(['q', 'p', 'r']);
  });
});
