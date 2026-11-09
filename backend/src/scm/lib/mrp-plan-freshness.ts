// ----------------------------------------------------------------------------
// mrp-plan-freshness — refuse an MRP "Proceed PO" made from a plan that is older
// than a PO already raised on the same Sales Order lines.
//
// The MRP page reads a STORED plan (mrp-snapshot.ts, refreshed every ~15 min),
// and an MRP-origin convert has no qty cap on a pooled line (fromMrp, see
// convertSosToPosCore). So after one Proceed, the lines just ordered still read
// as short until the plan is recomputed, and a second press, or a second tab,
// ordered the same goods again. The page sends the `computedAt` of the plan it
// is showing; a live PO line on any picked SO line created after that moment
// means the plan no longer knows about it, and the convert is refused.
// ----------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any -- the untyped supabase-js client this SCM tree passes around (see companyScope.ts header). */
import { chunkIn } from './paginate-all';

/* Same set as routes/mrp.ts PO_DEAD: a cancelled or draft PO is not supply in
   the plan, so a newer one does not make the plan stale. */
const PO_NOT_SUPPLY = new Set(['CANCELLED', 'DRAFT']);

export type PoLineSince = { so_item_id: string | null; created_at: string | null; po: { status: string | null } | null };

/** The picked SO line ids that already have supply the plan did not count:
 *  a PO line created after `planAsOf` on a PO that MRP treats as supply. */
export function soLinesOrderedSincePlan(lines: readonly PoLineSince[], planAsOfMs: number): string[] {
  const out = new Set<string>();
  for (const l of lines) {
    if (!l.so_item_id || !l.created_at) continue;
    const status = String(l.po?.status ?? '').toUpperCase();
    if (!status || PO_NOT_SUPPLY.has(status)) continue;
    const at = Date.parse(l.created_at);
    if (Number.isFinite(at) && at > planAsOfMs) out.add(l.so_item_id);
  }
  return [...out];
}

/** Parse the page's plan timestamp. null = absent or unreadable: the caller then
 *  skips the check, so an older page or a headless caller keeps working. */
export function parsePlanAsOf(raw: unknown): number | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/** Read the PO lines on these SO lines created after the plan, in one company. */
export async function loadSoLinesOrderedSincePlan(
  sb: any,
  companyId: number,
  soItemIds: readonly string[],
  planAsOfMs: number,
): Promise<string[]> {
  const ids = [...new Set(soItemIds)];
  if (ids.length === 0) return [];
  const since = new Date(planAsOfMs).toISOString();
  const { data, error } = await chunkIn<PoLineSince>(
    ids,
    (batch, from, to) => sb
      .from('purchase_order_items')
      .select('so_item_id, created_at, po:purchase_orders!inner(status)')
      .eq('company_id', companyId)
      .in('so_item_id', batch)
      .gt('created_at', since)
      .order('id')
      .range(from, to),
  );
  /* A failed read must not pass as "nothing ordered since": that is the
     direction that lets the duplicate order through. */
  if (error) throw new Error(`mrp_plan_freshness_read_failed: ${error.message}`);
  return soLinesOrderedSincePlan(data, planAsOfMs);
}
