
import { memo, useCallback } from 'react';
import { AuditHistoryPanel } from '../../components/audit/AuditHistoryPanel';
import type {
  AuditFieldChange,
  AuditLabelDictionary,
  AuditLogEntry,
} from '../../components/audit/audit-labels';
import {
  useEntityAuditLog,
  type AuditEntityType,
} from '../../vendor/scm/lib/entity-audit-queries';
import { StatusPill } from '../../vendor/scm/components/StatusPill';
import type { StatusDocType } from '../../vendor/scm/lib/status-pill';

export type EntityHistoryPanelProps = {
  entityType: AuditEntityType;
  entityId: string;
  recordLabel: string;
  entityName: string;
  labels: AuditLabelDictionary;
  statusDocType: StatusDocType;
  onClose: () => void;
};

export const EntityHistoryPanel = memo(({
  entityType,
  entityId,
  recordLabel,
  entityName,
  labels,
  statusDocType,
  onClose,
}: EntityHistoryPanelProps) => {
  const q = useEntityAuditLog(entityType, entityId);
  const entries = (q.data ?? []) as AuditLogEntry[];

  const renderBadge = useCallback((entry: AuditLogEntry, changes: AuditFieldChange[]) => {
    const to = changes.find((f) => f.field === 'status')?.to;
    if (typeof to !== 'string' || !to) return null;
    return <StatusPill docType={statusDocType} status={to} />;
  }, [statusDocType]);

  return (
    <AuditHistoryPanel
      recordLabel={recordLabel}
      entityName={entityName}
      entries={entries}
      isLoading={q.isLoading}
      error={q.error}
      labels={labels}
      onClose={onClose}
      renderBadge={renderBadge}
    />
  );
});
EntityHistoryPanel.displayName = 'EntityHistoryPanel';
