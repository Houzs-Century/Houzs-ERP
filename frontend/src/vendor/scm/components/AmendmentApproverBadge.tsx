// The approver badge on the SO + PO amendment queues. Word and colour come from
// lib/amendment-approver.ts (shared with the phone); the pill shape is
// StatusPill's, so the row reads as one family.

import { AMENDMENT_APPROVER_LABEL, AMENDMENT_APPROVER_TONE, type AmendmentApprover } from '../lib/amendment-approver';
import styles from './StatusPill.module.css';

export function AmendmentApproverBadge({ approver }: { approver: AmendmentApprover }) {
  const { bg, fg } = AMENDMENT_APPROVER_TONE[approver];
  return (
    <span className={styles.pill} style={{ background: bg, color: fg }} data-approver={approver}>
      {AMENDMENT_APPROVER_LABEL[approver]}
    </span>
  );
}
