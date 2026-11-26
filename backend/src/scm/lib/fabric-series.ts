
export const seriesOf = (code: string): string => {
  const v = (code || '').trim().toUpperCase();
  const m = /^(.+)[\s-]+\d{1,3}$/.exec(v);
  const head = (m ? m[1] : v.split('-')[0]) || v;
  return head.replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || v;
};

export type FabricSeriesGroup = { series: string; refs: string[] };

/** Each named series with the library ids of its fabrics, sorted by name.
 *  Only ids in `libraryIds` are kept (a KPI rule can only name those); a
 *  series left with none is dropped, and so is a blank series name. */
export function fabricSeriesGroups(
  rows: ReadonlyArray<{ fabric_code: string | null; series: string | null }>,
  libraryIds: ReadonlySet<string>,
): FabricSeriesGroup[] {
  const by = new Map<string, Set<string>>();
  for (const r of rows) {
    const name = (r.series ?? '').trim();
    const ref = seriesOf(r.fabric_code ?? '');
    if (!name || !ref || !libraryIds.has(ref)) continue;
    let set = by.get(name);
    if (!set) by.set(name, (set = new Set()));
    set.add(ref);
  }
  return [...by]
    .map(([series, refs]) => ({ series, refs: [...refs].sort() }))
    .sort((a, b) => a.series.localeCompare(b.series));
}
