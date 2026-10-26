/* Which board rows a GET /delivery-planning answers with, by `state`.
   OPEN = every row but Delivered (2026-10-26: Delivered was 72% of a 5.4 MB
   payload re-downloaded on every edit). The board fetches OPEN for its working
   tabs; Delivered counts per region ride along so the tab badges stay right
   without the rows. ALL and a single state behave as before. */
export function boardSlice<T extends { delivery_state: string; regions: readonly string[] }>(
  rows: T[],
  stateParam: string,
): { orders: T[]; deliveredByRegion: Record<string, number> | null } {
  if (stateParam === 'ALL') return { orders: rows, deliveredByRegion: null };
  if (stateParam !== 'OPEN') return { orders: rows.filter((o) => o.delivery_state === stateParam), deliveredByRegion: null };
  const deliveredByRegion: Record<string, number> = {};
  const orders: T[] = [];
  for (const o of rows) {
    if (o.delivery_state !== 'DELIVERED') { orders.push(o); continue; }
    for (const r of o.regions) deliveredByRegion[r] = (deliveredByRegion[r] ?? 0) + 1;
  }
  return { orders, deliveredByRegion };
}
