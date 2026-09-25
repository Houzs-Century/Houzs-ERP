/* ----------------------------------------------------------------------------
   amendment-queue-rows — the ONE projection behind the SO Amendment queue, on
   the desktop grid and the phone list.

   THE OWNER, 2026-09-24: 「当有 SO request cancel bill - 需要在 SO amendment 出现」.
   A request to cancel a Sales Order is an approval waiting on the same desks the
   amendment queue already serves, and it used to live only on the document and
   in the separate Cancellation Requests inbox — so an approver had to watch two
   screens. It now shows as a row IN this queue. The Cancellation Requests inbox
   stays (it is also the PO's and the DO's record); this is a second window onto
   the same rows, never a second copy of them.

   A CANCELLATION IS NOT AN AMENDMENT and this module does not pretend it is:
   the two shapes stay their own types and are merged into one ROW shape for
   display, so nothing here can write an amendment's fields onto a cancellation
   or route one to the other's approve endpoint. What they share is the queue's
   questions — which order, whose desk, what state, how old.

   The sort is the amendment list's own (status-pill compareAmendmentsForList):
   what still needs an action first, newest first inside that.
   ---------------------------------------------------------------------------- */

import type { AmendmentRow } from './so-amendment-queries';
import {
  cancelRequestLine,
  docTypeOfRow,
  pendingLevel,
  type CancelRequestRow,
} from './document-cancel-queries';
import { AMENDMENT_APPROVER_LABEL, AMENDMENT_APPROVER_TONE, soAmendmentApprover } from './amendment-approver';
import { customerRefOf } from '../../../lib/customer-ref';
import { amendmentBucketOf, compareAmendmentsForList, simplifiedAmendmentPill, type AmendmentBucket } from './status-pill';

export type AmendmentQueueKind = 'AMENDMENT' | 'CANCEL';

export type AmendmentQueueRow = {
  /** Unique across both kinds — an amendment id and a request id are both uuids
   *  from different tables, so neither alone can key the merged list. */
  key: string;
  kind: AmendmentQueueKind;
  /** What the row is, in the queue's own words. */
  kindLabel: string;
  soDocNo: string;
  /** The SO's customer reference, by the Sales Order list's own rule — carried
   *  for BOTH kinds of row since the cancellation endpoint began sending it. */
  reference: string;
  /** "A3" for an amendment, the SO's number for a cancellation. */
  numberLabel: string;
  /** Whose signature it waits on, and the badge colour for it. `approverKey`
   *  is the amendment lane's approver enum, or CANCEL_L1 / CANCEL_L2 / CANCEL:
   *  it identifies the desk in the DOM and is never shown. */
  approverKey: string;
  approverLabel: string;
  approverTone: { bg: string; fg: string };
  /** Amendments name a scm.staff uuid the surface resolves through the roster;
   *  a cancellation carries the name the API already resolved. */
  requestedByStaffId: string | null;
  requestedByName: string | null;
  reason: string;
  /** Requested / Approved / Rejected — the queue's three chips. */
  bucket: AmendmentBucket;
  /** The precise state, for the status cell: an amendment's simplified pill
   *  word, a cancellation's "waiting for level-2 approval (1 of 2)" sentence. */
  statusLabel: string;
  createdAt: string | null;
  amendment: AmendmentRow | null;
  cancel: CancelRequestRow | null;
};

/** The cancellation status bucket. NOT amendmentBucketOf: that table knows
 *  nothing of L1_APPROVED / EXECUTED / WITHDRAWN and would file a withdrawn
 *  request under Requested — i.e. as something still on a desk. */
export const cancelBucketOf = (status: string | null | undefined): AmendmentBucket => {
  switch (String(status ?? '').toUpperCase()) {
    case 'REJECTED':
    case 'WITHDRAWN':
      return 'REJECTED';
    case 'APPROVED':
    case 'EXECUTED':
      return 'APPROVED';
    default:
      return 'REQUESTED';
  }
};

/** Red, not one of the approver blues: a cancellation is the destructive row in
 *  this queue and must never read as a fourth lane. */
export const CANCEL_TONE = { bg: 'rgba(184, 51, 31, 0.13)', fg: '#B8331F' };

/** Which desk a cancellation waits on — level 1 is the Sales Director, level 2
 *  the Purchaser (backend/src/scm/shared/document-cancel.ts CANCEL_APPROVE_KEY).
 *  Nothing is waiting once it is signed, refused or withdrawn. */
export const cancelApproverLabel = (row: Pick<CancelRequestRow, 'status'>): string => {
  const level = pendingLevel(row.status);
  if (level === 1) return 'Sales Director';
  if (level === 2) return 'Purchaser';
  return '—';
};

/** The same desk, for the DOM — never shown to anyone. */
export const cancelApproverKey = (row: Pick<CancelRequestRow, 'status'>): string => {
  const level = pendingLevel(row.status);
  return level == null ? 'CANCEL' : `CANCEL_L${level}`;
};

export const amendmentQueueRowOf = (a: AmendmentRow, reference: string): AmendmentQueueRow => ({
  key: `amendment:${a.id}`,
  kind: 'AMENDMENT',
  kindLabel: 'Amendment',
  soDocNo: a.so_doc_no,
  reference,
  numberLabel: String(a.amendment_no ?? '').trim() || '—',
  approverKey: soAmendmentApprover(a.lane),
  approverLabel: AMENDMENT_APPROVER_LABEL[soAmendmentApprover(a.lane)],
  approverTone: AMENDMENT_APPROVER_TONE[soAmendmentApprover(a.lane)],
  requestedByStaffId: a.requested_by ?? null,
  requestedByName: null,
  reason: (a.reason ?? '').trim(),
  bucket: amendmentBucketOf(a.status),
  statusLabel: simplifiedAmendmentPill(a.status).label,
  createdAt: a.created_at ?? null,
  amendment: a,
  cancel: null,
});

/** The customer reference of the order behind a cancellation request (the
 *  server sends the raw pair for SO rows and for a DO's order). */
export const cancelRequestReferenceOf = (r: Pick<CancelRequestRow, 'doc_ref' | 'doc_customer_so_no'>): string =>
  customerRefOf({ ref: r.doc_ref ?? null, customer_so_no: r.doc_customer_so_no ?? null });

export const cancelQueueRowOf = (r: CancelRequestRow): AmendmentQueueRow => ({
  key: `cancel:${r.id}`,
  kind: 'CANCEL',
  kindLabel: 'Cancellation',
  soDocNo: r.doc_number || r.doc_key,
  reference: cancelRequestReferenceOf(r),
  numberLabel: 'Cancel',
  approverKey: cancelApproverKey(r),
  approverLabel: cancelApproverLabel(r),
  approverTone: CANCEL_TONE,
  requestedByStaffId: null,
  requestedByName: r.requested_by_name ?? null,
  reason: r.reason.trim(),
  bucket: cancelBucketOf(r.status),
  statusLabel: cancelRequestLine(r),
  createdAt: r.requested_at,
  amendment: null,
  cancel: r,
});

const ORDER = compareAmendmentsForList<AmendmentQueueRow>((r) => r.bucket, (r) => r.createdAt);

/**
 * The merged queue. `referenceOf` resolves an amendment's customer reference
 * (the surfaces already own that rule); cancellation rows carry none, since the
 * inbox endpoint sends the document's number and nothing else about the SO.
 *
 * Only SALES ORDER cancellations belong here — a PO or DO cancellation has
 * nothing to do with the SO amendment desks and stays in its own inbox.
 */
export function buildAmendmentQueueRows(
  amendments: readonly AmendmentRow[],
  cancelRequests: readonly CancelRequestRow[],
  referenceOf: (a: AmendmentRow) => string,
): AmendmentQueueRow[] {
  const rows = [
    ...amendments.map((a) => amendmentQueueRowOf(a, referenceOf(a))),
    ...cancelRequests.filter((r) => docTypeOfRow(r) === 'so').map(cancelQueueRowOf),
  ];
  return rows.sort(ORDER);
}
