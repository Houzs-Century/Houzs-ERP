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
import { deferMrpSnapshotRefresh } from './mrp-snapshot';
import { markIdempotencyNoWrite } from '../../middleware/idempotency';

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

export type PlanRefusal = { body: Record<string, unknown>; status: 409 | 503 };

/** The convert's refusal when the plan the operator is looking at is stale, else
 *  null. `planAsOfRaw` null (not an MRP convert, or no timestamp sent) skips the
 *  check. Runs before any write, which settleFromSosForMrp relies on. */
export async function mrpPlanStaleRefusal(
  sb: any,
  companyId: number | null,
  soItemIds: readonly string[],
  planAsOfRaw: unknown,
): Promise<PlanRefusal | null> {
  const planAsOfMs = parsePlanAsOf(planAsOfRaw);
  if (planAsOfMs === null || companyId === null) return null;
  let since: string[];
  try {
    since = await loadSoLinesOrderedSincePlan(sb, companyId, soItemIds, planAsOfMs);
  } catch (e) {
    return { body: { error: 'mrp_plan_check_failed', reason: String((e as Error).message) }, status: 503 };
  }
  if (since.length === 0) return null;
  return {
    body: {
      error: 'mrp_plan_stale',
      reason: 'A PO was raised on some of these Sales Order lines after this MRP plan was calculated. Regenerate the plan and check what is still short.',
      soItemIds: since,
    },
    status: 409,
  };
}

/** POST /from-sos after the core has answered. New POs move MRP supply, so the
 *  stored plan is refreshed now, as cancel and reopen do. A plan refusal wrote
 *  nothing, so its idempotency claim is released: the page keeps its key on an
 *  error, and the stored 409 would otherwise refuse the next Proceed on the
 *  recalculated plan as a reused key. */
export function settleFromSosForMrp(
  c: any,
  companyId: number | null,
  out: { status: number; body: Record<string, unknown> },
): void {
  if (out.status === 201 && Number(out.body.total ?? 0) > 0 && companyId !== null) {
    deferMrpSnapshotRefresh(c, c.get('supabase'), companyId, 'po-from-sos');
  }
  if (out.body.error === 'mrp_plan_stale' || out.body.error === 'mrp_plan_check_failed') {
    markIdempotencyNoWrite(c);
  }
}
