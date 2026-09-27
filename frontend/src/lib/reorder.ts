/** Move `fromKey` to sit just before `toKey` in a key list — the array move a
 *  drag-to-reorder drop makes. Pure. Dropping on itself, or on a target no longer
 *  in the list, returns the list unchanged. */
export function reorderKeys(keys: readonly string[], fromKey: string, toKey: string): string[] {
  if (fromKey === toKey) return [...keys];
  const out = keys.filter((k) => k !== fromKey);
  const at = out.indexOf(toKey);
  if (at < 0) return [...keys];
  out.splice(at, 0, fromKey);
  return out;
}
