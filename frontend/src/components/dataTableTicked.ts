/* The rows a table-wide action works on (owner 2026-09-27): the ticked rows
   while any are ticked, otherwise every row left after search and filters.
   The footer total, Export and Ctrl+C all read it, so they never disagree. */
export function tickedOrAll<T>(
  rows: readonly T[],
  selectedIds: ReadonlySet<string> | undefined,
  getRowKey: (row: T) => string | number,
): { rows: T[]; picked: boolean } {
  if (selectedIds && selectedIds.size > 0) {
    const picked = rows.filter((r) => selectedIds.has(String(getRowKey(r))));
    if (picked.length > 0) return { rows: picked, picked: true };
  }
  return { rows: [...rows], picked: false };
}
