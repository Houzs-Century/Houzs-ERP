// ----------------------------------------------------------------------------
// PvLineEventCell — a voucher line's event on the detail page's read-only table,
// with Finance's pencil to change it (owner 2026-09-30, 5a). A voucher is locked
// from Check on and an approved one cannot be edited at all; the event is not
// money, so it changes in place — the server moves the line and its journal leg
// together (POST /acc-events/pv-lines/:lineId/event) and writes the history.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { Pencil, X } from 'lucide-react';
import { EventSelect, eventCellText } from '../../vendor/scm/components/EventSelect';
import { useRetagPvLine, type EventOption } from '../../vendor/scm/lib/event-queries';

export function PvLineEventCell({
  lineId,
  projectId,
  labels,
  around,
  canChange,
}: {
  lineId: string;
  projectId: number | null;
  labels: Map<number, EventOption> | undefined;
  around: string | null;
  canChange: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const retag = useRetagPvLine();
  if (editing) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 260 }}>
        <EventSelect
          value={projectId}
          around={around}
          aria-label="Change this line's event"
          disabled={retag.isPending}
          onChange={(v) => { if (v !== projectId) retag.mutate({ lineId, projectId: v }, { onSettled: () => setEditing(false) }); else setEditing(false); }}
        />
        <button type="button" onClick={() => setEditing(false)} title="Keep the event as it is" aria-label="Keep the event as it is"
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--fg-muted)', padding: 2, display: 'inline-flex' }}>
          <X size={14} strokeWidth={1.75} />
        </button>
      </span>
    );
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={{ color: projectId == null ? 'var(--fg-muted)' : undefined }}>{eventCellText(labels, projectId)}</span>
      {canChange && (
        <button type="button" onClick={() => setEditing(true)} title="Change the event" aria-label="Change the event"
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--c-orange)', padding: 2, display: 'inline-flex' }}>
          <Pencil size={12} strokeWidth={1.75} />
        </button>
      )}
    </span>
  );
}
