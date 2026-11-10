import { useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from "lucide-react";
import { api } from "../../api/client";
import { useQuery } from "../../hooks/useQuery";
import { useDebouncedValue } from "../../vendor/scm/lib/hooks";
import { cn } from "../../lib/utils";
import { STATUS_BY_VALUE } from "./projectStatus";
import type { ProjectStatus } from "./types";
import {
  type CalendarMatch,
  type CalendarSearchResult,
  calendarSearchPath,
  matchDateRange,
  matchLabel,
} from "./calendarSearch";

export interface CalendarSearchFilters {
  q: string;
  brand: string;
  status: string;
  organizer: string;
}

export const hasCalendarSearch = (f: CalendarSearchFilters) =>
  !!(f.q.trim() || f.brand || f.status || f.organizer);

/**
 * Every event matching the calendar's search + filters across ALL dates.
 * Debounced so typing "sccc" is one request, not four. Off while nothing is set.
 */
export function useCalendarSearch(filters: CalendarSearchFilters, enabled: boolean) {
  const path = calendarSearchPath(filters);
  const settledPath = useDebouncedValue(path, 250);
  const active = enabled && hasCalendarSearch(filters);
  const q = useQuery<CalendarSearchResult>(
    "/api/projects/calendar/search",
    () => api.get(settledPath),
    [settledPath],
    { enabled: active },
  );
  const settled = settledPath === path;
  return {
    active,
    // A result for an older search term is never shown as this term's answer.
    result: active && settled && !q.loading ? q.data : null,
    loading: active && (!settled || q.loading),
    error: active ? q.error : null,
  };
}

const statusHex = (s: string | null) =>
  STATUS_BY_VALUE[(s ?? "").toLowerCase() as ProjectStatus]?.hex ?? "#5a6b7a";

/**
 * "N events match 'sccc'" + Previous / Next match + the full list of matches.
 * The list expands inline under the strip, so it works the same at phone width.
 */
export function CalendarSearchStrip({
  label,
  result,
  loading,
  error,
  prev,
  next,
  focusedId,
  onJump,
}: {
  /** What was searched, already quoted: "'sccc'" or "the filters". */
  label: string;
  result: CalendarSearchResult | null;
  loading: boolean;
  error: string | null;
  prev: CalendarMatch | null;
  next: CalendarMatch | null;
  focusedId: number | null;
  onJump: (m: CalendarMatch) => void;
}) {
  const [open, setOpen] = useState(false);

  if (error) {
    return (
      <div role="alert" className="mb-2 rounded-md border border-err/40 bg-err/5 px-3 py-2 text-[12px] text-err">
        Could not search all dates: {error}
      </div>
    );
  }
  if (!result) {
    if (!loading) return null;
    return (
      <div role="status" className="mb-2 rounded-md border border-border bg-surface px-3 py-2 text-[12px] text-ink-muted">
        Searching all dates for {label}…
      </div>
    );
  }
  if (result.total === 0) {
    return (
      <div
        role="status"
        className="mb-2 rounded-md border border-border bg-surface px-4 py-8 text-center text-[13px] font-semibold text-ink-secondary"
      >
        No events match {label}
      </div>
    );
  }

  const btn =
    "inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface px-2 text-[11px] font-semibold text-ink-secondary transition-colors hover:border-primary/40 hover:text-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:text-ink-secondary";
  return (
    <div className="mb-2 rounded-md border border-primary/30 bg-primary-soft/40 px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span role="status" className="w-full text-[12px] font-semibold text-ink sm:mr-auto sm:w-auto">
          {result.total} {result.total === 1 ? "event matches" : "events match"} {label}
        </span>
        <button
          type="button"
          className={btn}
          disabled={!prev}
          onClick={() => prev && onJump(prev)}
          title={prev ? `${matchDateRange(prev)} · ${matchLabel(prev)}` : "No earlier match"}
        >
          <ChevronLeft size={13} /> Previous match
        </button>
        <button
          type="button"
          className={btn}
          disabled={!next}
          onClick={() => next && onJump(next)}
          title={next ? `${matchDateRange(next)} · ${matchLabel(next)}` : "No later match"}
        >
          Next match <ChevronRight size={13} />
        </button>
        <button type="button" className={btn} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          All matches {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
      </div>
      {result.truncated && (
        <div className="mt-1 text-[11px] text-ink-muted">
          Showing the first {result.matches.length} of {result.total} matches (by date). Narrow the search to see the rest.
        </div>
      )}
      {open && (
        <ul
          aria-label="All matching events"
          className="mt-1.5 max-h-72 overflow-y-auto rounded-md border border-border bg-surface"
        >
          {result.matches.map((m) => (
            <li key={m.id} className="border-b border-border-subtle last:border-b-0">
              <button
                type="button"
                onClick={() => onJump(m)}
                className={cn(
                  "flex w-full items-start gap-2 px-2.5 py-1.5 text-left text-[11.5px] hover:bg-bg/60",
                  m.id === focusedId && "bg-accent-soft/50",
                )}
              >
                <span
                  className="mt-1 h-2 w-2 shrink-0 rounded-full"
                  style={{ background: statusHex(m.status) }}
                  title={m.status ?? undefined}
                  aria-label={m.status ?? undefined}
                />
                <span className="w-[150px] shrink-0 tabular-nums text-ink-muted max-sm:w-[78px]">
                  {matchDateRange(m)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold text-ink [overflow-wrap:anywhere]">{matchLabel(m)}</span>
                  {m.venue && <span className="block text-ink-muted [overflow-wrap:anywhere]">{m.venue}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
