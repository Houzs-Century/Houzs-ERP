// The approver badge on the SO + PO amendment queues. Word and colour come from
// lib/amendment-approver.ts (shared with the phone); the pill shape is
// StatusPill's, so the row reads as one family.

import { AMENDMENT_APPROVER_LABEL, AMENDMENT_APPROVER_TONE, type AmendmentApprover } from '../lib/amendment-approver';
import styles from './StatusPill.module.css';

export function AmendmentApproverBadge({ approver }: { approver: AmendmentApprover }) {
  return (
    <QueueApproverBadge approverKey={approver} label={AMENDMENT_APPROVER_LABEL[approver]} tone={AMENDMENT_APPROVER_TONE[approver]} />
  );
}

/** The same badge for a desk that is NOT an amendment lane — a cancellation
 *  request waits on the Sales Director, then the Purchaser, and it shares this
 *  queue since owner 2026-09-24. Keyed the same way (`data-approver`) so one
 *  selector still reads whose row it is. */
export function QueueApproverBadge({ approverKey, label, tone }: { approverKey: string; label: string; tone: { bg: string; fg: string } }) {
  return (
    <span className={styles.pill} style={{ background: tone.bg, color: tone.fg }} data-approver={approverKey}>
      {label}
    </span>
  );
}
