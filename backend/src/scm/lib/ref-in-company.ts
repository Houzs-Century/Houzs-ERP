
import { assertLinkedLineItemsMatch } from "./line-link-item-identity";
import {
  NOT_THIS_COMPANY,
  allowedCompanyIds,
  crossCompanySourceRefusal,
  type CompanyScopeCtx,
} from "./companyScope";

/** A refusal ready to hand to `c.json(res.body, res.status)`, or ok. */
export type RefCheck =
  | { ok: true }
  | { ok: false; body: { error: string; message: string }; status: 404 | 409 | 500 }
  | { ok: false; body: { error: string; reason: string } & Record<string, unknown>; status: 409 | 503 };

const OK: RefCheck = { ok: true };

const unreadable = (what: string): RefCheck => ({
  ok: false,
  body: {
    error: "ref_check_failed",
    message: `We couldn't confirm which company that ${what} belongs to, so nothing was changed. Please try again.`,
  },
  status: 500,
});

/**
 * The WAREHOUSE this body field names must be one of the ACTIVE company's.
 *
 * Unscoped, `body.warehouseId` let one company snapshot a count sheet against
 * the other's warehouse (stock-takes), and post a manual stock ADJUSTMENT into
 * it (inventory-adjustments) — an inventory_movements row and a lot in someone
 * else's books, written by a service-role client that never evaluates a policy.
 *
 * @param companyId the ACTIVE company, from requireActiveCompanyId. REQUIRED
 *   and positional, for the reason scopeToCompanyId states: an optional company
 *   silently means "every company" to whoever forgets it.
 */
export async function assertWarehouseInCompany(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  warehouseId: string | null | undefined,
  companyId: number,
): Promise<RefCheck> {
  if (!warehouseId) return OK;
  const { data, error } = await sb
    .from("warehouses")
    .select("id")
    .eq("id", warehouseId)
    .eq("company_id", companyId)
    .maybeSingle();
  if (error) return unreadable("warehouse");
  if (!data) return { ok: false, body: NOT_THIS_COMPANY, status: 404 };
  return OK;
}

/**
 * The TRIP this body field names must be within the caller's ALLOWED companies.
 *
 * Unscoped, `body.tripId` let a caller in one company hang a stop on the other
 * company's trip — the stop is stamped with the WRITER's company_id, so it then
 * shows up on the other tenant's driver route as a row their own scoped reads
 * cannot explain.
 *
 * Widening rather than pinning is deliberate: the delivery board is one queue
 * over both companies, so an ops user granted both must still be able to put a
 * HOUZS job on a trip they are running out of the 2990 book. What must not
 * happen is reaching a trip they hold NO grant for.
 */
export async function assertTripInAllowedCompanies(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  tripId: string | null | undefined,
  c: CompanyScopeCtx,
): Promise<RefCheck> {
  if (!tripId) return OK;
  const allowed = allowedCompanyIds(c);
  if (allowed === undefined) return OK;
  let q = sb.from("trips").select("id").eq("id", tripId);
  q = q.in("company_id", allowed);
  const { data, error } = await q.maybeSingle();
  if (error) return unreadable("trip");
  if (!data) return { ok: false, body: NOT_THIS_COMPANY, status: 404 };
  return OK;
}

/**
 * The SOURCE LINE named in a request body must be in the active company.
 *
 * THE LEAK THIS CLOSES, in one shape repeated eight times on the purchase side.
 * Each of these handlers proves its HEADER — `grns.ts` POST `/:id/items` loads
 * the GRN with `scopeToCompanyId`, `purchase-invoices.ts` and
 * `purchase-returns.ts` do the same for their own document, and the two CREATE
 * paths check the source document the body NAMES. None of them checked the
 * per-item `purchaseOrderItemId` / `grnItemId` / `pcOrderItemId` /
 * `pcReceiveItemId`, which also arrives in the body. The rollup writers then
 * address it directly:
 *
 *   recomputePoReceived        purchase_order_items.received_qty   .eq('id', …)
 *   recomputeGrnInvoiced       grn_items.invoiced_qty              .eq('id', …)
 *   adjustGrnReturnedQty       grn_items.returned_qty              .eq('id', …)
 *   recomputePcoReceived       purchase_consignment_order_items    .eq('id', …)
 *   adjustPcReceiveReturnedQty purchase_consignment_receive_items  .eq('id', …)
 *
 * — no company predicate, no tie back to the header, and several cascade into
 * the parent PO / PC-Order status or a stock movement. So a caller could move
 * the other tenant's received / invoiced / returned quantities by knowing a line
 * uuid, with the header guard fully satisfied.
 *
 * Every one of those line tables carries a NOT NULL `company_id` (migs 0083 and
 * 0090), so the rule that already exists for source DOCUMENTS applies unchanged
 * — this is a shape adapter over `crossCompanySourceRefusal`, deliberately NOT a
 * ninth copy of the rule. That function's own header records what three copies
 * cost: eleven conversions existed, four were guarded, seven were not, and
 * nothing said which was which.
 *
 * Call it BEFORE the qty-cap / migrated-flag probes at each site: those read the
 * same unowned id and would otherwise report the other company's headroom back
 * to the caller.
 *
 * A line has no document number, so the refusal says "That document" rather than
 * reading a uuid out to an operator.
 */
export async function assertSourceLinesInCompany(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  c: CompanyScopeCtx,
  table: string,
  ids: Array<string | null | undefined>,
  /* IDENTITY, when the caller can supply it — docs/bugs/0672 site 15.
     The company half of this guard was never the whole question. A source line
     may be in the right company, its parent may be in the right state and the
     quantity may fit, and it can still be A DIFFERENT PRODUCT: the foreign key
     is valid, nothing dangles, no constraint breaks, and no coverage count
     drops. `recomputePoReceived`, `recomputeGrnInvoiced` and
     `adjustGrnReturnedQty` all address the quantity ledger BY THIS LINK
     (`.eq('id', ...)`), so a wrong one draws down the WRONG source line and
     leaves the right one open to be received, invoiced or returned twice.

     Passed as the request's own line payloads plus the field that carries the
     link, so a caller adds no bookkeeping to opt in — the same shape adapter
     argument this function's header already makes about the company rule. */
  identity?: { lines: Array<Record<string, unknown>>; linkField: string; source: string },
): Promise<RefCheck> {
  const out = await crossCompanySourceRefusal(sb, c, table, ids, null);
  if (out) {
    if ("loadError" in out) return unreadable("line");
    return { ok: false, body: out.blocked, status: 409 };
  }
  if (!identity) return OK;
  const claims = identity.lines
    .map((l) => ({ linkId: l[identity.linkField] as string | null | undefined, itemCode: l.itemCode }))
    .filter((cl) => typeof cl.linkId === "string" && cl.linkId.length > 0);
  if (claims.length === 0) return OK;
  const idc = await assertLinkedLineItemsMatch(sb, table, claims, { source: identity.source });
  return idc.ok ? OK : { ok: false, body: idc.body, status: idc.status };
}
