// ----------------------------------------------------------------------------
// EventSuggestions — the events a scanned bill points at (owner 2026-09-30:
// ocr 要有办法 detect 相关的 event; 6a — SUGGEST, never bind). The reader reads
// what the bill prints; the server matches it (backend scm/lib/event-match.ts)
// and says why — booth, venue, organiser, same days, brand. Nothing is set
// until a person presses Use, which puts that event on every line.
// ----------------------------------------------------------------------------

import { eventLabel, type EventSuggestion } from '../lib/event-queries';

export function EventSuggestions({ suggestions, current, onUse }: {
  suggestions: EventSuggestion[] | undefined;
  /** The event the lines already share — its row reads "in use" instead of a button. */
  current: number | null;
  onUse: (projectId: number) => void;
}) {
  if (!suggestions || suggestions.length === 0) return null;
  return (
    <div role="note" aria-label="Events the bill names"
      style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 10px', borderRadius: 8, border: '1px dashed var(--c-orange)', fontSize: 'var(--fs-12)' }}>
      <span style={{ color: 'var(--fg-muted)' }}>The bill names an event — use one if it is right:</span>
      {suggestions.map((s) => (
        <span key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600 }}>{eventLabel(s.event)}</span>
          <span style={{ color: 'var(--fg-muted)' }}>({s.reasons.join(' · ')})</span>
          {current === s.id
            ? <span style={{ color: 'var(--c-green, #2f7d32)', fontWeight: 600 }}>✓ in use</span>
            : (
              <button type="button" onClick={() => onUse(s.id)} aria-label={`Use ${s.event.name}`}
                style={{ border: '1px solid var(--c-orange)', background: 'transparent', color: 'var(--c-orange)', borderRadius: 999, padding: '1px 10px', cursor: 'pointer', fontSize: 'var(--fs-12)' }}>
                Use
              </button>
            )}
        </span>
      ))}
    </div>
  );
}
