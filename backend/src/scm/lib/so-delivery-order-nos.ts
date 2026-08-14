/* DO No. per Sales Order — EVERY non-cancelled Delivery Order the order shipped
   on, newest first (owner 2026-08-14).

   Deliberately not `soCurrentDocNo`. That one answers "the furthest-forward
   document this flow has reached" and ranks DO → Sales Invoice → Delivery
   Return, falling back to the order's own number when nothing downstream
   exists — so a column headed "DO No." backed by it would show an invoice
   number on an invoiced order and an SO number on an undelivered one. Those are
   two different questions; this file answers only the delivery one, and an
   order with no Delivery Order gets an empty list rather than a stand-in.

   A part-delivered order having SEVERAL DOs is the point of the column, so the
   whole list is returned and the caller decides how many fit. */

/** The Delivery Order columns this needs. Cancelled rows must already be
 *  excluded by the query — this does not re-filter on status. */
export type DeliveryOrderNoRow = {
  so_doc_no: string | null;
  do_number: string | null;
  do_date: string | null;
  created_at?: string | null;
};

/**
 * Group Delivery Order numbers by Sales Order, newest first.
 *
 * `do_date` is the sort key with `created_at` as the fallback (an imported DO
 * can carry no date); the document number breaks ties, because several DOs on
 * one order commonly share a date and an unstable order would reshuffle the
 * cell on every reload. Rows with no `so_doc_no` or no `do_number` are dropped:
 * an unnumbered draft is not a delivery the customer can be told about.
 */
export function doNosBySalesOrder(rows: DeliveryOrderNoRow[]): Map<string, string[]> {
  const bySo = new Map<string, Array<{ no: string; sortKey: string }>>();
  for (const r of rows) {
    if (!r.so_doc_no || !r.do_number) continue;
    const list = bySo.get(r.so_doc_no) ?? [];
    list.push({ no: r.do_number, sortKey: r.do_date ?? r.created_at ?? '' });
    bySo.set(r.so_doc_no, list);
  }
  const out = new Map<string, string[]>();
  for (const [so, list] of bySo) {
    list.sort((a, b) => b.sortKey.localeCompare(a.sortKey) || b.no.localeCompare(a.no));
    out.set(so, list.map((d) => d.no));
  }
  return out;
}
