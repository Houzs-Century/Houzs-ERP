/* AuditHistoryPanel — the reusable "who changed what, when" drawer.

   Stage 1 of the system-wide audit trail. This is the Sales Order History
   drawer lifted out of SalesOrderDetail.tsx unchanged in appearance; the only
   difference is that the entity's vocabulary (action + field labels, money
   fields, status pill) now arrives as props instead of being hardcoded.

   The panel is read-only by construction: it renders entries and offers no
   edit or delete affordance, which is what the append-only requirement needs
   from the view layer. Fetching stays with the caller so each module keeps its
   own query key and permission gate. */

import { memo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { History, X, ChevronDown, ChevronRight } from 'lucide-react';
import { fmtCenti, fmtDate, fmtDateTime } from '@2990s/shared';
import { Button } from '../Button';
import {
  auditActionLabel,
  auditFieldLabel,
  type AuditFieldChange,
  type AuditLabelDictionary,
  type AuditLogEntry,
} from './audit-labels';
import styles from './AuditHistoryPanel.module.css';

const SM_ICON = { size: 14, strokeWidth: 1.75 } as const;

const fmtValue = (field: string, val: unknown, dict: AuditLabelDictionary): string => {
  if (val === null || val === undefined || val === '') return '—';
  if (dict.moneyFields?.has(field) && typeof val === 'number') return fmtCenti(val);
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val).replace(/_/g, ' ');
};

const hashHue = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
};

const initialsFor = (name: string | null): string => {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0] ?? '';
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? '';
  return ((first[0] ?? '') + (last[0] ?? '')).toUpperCase();
};

const relTime = (iso: string): string => {
  const then = new Date(iso).getTime();
  const diffMs = Date.now() - then;
  const m = Math.round(diffMs / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d}d ago`;
  return fmtDate(iso);
};

export type AuditHistoryPanelProps = {
  /* Identifies the record in the drawer title, e.g. the SO doc no. */
  recordLabel: string;
  /* Entity name for the dialog's accessible label, e.g. "Sales order". */
  entityName: string;
  entries: AuditLogEntry[];
  isLoading?: boolean;
  labels: AuditLabelDictionary;
  onClose: () => void;
  /* Optional per-entry badge, e.g. the SO status pill on a status change.
     Returning null renders nothing. */
  renderBadge?: (entry: AuditLogEntry, changes: AuditFieldChange[]) => ReactNode;
};

/* Memoized: once opened, expanding an entry changes internal state that would
   otherwise re-render the whole host page. Callers should keep onClose stable. */
export const AuditHistoryPanel = memo(({
  recordLabel,
  entityName,
  entries,
  isLoading = false,
  labels,
  onClose,
  renderBadge,
}: AuditHistoryPanelProps) => {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  /* Portal-anchored to <body> so the drawer's `position: fixed` latches to the
     VIEWPORT. Rendered in place it did not: Layout wraps every page in
     <PullToRefresh className="… animate-rise">, whose content div carries BOTH an
     inline `transform: translateY(0px)` and the filled `rise` animation — and a
     transform other than `none` makes an element the containing block for its
     fixed descendants. The drawer therefore anchored to the page content box
     instead of the screen: it parked over the sticky PageHeader, scrolled away
     with the page, and its inset:0 backdrop dimmed only the content box. Same
     hazard ModalOverlay's portal already documents. */
  return createPortal(
    <>
      <div className={styles.historyBackdrop} onClick={onClose} />
      <aside className={styles.historyPanel} role="dialog" aria-label={`${entityName} history`}>
        <header className={styles.historyPanelHead}>
          <h3 className={styles.historyPanelTitle}>
            <History {...SM_ICON} />
            History · {recordLabel}
            <span className={styles.historyPanelCount}>
              ({entries.length})
            </span>
          </h3>
          <Button variant="ghost" onClick={onClose}>
            <X {...SM_ICON} />
          </Button>
        </header>
        <div className={styles.historyPanelBody}>
          {isLoading ? (
            <p className={styles.historyLoading}>Loading…</p>
          ) : entries.length === 0 ? (
            <p className={styles.historyEmpty}>
              No history yet.
            </p>
          ) : (
            entries.map((e) => {
              const name = e.actor_name_snapshot ?? '(unknown)';
              const hue = hashHue(name);
              const fc: AuditFieldChange[] = Array.isArray(e.field_changes) ? e.field_changes : [];
              const key = String(e.id);
              const isExpanded = !!expanded[key];
              const label = auditActionLabel(e.action, labels);
              const badge = renderBadge?.(e, fc) ?? null;
              return (
                <div key={key} className={styles.historyItem}>
                  <span
                    className={styles.historyAvatar}
                    style={{ background: `hsl(${hue}, 50%, 60%)` }}
                    aria-hidden
                  >
                    {initialsFor(name)}
                  </span>
                  <div>
                    <div className={styles.historyLine}>
                      <span className={styles.historyActor}>{name}</span>
                      {' performed '}
                      <strong>{label}</strong>
                      {badge}
                    </div>
                    <div className={styles.historyMeta}>
                      {fmtDateTime(e.created_at)}
                      {' · '}{relTime(e.created_at)}
                      {e.source ? ` · via ${e.source}` : ''}
                    </div>
                    {e.note && (
                      <div className={`${styles.historyMeta} ${styles.historyNote}`}>
                        “{e.note}”
                      </div>
                    )}
                    {fc.length > 0 && (
                      <>
                        <button
                          type="button"
                          className={styles.historyChangesBtn}
                          onClick={() => setExpanded((s) => ({ ...s, [key]: !s[key] }))}
                        >
                          {isExpanded ? <ChevronDown size={12} strokeWidth={1.75} /> : <ChevronRight size={12} strokeWidth={1.75} />}
                          {' '}Changes ({fc.length})
                        </button>
                        {isExpanded && (
                          <div className={styles.historyChanges}>
                            {fc.map((ch, idx) => (
                              <div key={idx} className={styles.historyChange}>
                                <span className={styles.historyChangeField}>
                                  {auditFieldLabel(ch.field, labels)}
                                </span>
                                <span className={styles.historyChangeDiff}>
                                  {ch.from !== undefined && ch.from !== null && ch.from !== '' ? (
                                    <>
                                      <span className={styles.historyChangeFrom}>{fmtValue(ch.field, ch.from, labels)}</span>
                                      <span className={styles.historyChangeArrow}>→</span>
                                    </>
                                  ) : null}
                                  <span>{fmtValue(ch.field, ch.to, labels)}</span>
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </aside>
    </>,
    document.body,
  );
});
AuditHistoryPanel.displayName = 'AuditHistoryPanel';
