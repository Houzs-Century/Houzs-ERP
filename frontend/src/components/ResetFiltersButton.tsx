import { FilterX } from "lucide-react";
import { cn } from "../lib/utils";

/**
 * Tiny toolbar button that clears the filters on a page. Stays hidden
 * until at least one filter is active so the toolbar isn't cluttered
 * on a fresh visit.
 *
 * Designed to be wired into any list/calendar that owns its own filter
 * state. The page decides what "active" means (e.g. ignoring an "ALL"
 * pill default) and what reset does (clear URL params, drop sticky
 * localStorage, reset pagination).
 *
 * DataTable renders this unconditionally and ORs the page's `active` with its
 * own column funnels, because a page cannot see those: they are sticky, live in
 * localStorage, apply from the first paint, and appear nowhere but the header
 * that carries them. Owner 2026-08-14 — a Purchaser reported 5 of 60 POs
 * missing; the same account showed all 60 on another machine, and the toolbar
 * offered him nothing to clear. Lists that pass no `resetFilters` at all get a
 * button for that reason too.
 */
export function ResetFiltersButton({
  active,
  onReset,
  className,
  label = "Reset",
}: {
  active: boolean;
  onReset: () => void;
  className?: string;
  label?: string;
}) {
  if (!active) return null;
  return (
    <button
      type="button"
      onClick={onReset}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[12px] font-medium text-ink-secondary transition-colors hover:border-accent/50 hover:text-accent",
        className
      )}
      title="Clear all filters and search"
    >
      <FilterX size={13} />
      {label}
    </button>
  );
}
