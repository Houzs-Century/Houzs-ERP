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
  /** The delivery order's own id. Needed because a PDF is fetched by ADDRESS:
   *  `GET /delivery-orders-mfg/:id` is `.eq('id', id)`, so the NUMBER this file
   *  is named for cannot fetch the document it names. The Sales Order list's
   *  right-click "Print Delivery Order" is what needs it, and the select that
   *  feeds this was already in flight — one more column, no extra round trip. */
  id?: string | null;
  so_doc_no: string | null;
  do_number: string | null;
  do_date: string | null;
  created_at?: string | null;
};

/** A delivery order as a caller needs it to both NAME and FETCH one. */
export type DeliveryOrderRef = { id: string; docNo: string };

/**
 * The grouping + ordering, once. Both exported views read it, so "which DOs, in
 * what order" is decided in exactly one place.
 *
 * `do_date` is the sort key with `created_at` as the fallback (an imported DO
 * can carry no date); the document number breaks ties, because several DOs on
 * one order commonly share a date and an unstable order would reshuffle the
 * cell on every reload. Rows with no `so_doc_no` or no `do_number` are dropped:
 * an unnumbered draft is not a delivery the customer can be told about.
 */
function groupedBySalesOrder(rows: DeliveryOrderNoRow[]): Map<string, Array<{ id: string | null; no: string }>> {
  const bySo = new Map<string, Array<{ id: string | null; no: string; sortKey: string }>>();
  for (const r of rows) {
    if (!r.so_doc_no || !r.do_number) continue;
    const list = bySo.get(r.so_doc_no) ?? [];
    list.push({ id: r.id ?? null, no: r.do_number, sortKey: r.do_date ?? r.created_at ?? '' });
    bySo.set(r.so_doc_no, list);
  }
  const out = new Map<string, Array<{ id: string | null; no: string }>>();
  for (const [so, list] of bySo) {
    list.sort((a, b) => b.sortKey.localeCompare(a.sortKey) || b.no.localeCompare(a.no));
    out.set(so, list.map((d) => ({ id: d.id, no: d.no })));
  }
  return out;
}

/** Group Delivery Order NUMBERS by Sales Order, newest first — the DO No.
 *  column. Every DO the order shipped on, including one with no address. */
export function doNosBySalesOrder(rows: DeliveryOrderNoRow[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [so, list] of groupedBySalesOrder(rows)) out.set(so, list.map((d) => d.no));
  return out;
}

/**
 * The same grouping, keeping each delivery order's ADDRESS beside its number.
 *
 * Same rows and the same order as `doNosBySalesOrder`, with ONE deliberate
 * difference: a row carrying no `id` is dropped HERE and kept THERE. A number
 * with no address can still be DISPLAYED and cannot be FETCHED, so the caller
 * that exists in order to fetch must never be handed one — that is a menu entry
 * that 404s, which is worse than an entry that is not offered. The DISPLAY
 * column must keep it, because the delivery still happened.
 */
export function doRefsBySalesOrder(rows: DeliveryOrderNoRow[]): Map<string, DeliveryOrderRef[]> {
  const out = new Map<string, DeliveryOrderRef[]>();
  for (const [so, list] of groupedBySalesOrder(rows)) {
    out.set(so, list.flatMap((d) => (d.id ? [{ id: d.id, docNo: d.no }] : [])));
  }
  return out;
}
