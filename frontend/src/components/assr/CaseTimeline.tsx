import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Clock, Paperclip, Plus, Trash2 } from "lucide-react";
import {
  buildCaseTimeline,
  type TimelineActivity,
  type TimelineFilter,
  type TimelineRow,
  type TimelineTone,
} from "../../vendor/scm/lib/assr/timeline";
import { fmtDate, fmtTime } from "../../vendor/shared/format";
import { cn } from "../../lib/utils";

export interface CaseTimelineProps {
  activity: readonly TimelineActivity[];
  salesAgent: string | null;
  userNames: ReadonlyMap<string, string>;
  canEdit: boolean;
  composer: ReactNode;
  onAddUpdate: () => void;
  onArchive: (activityId: number) => void;
}

const FILTERS: ReadonlyArray<{ value: TimelineFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "system", label: "System" },
  { value: "service", label: "Service" },
  { value: "customer", label: "Customer" },
  { value: "supplier", label: "Supplier" },
  { value: "sales", label: "Sales" },
];

const TONE_CLASSES: Record<TimelineTone, string> = {
  blue: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
  purple: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300",
  green: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  red: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  grey: "border border-border bg-bg text-ink-secondary",
};

const GRID_COLUMNS = "grid grid-cols-[14px_72px_68px_minmax(0,1fr)] items-start gap-x-2.5";

function StatusChip({ row }: { row: TimelineRow }): ReactNode {
  if (!row.status) return null;
  return (
    <span className={cn("inline-block rounded-md px-2 py-0.5 text-[11px] font-bold", TONE_CLASSES[row.status.tone])}>
      {row.status.label}
    </span>
  );
}

function TimelineEntry({ row, canArchive, onArchive }: { row: TimelineRow; canArchive: boolean; onArchive: (activityId: number) => void }): ReactNode {
  return (
    <li className={cn("group relative border-b border-border-subtle py-2.5 last:border-b-0", GRID_COLUMNS)}>
      <span className={cn("relative z-[1] mt-1 h-3 w-3 rounded-full border-2 bg-surface", row.isEscalation ? "border-err" : "border-primary")} />
      <div className="text-[11.5px] leading-snug text-ink">
        <div>{fmtDate(row.at)}</div>
        <div className="text-ink-muted">{fmtTime(row.at)}</div>
      </div>
      <div className="break-words text-[11.5px] leading-snug text-ink">{row.by}</div>
      <div className={cn("min-w-0", canArchive && row.isArchivable && "pr-7")}>
        <StatusChip row={row} />
        {row.remarks && (
          <div className={cn("mt-1 whitespace-pre-line break-words text-[12.5px]", row.isEscalation ? "text-err" : "text-ink")}>
            {row.upload && <Paperclip size={12} className="mr-1 inline text-ink-muted" />}
            {row.remarks}
          </div>
        )}
      </div>
      {canArchive && row.isArchivable && (
        <button
          onClick={() => onArchive(row.id)}
          className="absolute right-0 top-2 flex h-7 w-7 items-center justify-center rounded text-ink-muted hover:text-err focus:opacity-100 md:opacity-0 md:group-hover:opacity-100"
          title="Archive entry"
          aria-label="Archive entry"
        >
          <Trash2 size={12} />
        </button>
      )}
    </li>
  );
}

export function CaseTimeline({ activity, salesAgent, userNames, canEdit, composer, onAddUpdate, onArchive }: CaseTimelineProps): ReactNode {
  const [filter, setFilter] = useState<TimelineFilter>("all");
  const [shouldShowDetails, setShouldShowDetails] = useState(false);
  const scrollBoxRef = useRef<HTMLDivElement>(null);
  const { rows, hiddenCount } = useMemo(
    () => buildCaseTimeline(activity, { filter, shouldShowDetails, salesAgent, userNames }),
    [activity, filter, shouldShowDetails, salesAgent, userNames],
  );

  useEffect(() => {
    const scrollBox = scrollBoxRef.current;
    if (scrollBox) scrollBox.scrollTop = scrollBox.scrollHeight;
  }, [rows.length]);

  return (
    <section className="rounded-lg border border-border bg-surface shadow-stone">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Clock size={15} className="shrink-0 text-primary" />
        <h3 className="flex-1 text-[14px] font-bold text-ink">Timeline</h3>
        {canEdit && (
          <button
            onClick={onAddUpdate}
            className="inline-flex min-h-[36px] items-center gap-1 rounded-md border border-primary px-3 text-[12px] font-bold text-primary hover:bg-primary/5"
          >
            <Plus size={13} /> Add Update
          </button>
        )}
      </div>

      <div className="px-4 pt-3">
        {composer}
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {FILTERS.map((option) => (
            <button
              key={option.value}
              onClick={() => setFilter(option.value)}
              className={cn(
                "min-h-[30px] rounded-md px-2.5 text-[11px] font-semibold transition-colors",
                filter === option.value ? "bg-primary text-white" : "border border-border bg-bg text-ink-muted hover:text-ink",
              )}
            >
              {option.label}
            </button>
          ))}
          {(hiddenCount > 0 || shouldShowDetails) && (
            <button
              onClick={() => setShouldShowDetails((isShown) => !isShown)}
              className="min-h-[30px] text-[11px] font-semibold text-primary hover:underline"
            >
              {shouldShowDetails ? "Show key updates only" : `Show all updates (${hiddenCount} system log hidden)`}
            </button>
          )}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="px-4 pb-4 text-[12px] text-ink-muted">No activity yet</div>
      ) : (
        <div ref={scrollBoxRef} className="max-h-[65vh] overflow-y-auto overflow-x-hidden px-4 pb-2">
          <div
            className={cn(
              "sticky top-0 z-10 border-b border-border bg-bg py-2 text-[11px] font-bold text-ink-secondary",
              GRID_COLUMNS,
            )}
          >
            <span />
            <span>Date & Time</span>
            <span>By</span>
            <span>Status / Remarks</span>
          </div>
          <ol className="relative">
            <span className="pointer-events-none absolute bottom-4 left-[5px] top-4 w-0.5 bg-primary/30" />
            {rows.map((row) => (
              <TimelineEntry key={row.id} row={row} canArchive={canEdit} onArchive={onArchive} />
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
