/* company-scope-file: this module WRITES NOTHING. Its one read is keyed by the
   GRN's own id (source_doc_id), which the caller already loaded under its
   company predicate; no row is returned, only a verdict. */

/* Has this GRN's receipt been booked, and is it still standing?

   The post chokepoint's re-entry guard used to count the GRN's IN rows and call
   any count above zero "already booked". A receipt that was booked and then
   taken back out (the cancel reversal or a line-delete reversal writes an OUT
   with source_doc_type GRN against the same GRN) still has its IN row, so the
   count said "booked" while the net stock the GRN put in was zero, and a post of
   that GRN would skip the stock IN for good. The verdict is the NET quantity:
   IN rows minus the GRN's own reversing OUT rows. A receipt fully reversed reads
   as not booked; a receipt still (partly) standing reads as booked, exactly as
   before.

   A failed read is not "nothing booked": that answer would book the stock a
   second time. It comes back as `ok: false` for the caller to refuse. */

export type GrnReceiptBooked =
  | { ok: true; booked: boolean; netIn: number }
  | { ok: false; error: { message: string } };

type MovementRow = { movement_type: string | null; qty: number | string | null };

export function netReceiptQty(rows: readonly MovementRow[]): number {
  let net = 0;
  for (const r of rows) {
    // The transaction client returns numeric columns as text.
    const q = Number(r.qty ?? 0);
    if (!Number.isFinite(q)) continue;
    if (r.movement_type === 'IN') net += q;
    else if (r.movement_type === 'OUT') net -= q;
  }
  return net;
}

export async function grnReceiptBooked(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the post chokepoint passes either the PostgREST client or the transaction client; both are untyped here, as in grns.ts.
  sb: any,
  grnId: string,
): Promise<GrnReceiptBooked> {
  const { data, error } = await sb.from('inventory_movements')
    .select('movement_type, qty')
    .eq('source_doc_type', 'GRN')
    .eq('source_doc_id', grnId)
    .then((r: unknown) => r as { data: MovementRow[] | null; error: { message: string } | null },
      (e: { message: string }) => ({ data: null, error: e }));
  if (error) return { ok: false, error };
  const netIn = netReceiptQty(data ?? []);
  return { ok: true, booked: netIn > 0, netIn };
}
