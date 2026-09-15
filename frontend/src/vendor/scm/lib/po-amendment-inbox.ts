// ----------------------------------------------------------------------------
// The PO revision inbox — which rows the PO Amendments queue lists, from BOTH
// flows, for the desktop queue (pages/scm-v2/PoAmendments.tsx) and the phone
// queue (mobile/MobilePoAmendments.tsx) alike:
//   · every direct po_amendments row (raised from a PO), and
//   · every SO amendment that revises a BOUND PO (owner 2026-07-27, "这个应该
//     出现在 PO Amendment") — once the SO side approves, purchasing must revise
//     and re-send that PO, so the row belongs in purchasing's queue too.
// The rule used to live inside the desktop page (#1347), so the phone queue
// never got the second kind (docs/bugs/0924-the-phone-po-amendments-queue-left-out-every-so-amendment-th.md).
// ----------------------------------------------------------------------------

import type { PoAmendmentRow } from './po-amendment-queries';
import type { AmendmentRow } from './so-amendment-queries';
import { PO_AMENDMENT_APPROVER, soAmendmentApprover, type AmendmentApprover } from './amendment-approver';

/* `id` belongs to the row's OWN table, so it opens in its own module; `key` is
   unique across the merged set. `soDocNo` is the order an SO-driven row revises:
   the phone opens that order, whose page hosts the amendment gates. */
type InboxRowBase = {
  key: string;
  id: string;
  poLabel: string;
  amendmentNo: string;
  approver: AmendmentApprover;
  requestedBy: string | null;
  reason: string | null;
  status: string;
  createdAt: string | null;
};

export type PoAmendmentInboxRow =
  | (InboxRowBase & { kind: 'po'; soDocNo: null })
  | (InboxRowBase & { kind: 'so'; soDocNo: string });

export const PO_AMENDMENT_INBOX_SOURCE_LABEL: Record<PoAmendmentInboxRow['kind'], string> = {
  po: 'PO amendment',
  so: 'From SO amendment',
};

export function buildPoAmendmentInbox(
  direct: readonly PoAmendmentRow[],
  soAmendments: readonly AmendmentRow[],
): PoAmendmentInboxRow[] {
  const directRows = direct.map((a): PoAmendmentInboxRow => ({
    key: `po:${a.id}`,
    kind: 'po',
    id: a.id,
    soDocNo: null,
    poLabel: a.po_number,
    amendmentNo: String(a.amendment_no ?? ''),
    approver: PO_AMENDMENT_APPROVER,
    requestedBy: a.requested_by ?? null,
    reason: a.reason ?? null,
    status: a.status,
    createdAt: a.created_at ?? null,
  }));
  /* A bound PO is resolved by the list endpoint through
     purchase_order_items.so_item_id; a pure-sales amendment (no purchase leg)
     stays in the SO queue only.

     The DELIVERY lane is left out: a delivery/customer-side change (schedule,
     address, or a service line — disposal / storage / transport) never revises a
     PO, even when its order has a bound PO for its product lines (owner
     2026-09-11, docs/bugs/0816-a-bare-code-service-line-dispose-storage-transportation-char.md).
     Legacy rows (lane null — before the two-lane rework) keep the old PO leg and
     stay. */
  const soDriven = soAmendments
    .filter((a) => (a.bound_pos?.length ?? 0) > 0 && a.lane !== 'DELIVERY')
    .map((a): PoAmendmentInboxRow => ({
      key: `so:${a.id}`,
      kind: 'so',
      id: a.id,
      soDocNo: a.so_doc_no,
      poLabel: (a.bound_pos ?? []).map((p) => p.po_number).join(', '),
      amendmentNo: String(a.amendment_no ?? ''),
      approver: soAmendmentApprover(a.lane),
      requestedBy: a.requested_by ?? null,
      reason: a.reason ?? null,
      status: a.status,
      createdAt: a.created_at ?? null,
    }));
  return [...directRows, ...soDriven];
}
