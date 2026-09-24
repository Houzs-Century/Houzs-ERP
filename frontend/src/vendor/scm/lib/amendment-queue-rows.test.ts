/* The SO Amendment queue carries cancellation requests since owner 2026-09-24
   (「当有 SO request cancel bill - 需要在 SO amendment 出现」). What is asserted
   here is what makes that merge SAFE rather than pretty:

     · a cancellation's own statuses bucket correctly — a WITHDRAWN request must
       not read as something still on a desk, which is exactly what the
       amendment table (amendmentBucketOf) would have said about it;
     · only SALES ORDER cancellations join this queue — a PO / DO cancellation
       belongs to its own inbox and has nothing to do with these desks;
     · the queue's one order (action first, newest first) holds across BOTH
       kinds of row, so an old amendment cannot hide a cancellation raised today.

   Both surfaces build their rows here, so a surface cannot disagree with the
   other about any of it. */

import { describe, expect, it } from 'vitest';
import { buildAmendmentQueueRows, cancelApproverLabel, cancelBucketOf } from './amendment-queue-rows';
import type { AmendmentRow } from './so-amendment-queries';
import type { CancelRequestRow } from './document-cancel-queries';

const amendment = (over: Partial<AmendmentRow> = {}): AmendmentRow => ({
  id: 'a1',
  so_doc_no: 'HC-SO-000001',
  amendment_no: 1,
  status: 'REQUESTED',
  reason: 'Customer changed the fabric',
  requested_by: 'staff-uuid',
  created_at: '2026-09-20T08:00:00Z',
  updated_at: null,
  lane: 'LINES',
  ...over,
} as AmendmentRow);

const cancel = (over: Partial<CancelRequestRow> = {}): CancelRequestRow => ({
  id: 'c1',
  company_id: 1,
  doc_type: 'SO',
  doc_key: 'HC-SO-000002',
  doc_number: 'HC-SO-000002',
  doc_status_at_request: 'CONFIRMED',
  status: 'REQUESTED',
  reason: 'Customer no longer wants the order',
  doc_ref: 'MR TAN / SUNWAY',
  doc_customer_so_no: null,
  requested_by: 7,
  requested_by_name: 'Farra',
  requested_at: '2026-09-21T08:00:00Z',
  l1_by: null, l1_by_name: null, l1_at: null,
  l2_by: null, l2_by_name: null, l2_at: null,
  rejected_by: null, rejected_by_name: null, rejected_at: null, reject_reason: null,
  executed_by: null, executed_at: null,
  ...over,
});

const build = (a: AmendmentRow[], c: CancelRequestRow[]) => buildAmendmentQueueRows(a, c, () => 'REF-1');

describe('cancelBucketOf', () => {
  it('files a request still needing a signature under Requested', () => {
    expect(cancelBucketOf('REQUESTED')).toBe('REQUESTED');
    expect(cancelBucketOf('L1_APPROVED')).toBe('REQUESTED');
  });

  it('files a signed or executed request under Approved', () => {
    expect(cancelBucketOf('APPROVED')).toBe('APPROVED');
    expect(cancelBucketOf('EXECUTED')).toBe('APPROVED');
  });

  it('files a refused or withdrawn request under Rejected — never Requested', () => {
    expect(cancelBucketOf('REJECTED')).toBe('REJECTED');
    expect(cancelBucketOf('WITHDRAWN')).toBe('REJECTED');
  });
});

describe('cancelApproverLabel', () => {
  it('names the desk the signature is waiting on, and nobody once it is not', () => {
    expect(cancelApproverLabel({ status: 'REQUESTED' })).toBe('Sales Director');
    expect(cancelApproverLabel({ status: 'L1_APPROVED' })).toBe('Purchaser');
    expect(cancelApproverLabel({ status: 'APPROVED' })).toBe('—');
    expect(cancelApproverLabel({ status: 'REJECTED' })).toBe('—');
  });
});

describe('buildAmendmentQueueRows', () => {
  it('keeps only Sales Order cancellations', () => {
    const rows = build([], [
      cancel({ id: 'so', doc_type: 'SO' }),
      cancel({ id: 'po', doc_type: 'PO', doc_key: 'po-1', doc_number: 'PO-1' }),
      cancel({ id: 'do', doc_type: 'DO', doc_key: 'do-1', doc_number: 'DO-1' }),
    ]);
    expect(rows.map((r) => r.key)).toEqual(['cancel:so']);
  });

  it('keys the two kinds apart, so an id collision cannot merge two rows', () => {
    const rows = build([amendment({ id: 'x' })], [cancel({ id: 'x' })]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  });

  it('opens with what still needs an action, newest first inside that', () => {
    const rows = build(
      [
        amendment({ id: 'old-open', created_at: '2026-09-01T08:00:00Z' }),
        amendment({ id: 'approved', status: 'SENT', created_at: '2026-09-23T08:00:00Z' }),
      ],
      [
        cancel({ id: 'new-open', requested_at: '2026-09-22T08:00:00Z' }),
        cancel({ id: 'withdrawn', status: 'WITHDRAWN', requested_at: '2026-09-24T08:00:00Z' }),
      ],
    );
    expect(rows.map((r) => r.key)).toEqual([
      'cancel:new-open',      // Requested, newest
      'amendment:old-open',   // Requested, older
      'amendment:approved',   // Approved
      'cancel:withdrawn',     // closed
    ]);
  });

  it('carries what each row shows: type, number, requester, reason, state', () => {
    const [c, a] = build([amendment()], [cancel()]);
    expect(c).toMatchObject({
      kind: 'CANCEL',
      kindLabel: 'Cancellation',
      soDocNo: 'HC-SO-000002',
      numberLabel: 'Cancel',
      requestedByName: 'Farra',
      reference: 'MR TAN / SUNWAY',
      requestedByStaffId: null,
      reason: 'Customer no longer wants the order',
      approverKey: 'CANCEL_L1',
      approverLabel: 'Sales Director',
      bucket: 'REQUESTED',
    });
    expect(c!.statusLabel).toMatch(/level-1 approval/);
    expect(a).toMatchObject({
      kind: 'AMENDMENT',
      kindLabel: 'Amendment',
      soDocNo: 'HC-SO-000001',
      numberLabel: '1',
      reference: 'REF-1',
      requestedByStaffId: 'staff-uuid',
      requestedByName: null,
      approverKey: 'PURCHASER',
      approverLabel: 'Purchaser',
      statusLabel: 'Requested',
    });
  });

  /* Owner 2026-09-24: 「为什么 ref 不会出现?每个 SO 都会有的」 — the column was
     blank on every cancellation row. It now resolves through customerRefOf, the
     SAME rule the amendment rows and the Sales Order list use, so one order
     cannot show two references. */
  it("shows the Sales Order's reference, by the Sales Order list's own rule", () => {
    const [withRef] = build([], [cancel({ doc_ref: 'MR TAN / SUNWAY', doc_customer_so_no: 'IGNORED' })]);
    expect(withRef!.reference).toBe('MR TAN / SUNWAY');
    const [fallback] = build([], [cancel({ doc_ref: null, doc_customer_so_no: 'CUST-PO-7' })]);
    expect(fallback!.reference).toBe('CUST-PO-7');
    const [neither] = build([], [cancel({ doc_ref: null, doc_customer_so_no: null })]);
    expect(neither!.reference).toBe('');
  });

  it('gives a cancellation the SO it names, so the row can open that order', () => {
    const [row] = build([], [cancel({ doc_key: 'HC-SO-000009', doc_number: 'HC-SO-000009' })]);
    expect(row!.cancel?.doc_key).toBe('HC-SO-000009');
    expect(row!.amendment).toBeNull();
  });
});
