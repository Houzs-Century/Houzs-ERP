// ----------------------------------------------------------------------------
// EventSelect — the event a voucher / AP invoice line's money is for (owner
// 2026-09-29/30, 5a). A SearchCombo over the company's events around the
// document's date, grouped by month; type any word of the name, venue,
// organizer, brand or booth to find one. Value in / value out: an event id,
// or null for "no event". An event already on the line but outside the window
// (or archived since) is fetched by id so the field never reads blank.
// ----------------------------------------------------------------------------

import { useMemo } from 'react';
import { SearchCombo, type ComboOption } from './SearchCombo';
import { eventLabel, useEventLabels, useEventOptions, type EventOption } from '../lib/event-queries';

/* Grouped by the month the event starts, read as the ISO word the data carries
   (2026-09) — no month-name table (the house date rule, check-date-formatting). */
const monthOf = (e: EventOption): string => (/^\d{4}-\d{2}/.test(e.startDate ?? '') ? String(e.startDate).slice(0, 7) : 'No date');

export function EventSelect({
  value,
  onChange,
  around,
  className,
  placeholder = '— No event —',
  disabled,
  'aria-label': ariaLabel,
}: {
  value: number | null;
  onChange: (projectId: number | null) => void;
  /** The document's date (YYYY-MM-DD) the list is centred on; null = today. */
  around: string | null;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  'aria-label'?: string;
}) {
  const list = useEventOptions(around, !disabled);
  const inList = value != null && (list.data ?? []).some((e) => e.id === value);
  const labels = useEventLabels(value != null && !inList ? [value] : []);

  const options = useMemo<ComboOption[]>(() => {
    const seen = new Set<number>();
    const events: EventOption[] = [];
    for (const e of [...(list.data ?? []), ...(labels.data ? [...labels.data.values()] : [])]) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      events.push(e);
    }
    return [
      { value: '', label: '— No event —' },
      ...events.map((e) => ({ value: String(e.id), label: eventLabel(e), group: monthOf(e) })),
    ];
  }, [list.data, labels.data]);

  return (
    <SearchCombo
      options={options}
      value={value == null ? '' : String(value)}
      onChange={(v) => onChange(v ? Number(v) : null)}
      className={className}
      placeholder={list.isLoading ? 'Loading events…' : placeholder}
      disabled={disabled}
      aria-label={ariaLabel}
    />
  );
}

/** One event's label for a read-only table cell, from a labels map. */
export function eventCellText(labels: Map<number, EventOption> | undefined, id: number | null | undefined): string {
  if (id == null) return '—';
  const e = labels?.get(Number(id));
  return e ? eventLabel(e) : `Event #${id}`;
}
