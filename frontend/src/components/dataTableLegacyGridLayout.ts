/**
 * Carry a layout saved by the retired SCM DataGrid into a DataTable (one-table
 * plan, owner 2026-09-25). 40 DataGrid layouts were live when the migration
 * started; a page that swaps components must open the way its user left it.
 *
 * The two grids read "hidden" differently. DataGrid applies a column's
 * `defaultHidden` only while its stored hidden list is EMPTY; once the user has
 * hidden anything, every column not in that list shows. DataTable keeps the
 * flags always and records the exceptions in `shown`. So a non-empty grid list
 * becomes "shown = every defaultHidden column the user did not hide".
 */
import type { StoredLayout } from "../lib/tableLayouts";
import {
  readDataGridLayout,
  type DataGridLayout,
} from "../vendor/scm/components/dataGridLayoutStorage";

type GridShaped = Pick<DataGridLayout, "order" | "hidden" | "widths" | "pinned" | "groupBy">;
type ColumnFacts = { key: string; defaultHidden?: boolean; alwaysVisible?: boolean };

export function gridLayoutToTableLayout(grid: GridShaped, columns: readonly ColumnFacts[]): StoredLayout {
  const known = new Set(columns.map((c) => c.key));
  const keep = (keys: readonly string[]) => keys.filter((k) => known.has(k));
  const hidden = keep(grid.hidden);
  const hiddenSet = new Set(hidden);
  const shown =
    hidden.length === 0
      ? []
      : columns.filter((c) => c.defaultHidden && !c.alwaysVisible && !hiddenSet.has(c.key)).map((c) => c.key);
  const widths: Record<string, number> = {};
  for (const [k, w] of Object.entries(grid.widths)) if (known.has(k)) widths[k] = w;
  return {
    order: keep(grid.order),
    hidden,
    shown,
    widths,
    pinned: keep(grid.pinned).filter((k) => !hiddenSet.has(k)),
    pinnedRight: [],
    groupBy: keep(grid.groupBy),
  };
}

export function readLegacyGridLayout(
  gridIdKey: string,
): (GridShaped & { sort: DataGridLayout["sort"] }) | null {
  const grid = readDataGridLayout(gridIdKey);
  const empty =
    grid.order.length === 0 &&
    grid.hidden.length === 0 &&
    grid.pinned.length === 0 &&
    grid.groupBy.length === 0 &&
    grid.sort == null &&
    Object.keys(grid.widths).length === 0;
  return empty ? null : grid;
}
