import { describe, expect, test } from 'vitest';
import { buildPoAmendmentInbox } from './po-amendment-inbox';
import type { PoAmendmentRow } from './po-amendment-queries';
import type { AmendmentRow } from './so-amendment-queries';

const po = (id: string, over: Partial<PoAmendmentRow> = {}): PoAmendmentRow => ({
  id, po_id: `po-${id}`, po_number: `PO-${id}`, amendment_no: `PO-${id}/A1`, status: 'REQUESTED',
  reason: null, requested_by: null, created_at: '2026-09-14T08:00:00Z', updated_at: null, ...over,
});

const bound = (...numbers: string[]) => numbers.map((n) => ({ id: `id-${n}`, po_number: n, status: 'SUBMITTED' }));

const so = (id: string, over: Partial<AmendmentRow> = {}): AmendmentRow => ({
  id, so_doc_no: `SO-${id}`, amendment_no: `SO-${id}/A1`, status: 'REQUESTED', reason: null,
  requested_by: null, created_at: '2026-09-14T08:00:00Z', updated_at: null, lane: 'LINES', ...over,
});

describe('buildPoAmendmentInbox', () => {
  test('a direct PO amendment is a po row, signed by Purchaser, with no Sales Order', () => {
    const [row] = buildPoAmendmentInbox([po('p', { reason: 'late', requested_by: 'staff-1' })], []);
    expect(row).toEqual({
      key: 'po:p', kind: 'po', id: 'p', soDocNo: null, poLabel: 'PO-p', amendmentNo: 'PO-p/A1',
      approver: 'PURCHASER', requestedBy: 'staff-1', reason: 'late', status: 'REQUESTED',
      createdAt: '2026-09-14T08:00:00Z',
    });
  });

  test('an SO amendment joins only when it revises a bound PO, and never from the DELIVERY lane', () => {
    const rows = buildPoAmendmentInbox([], [
      so('lines', { bound_pos: bound('PO-1') }),
      so('legacy', { lane: null, bound_pos: bound('PO-2') }),
      so('delivery', { lane: 'DELIVERY', bound_pos: bound('PO-3') }),
      so('no-po', { bound_pos: [] }),
      so('old-backend'),
    ]);
    expect(rows.map((r) => [r.key, r.approver])).toEqual([
      ['so:lines', 'PURCHASER'],
      ['so:legacy', 'LEGACY'],
    ]);
  });

  test('an SO-driven row names every bound PO and the order it revises', () => {
    const [row] = buildPoAmendmentInbox([], [so('s', { amendment_no: 7, bound_pos: bound('PO-1', 'PO-2') })]);
    expect(row).toMatchObject({ kind: 'so', id: 's', soDocNo: 'SO-s', poLabel: 'PO-1, PO-2', amendmentNo: '7' });
  });

  test('the two tables can share an id without colliding keys', () => {
    const rows = buildPoAmendmentInbox([po('same')], [so('same', { bound_pos: bound('PO-1') })]);
    expect(rows.map((r) => r.key)).toEqual(['po:same', 'so:same']);
  });
});
