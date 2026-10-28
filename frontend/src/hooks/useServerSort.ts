import { useCallback, useState } from "react";

/**
 * Server-side sort state for paginated list pages.
 *
 * Pair with `<DataTable serverSort onSortChange={handleSortChange} />`
 * so the table reports header-click sort changes back to the page,
 * which then includes `sort_by` / `sort_dir` in its query and re-fetches
 * page 1.
 *
 * Spread `sortParams` into `buildQuery({...})` so unset values (no
 * column sorted) drop out cleanly.
 *
 * Optional `onChange` callback fires whenever sort changes — pages
 * use it to reset pagination back to page 1 (otherwise you'd land on
 * page 5 of a freshly-sorted result, which is rarely what you want).
 *
 * Deliberately minimal: no localStorage, no URL sync. The DataTable
 * itself persists the local SortState (asc/desc/none) for header
 * arrow display, so a refresh restores the visual but re-fetches
 * unsorted on first load — fine for our usage.
 */
export type SortDir = "asc" | "desc";
export interface SortState {
  key: string;
  dir: SortDir;
}

export function useServerSort(onChange?: () => void) {
  const [sort, setSort] = useState<SortState | null>(null);

  const handleSortChange = useCallback(
    (next: SortState | null) => {
      setSort(next);
      onChange?.();
    },
    [onChange]
  );

  return {
    sort,
    sortParams: {
      sort_by: sort?.key,
      sort_dir: sort?.dir,
    } as { sort_by?: string; sort_dir?: SortDir },
    handleSortChange,
  };
}
