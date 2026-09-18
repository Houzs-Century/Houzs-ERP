/* The row rules of DataTable — which rows a column funnel keeps and how a
 * column sorts — as plain functions.
 *
 * They live outside the component so the grid and its line export run the SAME
 * code: the grid filters the page it holds, and `exportLines` filters every row
 * the server matched with these exact functions before writing the file (owner
 * 2026-09-15: the export follows my filter and my view). A second copy of the
 * funnel rule in an export helper would be the next "the file does not match
 * the screen" bug. */

export type CellValue = string | number | boolean | null | undefined;

/** The part of a column these rules read. */
export type RowRuleColumn<T> = {
  key: string;
  getValue?: (row: T) => CellValue;
  sortValue?: (row: T) => CellValue;
  getFilterValues?: (row: T) => (string | number | null | undefined)[];
  disableSort?: boolean;
};

// Canonical string identity for a cell value in the funnel filter —
// what the popover lists and what row matching compares against.
// null/undefined/"" all collapse to the em-dash bucket so blank cells
// are filterable as one group.
export function filterKeyOf(v: unknown): string {
  if (v == null || v === "") return "—";
  return String(v);
}

/** Multi-value cell -> its filter keys. An empty list is still "—" (blank),
 *  so a row with no values stays tickable under the blank entry exactly like
 *  a single-value column's null. */
export function filterKeysOf(vs: readonly unknown[]): string[] {
  const keys = vs.map(filterKeyOf).filter((k) => k !== "—");
  return keys.length ? [...new Set(keys)] : ["—"];
}

export function compareValues(a: CellValue, b: CellValue): number {
  const aNull = a == null || a === "";
  const bNull = b == null || b === "";
  if (aNull && bNull) return 0;
  if (aNull) return 1;   // nulls sink to the bottom regardless of direction reversal's impact
  if (bNull) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : a ? 1 : -1;
  // ISO-like date strings compare fine as strings, so no special handling
  // is needed — "2026-04-16" < "2026-04-17" under string compare.
  const as = String(a).toLowerCase();
  const bs = String(b).toLowerCase();
  if (as < bs) return -1;
  if (as > bs) return 1;
  return 0;
}

/** Per-column funnel filters. Value identity = the stringified getValue, matching
 *  what the funnel popover lists; a multi-value column matches on ANY value.
 *  With nothing to filter it returns the SAME array: the grid reports its rows
 *  to the parent in an effect keyed on identity, so a fresh copy per render
 *  loops a parent that re-renders on that report. */
export function applyColumnFilters<T>(
  rows: T[],
  colFilters: Readonly<Record<string, readonly string[]>>,
  columns: readonly RowRuleColumn<T>[],
): T[] {
  const active = Object.entries(colFilters).filter(([, vals]) => vals.length > 0);
  if (active.length === 0) return rows;
  const getters = active
    .map(([key, vals]) => {
      const col = columns.find((c) => c.key === key);
      if (!col?.getValue) return null;
      const values = col.getFilterValues
        ? (r: T) => filterKeysOf(col.getFilterValues!(r))
        : (r: T) => [filterKeyOf(col.getValue!(r))];
      return { values, allowed: new Set(vals) };
    })
    .filter((g): g is { values: (r: T) => string[]; allowed: Set<string> } => g !== null);
  if (getters.length === 0) return rows;
  return rows.filter((r) => getters.every((g) => g.values(r).some((v) => g.allowed.has(v))));
}

/** The grid's sort. On a `serverSort` table a server-sortable column is already
 *  ordered by the backend and is left alone; a `disableSort` column is sorted
 *  here. Returns the SAME array when it does not sort (see applyColumnFilters). */
export function sortTableRows<T>(
  rows: T[],
  sort: { key: string; dir: "asc" | "desc" } | null,
  columns: readonly RowRuleColumn<T>[],
  serverSort: boolean,
): T[] {
  if (!sort) return rows;
  const col = columns.find((c) => c.key === sort.key);
  if (!col || !col.getValue) return rows;
  if (serverSort && !col.disableSort) return rows;
  const getter = col.sortValue ?? col.getValue;  // display order != priority order
  const mul = sort.dir === "asc" ? 1 : -1;
  return rows.slice().sort((a, b) => compareValues(getter(a), getter(b)) * mul);
}
