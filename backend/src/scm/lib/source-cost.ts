// ----------------------------------------------------------------------------
// source-cost.ts — resolve a converted line's unit cost from the SOURCE
// document's stored line, server-side, instead of trusting the client's echo.
//
// WHY THIS FILE EXISTS: the From-X pickers (/returnable-do-lines,
// /deliverable-order-lines, /returnable-note-lines) hand the client each source
// line's `unitCostCenti`, and the New pages post it straight back into the
// create payload. That echo is what made a naive finance strip DANGEROUS (#632):
// delete the key on the read and the client keeps echoing it as a genuine `0`,
// so a non-finance operator silently books the document at cost 0 and
// recomputeTotals rolls its margin to the full total. Read gated + write still
// trusting is the trap re-armed.
//
// The cost on these documents is a HISTORICAL SNAPSHOT off the source line, NOT
// a catalog lookup: a return must be booked at the cost the DO actually shipped
// at, not at today's mfg_products.cost_price_sen. So the honest fix is not
// "recompute from the catalog" (that would rewrite history the moment costs are
// seeded) — it is to read the SAME column the picker read, from the SAME row,
// on the server, keyed by the link id the create payload already carries.
//
// With the cost resolved here, the client's `unitCostCenti` is IGNORED for any
// linked line, which is what makes stripping the picker's read safe. Free-hand
// lines (no link id) have no source to read and keep their existing behaviour.
// ----------------------------------------------------------------------------

import { chunkIn } from './paginate-all';

/**
 * Map every given source line id -> its stored `unit_cost_centi`.
 *
 * `table` is the SOURCE line table (delivery_order_items /
 * consignment_sales_order_items / consignment_delivery_order_items). Ids that
 * no longer exist are simply absent from the map, so a caller falls back to its
 * own default rather than silently booking 0.
 *
 * `sb` is the loosely-typed Supabase client from the Hono context.
 */
export async function sourceUnitCostByItemId(
  sb: any,
  table: string,
  ids: Array<string | null | undefined>,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (wanted.length === 0) return out;
  // chunkIn batches the IN-list and pages each batch, so a >1000-line convert
  // can't truncate and leave later lines falling back to the client's echo.
  const { data } = await chunkIn<{ id: string; unit_cost_centi: number | null }>(
    wanted,
    (batch, from, to) => sb.from(table).select('id, unit_cost_centi').in('id', batch).range(from, to),
  );
  for (const r of (data ?? []) as Array<{ id: string; unit_cost_centi: number | null }>) {
    out.set(r.id, Number(r.unit_cost_centi ?? 0));
  }
  return out;
}
