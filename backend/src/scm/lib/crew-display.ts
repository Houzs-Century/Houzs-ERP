/* The Delivery Planning board shows ONE crew row per Sales Order, but crew is a
   per-delivery-order snapshot (scm.delivery_order_crew) and a single SO can carry
   several DOs (partial deliveries, AutoCount re-pulls). The driver you assign
   therefore lives on one specific DO. The board used to read crew from only the
   SO's newest DO (last by id); when a later DO joined the SO with no driver, the
   driver you had entered "vanished" from the column and had to be re-typed.

   pickDisplayCrew chooses which DO's crew the board shows: the newest DO's crew
   when it already names a driver (today's behaviour, unchanged), otherwise the
   most-recent earlier DO whose crew names a driver, so an assigned driver stays
   visible once a blank newer DO appears. When no DO names a driver it returns the
   newest DO's crew (its lorry / helpers, or null) — the previous result. It picks
   ONE coherent crew row, never a merge of seats from different DOs. Pure + tested. */
export function pickDisplayCrew<T>(
  doIdsOldestToNewest: ReadonlyArray<string>,
  getCrew: (doId: string) => T | null,
  hasDriver: (crew: T) => boolean,
): T | null {
  if (doIdsOldestToNewest.length === 0) return null;
  const newestCrew = getCrew(doIdsOldestToNewest[doIdsOldestToNewest.length - 1]!);
  // Newest DO already names a driver → unchanged from before this fix.
  if (newestCrew !== null && hasDriver(newestCrew)) return newestCrew;
  // Newest DO has no driver → show the most-recent earlier DO that does.
  for (let i = doIdsOldestToNewest.length - 2; i >= 0; i--) {
    const earlier = getCrew(doIdsOldestToNewest[i]!);
    if (earlier !== null && hasDriver(earlier)) return earlier;
  }
  // No DO names a driver → the newest DO's crew (lorry / helpers only), or null.
  return newestCrew;
}
