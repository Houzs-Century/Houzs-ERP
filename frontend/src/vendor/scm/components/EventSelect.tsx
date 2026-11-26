
import { useMemo } from 'react';
import { SearchCombo, type ComboOption } from './SearchCombo';
import { eventLabel, useEventLabels, useEventOptions, type EventOption, type EventOptionsPath } from '../lib/event-queries';

const monthOf = (e: EventOption): string => (/^\d{4}-\d{2}/.test(e.startDate ?? '') ? String(e.startDate).slice(0, 7) : 'No date');

export function EventSelect({
  value,
  onChange,
  around,
  className,
  placeholder = '— No event —',
  disabled,
  optionsPath,
  'aria-label': ariaLabel,
}: {
  value: number | null;
  onChange: (projectId: number | null) => void;
  around: string | null;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  optionsPath?: EventOptionsPath;
  'aria-label'?: string;
}) {
  const list = useEventOptions(around, !disabled, optionsPath);
  const inList = value != null && (list.data ?? []).some((e) => e.id === value);
  const labels = useEventLabels(value != null && !inList ? [value] : [], optionsPath);

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
