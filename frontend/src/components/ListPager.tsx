import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";

/**
 * ListPager — a 0-based server-pagination footer with a per-page selector.
 *
 * Renders IDENTICALLY to the shared components/Pagination (the Service Cases
 * pager): "1–50 of 795 · SHOW [50] PER PAGE · ‹ 1/16 ›". Owner 2026-07-24:
 * "每个 list 的下面都要和 Service case list 的一样". The ONLY difference is the
 * interface is 0-based, matching how every SCM list holds `page`; Pagination
 * is 1-based and stays for the non-SCM pages already on it. Keep the two in
 * visual lockstep — if Pagination's chrome changes, change it here too.
 *
 * Replaced the ten hand-rolled inline PaginationFooter copies across the SCM
 * lists (#1201). Left-aligned in one row so the pager clears the floating
 * action buttons that used to cover a far-right Next.
 */

const DEFAULT_PER_PAGE = [25, 50, 100];

interface Props {
  /** 0-based page index. */
  page: number;
  pageSize: number;
  total: number;
  /** Called with the new 0-based page. */
  onPageChange: (page: number) => void;
  /** When provided, the per-page selector shows. Callers reset to page 0. */
  onPageSizeChange?: (size: number) => void;
  /** Page-size options. Default 25 / 50 / 100 (the SCM list routes cap at 100). */
  perPageOptions?: number[];
  /** Accepted for call-site compatibility only — NOT rendered. The pager
   *  matches Pagination exactly, which shows no noun ("1–50 of 795", not
   *  "Showing 1–50 of 795 orders"). Kept so the ten call sites need no edit. */
  noun?: string;
  /** A short honesty line beside the count, e.g. that a column filter narrows
   *  only the loaded page. null renders nothing. */
  note?: string | null;
}

export function ListPager({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  perPageOptions = DEFAULT_PER_PAGE,
  note = null,
}: Props) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : page * pageSize + 1;
  const end = Math.min((page + 1) * pageSize, total);
  const current = Math.min(page + 1, totalPages);

  return (
    // Mirrors components/Pagination's markup exactly (bar the 0-based math).
    <div className="mt-4 flex flex-wrap items-center gap-3 text-[11px] font-medium text-ink-secondary">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-ink">
            {start.toLocaleString()}–{end.toLocaleString()}
          </span>
          <span className="text-ink-muted">of</span>
          <span className="font-mono text-ink">{total.toLocaleString()}</span>
        </div>
        {note && <span className="text-[11px] text-warning-text" role="note">{note}</span>}
        {onPageSizeChange && (
          <div className="flex items-center gap-1.5">
            <span className="hidden text-[10px] font-semibold uppercase tracking-wider text-ink-muted sm:inline">
              Show
            </span>
            <select
              value={pageSize}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
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
          type="button"
          disabled={page <= 0}
          onClick={() => onPageChange(page - 1)}
          aria-label="Previous page"
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-md border border-border bg-surface transition-colors sm:h-7 sm:w-7",
            page <= 0
              ? "text-ink-muted opacity-40"
              : "hover:border-accent/40 hover:bg-accent-soft/50 hover:text-accent",
          )}
        >
          <ChevronLeft size={14} />
        </button>
        <span className="px-3 font-mono text-[11px] text-ink">
          {current} <span className="text-ink-muted">/</span> {totalPages}
        </span>
        <button
          type="button"
          disabled={current >= totalPages}
          onClick={() => onPageChange(page + 1)}
          aria-label="Next page"
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-md border border-border bg-surface transition-colors sm:h-7 sm:w-7",
            current >= totalPages
              ? "text-ink-muted opacity-40"
              : "hover:border-accent/40 hover:bg-accent-soft/50 hover:text-accent",
          )}
        >
          <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}
