import { History } from 'lucide-react';

/** History tab — the date-range / per-lorry / per-day delivered view. Its data
 *  is a new backend read (the history feed) scheduled for a later update; the
 *  tab is present now so the four-tab shell is complete. */
export function HistoryTab() {
  return (
    <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-border bg-surface p-10 text-center">
      <History size={22} strokeWidth={1.5} className="text-ink-muted" />
      <div className="text-[13px] font-semibold text-ink">Delivery history is coming</div>
      <p className="max-w-md text-[12.5px] text-ink-muted">
        A date-range view of past deliveries — grouped by day, filterable by lorry — arrives with the history feed. For now, pick a past date in the stepper to see that day's runs on the Lorries tab.
      </p>
    </div>
  );
}
