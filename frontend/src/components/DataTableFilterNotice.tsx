/**
 * Says out loud which column funnels / search are narrowing a table.
 *
 * Owner 2026-11-10: Delivery Planning's Overdue tab (badge 37) drew 0 rows and
 * "No orders need delivering in this view." The API had returned all 37; a
 * Delivery Date funnel remembered from earlier in the visit hid every one, and
 * the only trace of it was a 10px icon in the header. A screen that shows
 * "nothing" while it is hiding rows is wrong information, so the empty state
 * names the filters and the toolbar carries a chip while any funnel is set.
 */
import { FilterX } from "lucide-react";
import { headerLabel } from "../lib/columnHeaderLabel";
import { isConditionToken, parseCondition, DATE_PRESETS } from "./dataTableConditionFilters";

export type ActiveFilter = { key: string; label: string; detail: string };

const MONTH_SHORT = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });

/** "2026-11-06" -> "6 Nov" (year added only when it is not this year). */
function shortDay(iso: string, thisYear: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d] = m;
  const day = `${Number(d)} ${MONTH_SHORT.format(Date.UTC(Number(y), Number(mo) - 1, 1))}`;
  return Number(y) === thisYear ? day : `${day} ${y}`;
}

function describeToken(token: string, thisYear: number): string {
  const c = parseCondition(token);
  if (!c) return token;
  if (c.kind === "preset") return DATE_PRESETS.find((p) => p.key === c.preset)?.label ?? c.preset;
  if (c.kind === "dateRange") {
    const from = c.from ? shortDay(c.from, thisYear) : null;
    const to = c.to ? shortDay(c.to, thisYear) : null;
    if (from && to) return from === to ? from : `${from} – ${to}`;
    return from ? `from ${from}` : to ? `until ${to}` : "any date";
  }
  if (c.min != null && c.max != null) return `${c.min} – ${c.max}`;
  return c.min != null ? `at least ${c.min}` : c.max != null ? `at most ${c.max}` : "any number";
}

/** One funnel's allow-list in a few words: conditions spelled out, ticked
 *  values listed up to two, then counted. */
export function describeFilterValues(values: readonly string[], thisYear = new Date().getFullYear()): string {
  const conditions = values.filter(isConditionToken).map((t) => describeToken(t, thisYear));
  const plain = values.filter((v) => !isConditionToken(v)).map((v) => (v === "—" ? "(blank)" : v));
  const ticked = plain.length === 0 ? [] : plain.length <= 2 ? [plain.join(", ")] : [`${plain.length} values`];
  return [...conditions, ...ticked].join("; ");
}

/** The funnels that are set, named by their header label, in column order.
 *  A remembered key whose column no longer exists filters nothing, so it is
 *  left out rather than reported. */
export function activeFilterSummary(
  colFilters: Readonly<Partial<Record<string, readonly string[]>>>,
  columns: readonly { key: string; label: string }[],
): ActiveFilter[] {
  return columns
    .filter((c) => (colFilters[c.key]?.length ?? 0) > 0)
    .map((c) => ({ key: c.key, label: headerLabel(c.label), detail: describeFilterValues(colFilters[c.key] ?? []) }));
}

/** The empty-state text when rows exist but the funnels / search hide them all. */
export function FilteredEmptyNotice({
  hiddenCount,
  filters,
  query,
  onClear,
}: {
  hiddenCount: number;
  filters: readonly ActiveFilter[];
  query: string | null;
  onClear: () => void;
}) {
  const parts = [
    ...filters.map((f) => `${f.label} (${f.detail})`),
    ...(query ? [`search "${query}"`] : []),
  ];
  return (
    <span data-testid="filtered-empty" className="inline-flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
      <span className="text-ink-secondary">
        {hiddenCount.toLocaleString()} {hiddenCount === 1 ? "row" : "rows"} hidden by your filters: {parts.join(", ")}.
      </span>
      <button type="button" onClick={onClear} className="font-medium text-primary underline underline-offset-2 hover:text-accent">
        Clear filters
      </button>
    </span>
  );
}

/** Toolbar chip shown while any column funnel is set, rows visible or not. */
export function ActiveFiltersChip({ filters, onClear }: { filters: readonly ActiveFilter[]; onClear: () => void }) {
  if (filters.length === 0) return null;
  return (
    <span
      role="status"
      data-testid="active-filters-chip"
      title={filters.map((f) => `${f.label}: ${f.detail}`).join("\n")}
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-2 py-1 text-[12px] font-medium text-accent"
    >
      <span className="truncate">Filters on: {filters.map((f) => f.label).join(", ")}</span>
      <span aria-hidden className="text-ink-muted">·</span>
      <button type="button" onClick={onClear} className="inline-flex items-center gap-0.5 underline underline-offset-2 hover:text-ink">
        <FilterX size={12} />
        Clear all
      </button>
    </span>
  );
}
