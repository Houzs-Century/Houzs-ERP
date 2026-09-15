/* When does a PO line's Description 2 get re-derived from its spec?
 *
 * Description 2 is built server-side from item_group + variants
 * (buildVariantSummary, Commander 2026-05-28). Until 2026-09-15 the line PATCH
 * rebuilt it on EVERY save, whatever the save changed. The desktop PO editor sends
 * the whole line, so moving one line's delivery date replaced the stored text with
 * a fresh summary — and for a line whose Description 2 is not a summary at all
 * (the account book's own Desc2 the AutoCount migration wrote, or a value typed
 * into the PO line import, owner 2026-09-15) that erased it, and the write-back
 * then sent the erased text to AutoCount.
 *
 * So it is re-derived only when one of its two inputs actually moves. Absent keys
 * keep the stored value (the PATCH's partial contract); an empty variants object
 * and a NULL one are the same spec. */

const canonical = (v: unknown): string => {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (entries.length === 0) return 'null';
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`;
  }
  return JSON.stringify(v);
};

export function description2InputsChanged(
  stored: { item_group?: unknown; variants?: unknown },
  patch: { itemGroup?: unknown; variants?: unknown },
): boolean {
  if (patch.itemGroup !== undefined && String(patch.itemGroup ?? '') !== String(stored.item_group ?? '')) return true;
  if (patch.variants !== undefined && canonical(patch.variants) !== canonical(stored.variants)) return true;
  return false;
}
