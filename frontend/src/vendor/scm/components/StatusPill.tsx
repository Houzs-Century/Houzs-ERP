
import { resolveStatusPill, simplifiedAmendmentPill, STATUS_TONES, type StatusDocType } from '../../../../../shared/src/vendor/scm/lib/status-pill';
import styles from './StatusPill.module.css';

export type StatusPillProps = {
  docType: StatusDocType;
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

/** The same badge with the words chosen by the caller — for a row whose state
 *  is a SENTENCE rather than an enum (a cancellation request says which
 *  signature it is waiting for), while its TONE still comes from the three
 *  amendment buckets so the queue reads as one list. */
export function TonedPill({ label, tone, className }: { label: string; tone: keyof typeof STATUS_TONES; className?: string }) {
  const { bg, fg } = STATUS_TONES[tone];
  return (
    <span className={`${styles.pill} ${className ?? ''}`} style={{ background: bg, color: fg }}>
      {label}
    </span>
  );
}
