/* The one answer to "what should this Sales Order's status BE, given the facts
   the app's own writers derive it from" — for the orders those writers never
   reached. Pure: the facts are read by the script, judged here, so a test can
   state each rule without a database.

   Four rules, in the order the app applies them (coverage outranks the date;
   nothing here ever demotes an order that has shipped):

     delivered-by-do           every live line covered by shipped delivery
                               orders, net of returns -> DELIVERED
                               (lib/so-delivery-sync.ts, which only ran from a
                               DO route — migrated DOs marked DELIVERED never
                               triggered it)
     reopened-by-late-line     DELIVERED, and a line added AFTER the last
                               shipped DO is not covered -> READY_TO_SHIP
                               (the same release the reconciler makes for a
                               cancelled DO; refused when a shipped DO has no
                               line rows, exactly as the reconciler refuses)
     date-means-in-production  CONFIRMED with a Processing Date -> IN_PRODUCTION
                               (shared/so-proceeded-status.ts; the create and
                               the confirm never asked about the date)
     no-date-means-submitted   IN_PRODUCTION without a Processing Date and
                               nothing downstream -> CONFIRMED (owner
                               2026-10-13: 那 5 张退回 Submitted)

   READY_TO_SHIP is never moved by the date rules: it is the stock sweep's to
   give and take (lib/so-stock-allocation.ts). */

export const COVERABLE_STATUSES = ['CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP', 'SHIPPED'];

/**
 * @param {{
 *   status: string | null,
 *   processingDate: string | null,
 *   fullyCovered: boolean,
 *   lateUncoveredLines: number,
 *   emptyLiveDeliveries: number,
 *   hasDownstream: boolean,
 * }} row
 * @returns {{ to: string, rule: string } | { refused: string } | null}
 *   null = the stored status already agrees with the facts.
 */
export function resyncTarget(row) {
  const status = String(row.status ?? '').trim().toUpperCase();
  const dated = String(row.processingDate ?? '').trim() !== '';

  if (COVERABLE_STATUSES.includes(status) && row.fullyCovered) {
    return { to: 'DELIVERED', rule: 'delivered-by-do' };
  }
  if (status === 'DELIVERED' && Number(row.lateUncoveredLines) > 0) {
    if (Number(row.emptyLiveDeliveries) > 0) {
      return { refused: 'a shipped delivery order has no line rows — not evidence of goods still to ship (so-delivery-sync release guard)' };
    }
    return { to: 'READY_TO_SHIP', rule: 'reopened-by-late-line' };
  }
  if (status === 'CONFIRMED' && dated) {
    return { to: 'IN_PRODUCTION', rule: 'date-means-in-production' };
  }
  if (status === 'IN_PRODUCTION' && !dated) {
    if (row.hasDownstream) {
      return { refused: 'no Processing Date but a live delivery order or invoice exists — further along than Submitted, left alone' };
    }
    return { to: 'CONFIRMED', rule: 'no-date-means-submitted' };
  }
  return null;
}
