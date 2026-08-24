// ─────────────────────────────────────────────────────────────────────────
// ref-in-company.ts — prove that a REFERENCE arriving in a request body names
// a row this caller's company owns, before writing anything against it.
//
// WHY THIS FILE EXISTS. companyScope.ts covers the two shapes that were being
// got wrong at the time it was written: scoping a QUERY (scopeToCompany*) and
// proving a named SOURCE DOCUMENT (crossCompanySourceRefusal). Neither covers
// the third shape, which is a body field naming a piece of INFRASTRUCTURE —
// a warehouse, a trip — that the handler then writes stock or stops into.
//
// A grep for assertWarehouseInCompany / warehouseInCompany / requireWarehouse
// across backend/src/scm returned NOTHING on 2026-08-18, and that absence is
// visible in the call sites: three separate handlers took `body.warehouseId`
// or `body.tripId` straight from the request and used it, each with its own
// half-argument about why that was fine. One of those arguments was factually
// wrong (stock-takes claimed v_inventory_all_skus has no company_id; migration
// 0156 appends `w.company_id` to it as the last column and says so in its own
// header). The rule was missing, so each site invented one.
//
// TWO PREDICATES, NOT ONE, because the two references have different rules and
// collapsing them would be a leak in one direction or an outage in the other:
//
//   · WAREHOUSES are PER-COMPANY (mig 0086 adds warehouses.company_id; 0087
//     makes the code unique per company). The predicate is the ACTIVE company.
//   · TRIPS are a CROSS-COMPANY shared queue (companyScope.ts's second pattern;
//     trips.ts:423 reads them with scopeToAllowedCompanies). The predicate is
//     the caller's ALLOWED set — wider, but still a predicate. "Shared queue"
//     has never meant "no predicate" here.
//
// BOTH DEGRADE where the company context is unresolved, and both FAIL CLOSED on
// a read error. The degrade matches every helper in companyScope.ts, so a
// pre-migration / D1-test-mirror / cold-start install keeps working. The
// fail-closed on error does NOT: a read that errored has proved nothing, and
// these guards sit in front of stock movements and driver routes, where
// "unknown" must not resolve to "allowed" (same rule crossCompanySourceRefusal
// states for conversions).
// ─────────────────────────────────────────────────────────────────────────

import {
  NOT_THIS_COMPANY,
  allowedCompanyIds,
  crossCompanySourceRefusal,
  type CompanyScopeCtx,
} from "./companyScope";

/** A refusal ready to hand to `c.json(res.body, res.status)`, or ok. */
export type RefCheck =
  | { ok: true }
  | { ok: false; body: { error: string; message: string }; status: 404 | 409 | 500 };

const OK: RefCheck = { ok: true };

/** FAIL CLOSED on a read error, with a sentence an operator can act on. The
 *  driver's error text is deliberately NOT interpolated: the SCM client drops
 *  any server message of 200 characters or more, and a PostgREST message drags
 *  the whole refusal past that into a blank generic wall (the rule is written
 *  out on crossCompanyConversionBlocked). Log `reason` at the call site if you
 *  need it. */
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
  if (!warehouseId) return OK; // nothing named — the caller's own required-check owns this
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
  // UNRESOLVED → degrade, exactly as scopeToAllowedCompanies does.
  if (allowed === undefined) return OK;
  let q = sb.from("trips").select("id").eq("id", tripId);
  // RESTRICTED TO NOTHING → `.in('company_id', [])` matches nothing, which is
  // the correct answer for a caller granted no active company.
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
): Promise<RefCheck> {
  const out = await crossCompanySourceRefusal(sb, c, table, ids, null);
  if (!out) return OK;
  if ("loadError" in out) return unreadable("line");
  return { ok: false, body: out.blocked, status: 409 };
}
