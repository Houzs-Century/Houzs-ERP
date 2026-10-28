/* ----------------------------------------------------------------------------
   ac-line-order — THE ORDER LINES REACH AUTOCOUNT, in one place.

   OWNER'S RULE, 2026-09-02: 「convert 了的 PO 一定要 remain 在同样的 line，就是
   例如第四个 item 就是第 4 个 item，不可以高或低」. A purchase order's fourth
   item stays the fourth item. It may not drift up or down.

   WHY THAT WAS NOT TRUE. Every read that builds an AutoCount payload for a
   SALES ORDER or a PURCHASE ORDER ran with NO `ORDER BY`:

     sb.from('purchase_order_items').select(PO_ITEM_COLS).eq('purchase_order_id', id)

   Postgres is free to return those rows in any order, and it changes one in
   practice — an UPDATE can move a row's physical position, so the same document
   can serialize its lines one way today and another way after an edit. The
   DOWNSTREAM documents (DO / GR / SI / PI) already ordered
   `created_at, id` (autocount-outbox composeDownstreamState, and
   autocount-convert-lines readConvertLines); the two document types the owner
   actually raises by hand did not.

   TWO PATHS TURN THAT INTO A REAL DEFECT, and neither is theoretical:

     · A CREATE sends `AddDetail` in payload order, and that order becomes the
       book's line order. An unstable read means the book's order is whatever
       Postgres felt like.
     · A NEW LINE on an existing document learns its DtlKey positionally —
       "AddDetail is called in payload order and AutoCount hands out ascending
       keys, so the Nth unknown key belongs to the Nth declared line"
       (autocount-line-keys.ts). That reasoning is only sound if the payload
       order is deterministic. It was not.

   `created_at` FIRST, `id` SECOND. Creation time is the order a person entered
   the lines, which is the order they expect to see; `id` breaks a tie when two
   rows share a timestamp (a bulk insert does), so the sort is TOTAL and the
   same rows always serialize the same way. Both columns exist on every line
   table this touches — `mfg-purchase-orders.ts` already orders its own read by
   `created_at`.

   IT DOES NOT REORDER ANYTHING IN THE BOOK. An edit still matches by DtlKey, so
   AutoCount's existing lines stay exactly where they are; this makes OUR side
   deterministic so a create lands in the right order and a new line is keyed to
   the right row.
   -------------------------------------------------------------------------- */

/** Minimal shape of the PostgREST builder this applies to. */
type Orderable<T> = { order(col: string, opts: { ascending: boolean }): T };

/** Apply the canonical AutoCount line order. Every read whose rows become an
 *  AutoCount payload MUST go through this — `acLineOrderWiring.test.ts` fails
 *  the build if one does not, so a fifth read cannot quietly skip it. */
export function inAcLineOrder<T extends Orderable<T>>(q: T): T {
  return q.order('created_at', { ascending: true }).order('id', { ascending: true });
}
