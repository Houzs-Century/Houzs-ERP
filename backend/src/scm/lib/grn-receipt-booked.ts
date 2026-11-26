/* company-scope-file: this module WRITES NOTHING. Its one read is keyed by the
   GRN's own id (source_doc_id), which the caller already loaded under its
   company predicate; no row is returned, only a verdict. */


export type GrnReceiptBooked =
  | { ok: true; booked: boolean; netIn: number }
  | { ok: false; error: { message: string } };

type MovementRow = { movement_type: string | null; qty: number | string | null };

export function netReceiptQty(rows: readonly MovementRow[]): number {
  let net = 0;
  for (const r of rows) {
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
