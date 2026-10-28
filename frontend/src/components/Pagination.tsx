import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";

interface Props {
  page: number;
  perPage: number;
  total: number;
  onPageChange: (p: number) => void;
  /** When provided, renders a per-page selector. */
  onPerPageChange?: (n: number) => void;
  /** Page-size options shown in the selector. Default: 10, 25, 50, 100, 200. */
  perPageOptions?: number[];
}

const DEFAULT_PER_PAGE_OPTIONS = [10, 25, 50, 100, 200];

export function Pagination({
  page,
  perPage,
  total,
  onPageChange,
  onPerPageChange,
  perPageOptions = DEFAULT_PER_PAGE_OPTIONS,
}: Props) {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const start = total === 0 ? 0 : (page - 1) * perPage + 1;
  const end = Math.min(page * perPage, total);

  return (
    // One left-aligned row (Nick 2026-07-23): the pager used to sit at the
    // far right (justify-between), where the floating action buttons cover
    // it — range, per-page selector and prev/next now flow together.
    <div className="mt-4 flex flex-wrap items-center gap-3 text-[11px] font-medium text-ink-secondary">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-ink">
            {start.toLocaleString()}–{end.toLocaleString()}
          </span>
          <span className="text-ink-muted">of</span>
          <span className="font-mono text-ink">{total.toLocaleString()}</span>
        </div>
        {onPerPageChange && (
          <div className="flex items-center gap-1.5">
            <span className="hidden text-[10px] font-semibold uppercase tracking-wider text-ink-muted sm:inline">
              Show
            </span>
            <select
              value={perPage}
              onChange={(e) => onPerPageChange(Number(e.target.value))}
              aria-label="Rows per page"
              className="h-8 cursor-pointer rounded-md border border-border bg-surface pl-2 pr-6 text-[11px] font-semibold text-ink outline-none transition-colors hover:border-accent/50 focus:border-primary focus:ring-2 focus:ring-primary/20 sm:h-7"
            >
              {perPageOptions.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <span className="hidden text-[10px] font-semibold uppercase tracking-wider text-ink-muted sm:inline">
              per page
            </span>
          </div>
        )}
      </div>
      <div className="flex items-center gap-1 sm:ml-1">
        <button
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-md border border-border bg-surface transition-colors sm:h-7 sm:w-7",
            page <= 1
              ? "text-ink-muted opacity-40"
              : "hover:border-accent/40 hover:bg-accent-soft/50 hover:text-accent"
          )}
        >
          <ChevronLeft size={14} />
        </button>
        <span className="px-3 font-mono text-[11px] text-ink">
          {page} <span className="text-ink-muted">/</span> {totalPages}
        </span>
        <button
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-md border border-border bg-surface transition-colors sm:h-7 sm:w-7",
            page >= totalPages
              ? "text-ink-muted opacity-40"
              : "hover:border-accent/40 hover:bg-accent-soft/50 hover:text-accent"
          )}
        >
          <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}
