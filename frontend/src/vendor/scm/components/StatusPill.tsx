// StatusPill — the ONE status badge for every ERP document type. Backed by the
// canonical map in lib/status-pill.ts so a status looks + reads identically on
// every list, detail and drill-down. Replaces the per-page STATUS_COLOR /
// STATUS_CLASS / STATUS_LABEL / inline .statusPill copies.

import { resolveStatusPill, simplifiedAmendmentPill, STATUS_TONES, type StatusDocType } from '../lib/status-pill';
import styles from './StatusPill.module.css';

export type StatusPillProps = {
  docType: StatusDocType;
  /** Raw enum status. For SO/DO/SI, pass the already-resolved EFFECTIVE status
      (after the soStatusDisplay / doEffectiveKey lifecycle overlay). */
  status: string | null | undefined;
  className?: string;
};

export function StatusPill({ docType, status, className }: StatusPillProps) {
  const { label, tone } = resolveStatusPill(docType, status);
  const { bg, fg } = STATUS_TONES[tone];
  return (
    <span className={`${styles.pill} ${className ?? ''}`} style={{ background: bg, color: fg }}>
      {label}
    </span>
  );
}

/** The SIMPLIFIED amendment badge for the SO + PO amendment LIST surfaces — one
 *  of exactly Requested / Approved / Rejected, collapsing the granular backend
 *  status (see simplifiedAmendmentPill). Same shape + tones as StatusPill so the
 *  queues read identically. */
export function AmendmentStatusPill({ status, className }: { status: string | null | undefined; className?: string }) {
  const { label, tone } = simplifiedAmendmentPill(status);
  const { bg, fg } = STATUS_TONES[tone];
  return (
    <span className={`${styles.pill} ${className ?? ''}`} style={{ background: bg, color: fg }}>
      {label}
    </span>
  );
}
