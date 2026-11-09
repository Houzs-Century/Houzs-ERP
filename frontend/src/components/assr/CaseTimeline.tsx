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
  blue: "bg-sky-100 text-sky-800",
  purple: "bg-violet-100 text-violet-800",
  green: "bg-emerald-100 text-emerald-800",
  amber: "bg-amber-100 text-amber-800",
  red: "bg-red-100 text-red-700",
  grey: "border border-border bg-bg text-ink-secondary",
};

const GRID_COLUMNS = "md:grid md:grid-cols-[20px_112px_128px_168px_minmax(0,1fr)_24px] md:items-start md:gap-x-3";

function StatusChip({ row }: { row: TimelineRow }): ReactNode {
  if (!row.status) return <span className="hidden text-[12px] text-ink-muted md:inline">-</span>;
  return (
    <span className={cn("inline-block rounded-md px-2 py-0.5 text-[11.5px] font-bold", TONE_CLASSES[row.status.tone])}>
      {row.status.label}
    </span>
  );
}

function TimelineEntry({ row, canArchive, onArchive }: { row: TimelineRow; canArchive: boolean; onArchive: (activityId: number) => void }): ReactNode {
  return (
    <li className={cn("group relative flex flex-col border-b border-border-subtle py-2.5 pl-6 last:border-b-0 md:pl-0", GRID_COLUMNS)}>
      <span
        className={cn(
          "absolute left-0 top-3.5 z-[1] h-3 w-3 rounded-full border-2 bg-surface md:relative md:left-auto md:top-auto md:mt-1 md:justify-self-center",
          row.isEscalation ? "border-err" : "border-primary",
        )}
      />
      <div className="flex items-center gap-2 text-[11px] text-ink-muted md:block md:text-[12px] md:text-ink">
        <span>{fmtDate(row.at)}</span>
        <span className="md:block md:text-ink-muted">{fmtTime(row.at)}</span>
      </div>
      <div className="order-last mt-1 text-[11px] text-ink-muted md:order-none md:mt-0 md:text-[12.5px] md:text-ink">
        <span className="md:hidden">by </span>
        {row.by}
      </div>
      <div className="mt-1 md:mt-0">
        <StatusChip row={row} />
      </div>
      <div className={cn("mt-1 whitespace-pre-line text-[12.5px] md:mt-0", row.isEscalation ? "text-err" : "text-ink")}>
        {row.upload && <Paperclip size={12} className="mr-1 inline text-ink-muted" />}
        {row.remarks || <span className="text-ink-muted">-</span>}
      </div>
      {canArchive && row.isArchivable ? (
        <button
          onClick={() => onArchive(row.id)}
          className="absolute right-0 top-2 flex h-8 w-8 items-center justify-center rounded text-ink-muted hover:text-err focus:opacity-100 md:static md:h-6 md:w-6 md:opacity-0 md:group-hover:opacity-100"
          title="Archive entry"
          aria-label="Archive entry"
        >
          <Trash2 size={12} />
        </button>
      ) : (
        <span className="hidden md:block" />
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
              className="ml-auto min-h-[30px] text-[11px] font-semibold text-primary hover:underline"
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
              "sticky top-0 z-10 hidden border-b border-border bg-bg py-2 text-[11.5px] font-bold text-ink-secondary",
              GRID_COLUMNS,
            )}
          >
            <span />
            <span>Date & Time</span>
            <span>By</span>
            <span>Status</span>
            <span>Update / Remarks</span>
            <span />
          </div>
          <ol className="relative">
            <span className="pointer-events-none absolute bottom-4 left-[5px] top-4 w-0.5 bg-primary/30 md:left-[9px]" />
            {rows.map((row) => (
              <TimelineEntry key={row.id} row={row} canArchive={canEdit} onArchive={onArchive} />
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
