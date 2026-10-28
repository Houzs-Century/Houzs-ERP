/* EntityHistoryPanel — the one History drawer binding for every SCM document
   recorded in scm.entity_audit_log.

   SalesOrderDetail has its own binding because the SO reads a different table
   (mfg_so_audit_log) and overlays a lifecycle-resolved status. The four
   documents here all read ONE endpoint with ONE row shape, so they share ONE
   binding and differ only in the props below — a per-page copy of this file
   would be four places to fix the next time the drawer changes.

   It lives under pages/scm-v2 rather than components/audit on purpose:
   AuditHistoryPanel is entity-agnostic and imports nothing from vendor/scm,
   and this binding depends on both the SCM query layer and the SCM StatusPill.

   Not exported through a barrel and not lazy-loaded: it is mounted only while
   the drawer is open, so it costs nothing until clicked. */

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
  /* The header row's UUID. The log is keyed on the id, NOT the doc number —
     passing the doc number here returns an empty history that looks real. */
  entityId: string;
  /* Human document number, shown in the drawer title. */
  recordLabel: string;
  /* Entity name for the dialog's accessible label, e.g. "Payment voucher". */
  entityName: string;
  labels: AuditLabelDictionary;
  /* Which StatusPill vocabulary to render a status change with. */
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
  /* `?? []` is safe ONLY because q.error is passed through below. On its own it
     turns a server refusal into "No history yet.", which on an audit trail reads
     as "nobody touched this document" — observed on staging 2026-09-13 against a
     500 saying "permission denied for table entity_audit_log". */
  const entries = (q.data ?? []) as AuditLogEntry[];

  /* Mirrors the SO drawer's pill so a status change is scannable without
     expanding the entry. Driven off the `status` field change rather than the
     row's status_snapshot: the snapshot is the document's state at write time,
     which on a multi-row action (CANCEL then REVERSE) repeats the same value on
     entries that did not themselves change the status. */
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
