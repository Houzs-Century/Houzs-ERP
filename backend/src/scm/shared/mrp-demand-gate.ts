/* WHICH SALES ORDERS ARE DEMAND AT ALL — one rule, stated once.

   Owner, 2026-09-15:
     「MRP 可以添加只算有 Processing date 单的功能吗？不过需求的顺序排给谁，是根据
       Delivery Date 来排的。也就是说，没有 Processing date 的单子就不进来。」

   An order whose header `processing_date` is empty is NOT demand. It takes no
   stock, claims no incoming purchase order and reports no shortage, and it is
   absent from every surface that reads the MRP allocation: the MRP page and its
   exports, the sales-order Stock column, the PO / GRN / PI "Assigned SO" column,
   the stock assigned / free (dead-stock) split, the From-SO purchase picker and
   the agents. Among orders that DO carry a processing date the queue order is
   unchanged: effective delivery date, earliest first, an order with no delivery
   date last (`byDateAsc` in routes/mrp.ts).

   The stored READY / PENDING allocator (lib/so-stock-allocation.ts) has applied
   the same gate since 2026-08-10 (owner: 「有 processing date 才来分配」). It reads
   this function too, so the two engines cannot drift into two answers about
   the same order.

   This SUPERSEDES the 2026-09-09 / 2026-09-11 ruling that the MRP page gates on
   the DELIVERY date alone. The delivery date still decides WHO is served first;
   it no longer decides WHO is in.

   The value is the raw column: a Postgres `date` arrives as 'YYYY-MM-DD' through
   PostgREST, as a Date through a direct driver, and never as ''. Blank text is
   treated as empty anyway, because a whitespace "date" released nothing.

   Mirrored for the .mjs audit replicas in backend/scripts/lib/mrp-demand-gate.mjs,
   pinned by backend/tests/mrpDemandGateMirror.test.ts. */

/** TRUE when an order with this header `processing_date` is demand. */
export function soReleasedForDemand(processingDate: unknown): boolean {
  if (processingDate == null) return false;
  if (processingDate instanceof Date) return !Number.isNaN(processingDate.getTime());
  return String(processingDate).trim() !== '';
}
