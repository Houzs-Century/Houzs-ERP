
import { memo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { History, X, ChevronDown, ChevronRight } from 'lucide-react';
import { fmtDate, fmtDateTime } from '@2990s/shared';
import { Button } from '../Button';
import {
  auditActionLabel,
  auditFieldLabel,
  type AuditFieldChange,
  type AuditLabelDictionary,
  type AuditLogEntry,
} from './audit-labels';
import { auditValueShown, auditValueText } from './audit-value';
import styles from './AuditHistoryPanel.module.css';

const SM_ICON = { size: 14, strokeWidth: 1.75 } as const;

const AuditValue = ({ field, val, label, dict, className }: { field: string; val: unknown; label: string | undefined; dict: AuditLabelDictionary; className?: string }) => {
  const full = label ?? auditValueText(field, val, dict);
  const shown = auditValueShown(full);
  return <span className={className} title={shown === full ? undefined : full}>{shown}</span>;
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

const reasonOf = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  const s = typeof error === 'string' ? error : String(error ?? '');
  return s && s !== '[object Object]' ? s : 'no reason given';
};

export type AuditHistoryPanelProps = {
  recordLabel: string;
  entityName: string;
  entries: AuditLogEntry[];
  isLoading?: boolean;
  error?: unknown;
  labels: AuditLabelDictionary;
  labelsFor?: (entry: AuditLogEntry) => AuditLabelDictionary;
  onClose: () => void;
  renderBadge?: (entry: AuditLogEntry, changes: AuditFieldChange[]) => ReactNode;
};

export const AuditHistoryPanel = memo(({
  recordLabel,
  entityName,
  entries,
  isLoading = false,
  error = null,
  labels,
  labelsFor,
  onClose,
  renderBadge,
}: AuditHistoryPanelProps) => {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

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
          {error ? (
            <p className={styles.historyError}>
              This change log could not be loaded, so what you see here is not
              proof that nothing was changed. Try again in a moment; if it keeps
              failing, send this to IT: <span className={styles.historyErrorReason}>{reasonOf(error)}</span>
            </p>
          ) : isLoading ? (
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
              const dict = labelsFor?.(e) ?? labels;
              const label = auditActionLabel(e.action, dict);
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
                                  {auditFieldLabel(ch.field, dict)}
                                </span>
                                <span className={styles.historyChangeDiff}>
                                  {ch.from !== undefined && ch.from !== null && ch.from !== '' ? (
                                    <>
                                      <AuditValue className={styles.historyChangeFrom} field={ch.field} val={ch.from} label={ch.from_label} dict={dict} />
                                      <span className={styles.historyChangeArrow}>→</span>
                                    </>
                                  ) : null}
                                  <AuditValue field={ch.field} val={ch.to} label={ch.to_label} dict={dict} />
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
