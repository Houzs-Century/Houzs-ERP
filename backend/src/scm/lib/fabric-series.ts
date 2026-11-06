/* A fabric code's selling-library id, and the named series that group them.

   Two different things are both called "series" here:
     • the selling-library id (fabric_library.id) — the code before its colour
       number: BROWNIE-03 → BROWNIE, KN07 → KN07. Item KPI fabric rules and
       order lines (variants.fabricId) use THIS.
     • fabric_trackings.series — the name the business groups fabrics under:
       EMBRACE = KN01..KN13, HOMELY = BROWNIE.
   fabricSeriesGroups maps the second onto the first, so a KPI rule can be
   picked by the name staff use. */

/* Everything BEFORE the trailing colour number, not everything before the
   first dash. "AM275-02" -> AM275 either way, but "SF-AT-01" is SF-AT and
   "ALPINE-5311-13" is ALPINE-5311; splitting on the first dash calls them SF
   and ALPINE and mirrors the colour into the wrong series. Matches how
   normalize-fabric-codes.mjs derives it. */
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
