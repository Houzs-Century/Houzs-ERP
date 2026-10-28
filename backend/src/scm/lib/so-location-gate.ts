// ----------------------------------------------------------------------------
// so-location-gate — an order that will be written to AutoCount must resolve a
// STOCK LOCATION, and the ERP must say so while the salesperson is still on the
// screen.
//
// 2026-08-13, the owner's first two write-back tests were both REFUSED at drain
// time. HC-SO-2608-002 came back:
//
//   refused, nothing sent (MissingLocationError): 2 line(s) carry no stock
//   location and none can be inherited from the document ... AutoCount rejects
//   a document line whose Location is not in dbo.Location
//
// Traced: neither test order had a delivery address, so neither had a State.
// The SO's warehouse is the header's free-text `sales_location`
// (docs/modules/sales-order.md, "The warehouse follows the SO"), derived from
// `customer_state` through `state_warehouse_mappings` — no State, no warehouse,
// no Location, and AutoCount's FK_SODTL_Location rejects the whole document.
// The ERP had already told the salesperson the order was saved.
//
// ── WHY THE GATE ASKS FOR THE WAREHOUSE, NOT FOR THE STATE ──────────────────
// "A State was picked" is NOT the same question as "AutoCount will get a
// Location". A State with no `state_warehouse_mappings` row derives no
// warehouse either, so a State-presence check would still let a refused order
// through. So this gate asks the question AutoCount actually asks — did a
// warehouse resolve? — and then names the real cause, because the two causes
// have different owners:
//
//   • no State picked          -> the salesperson fixes it, on this screen
//   • State has no mapping     -> an ADMIN maps the State to a warehouse
//
// Telling a salesperson to "pick a State" when they already picked one sends
// them in a circle.
//
// ── WHICH COMPANIES ─────────────────────────────────────────────────────────
// Owner 2026-08-13, verbatim intent: "Company 1 (Houzs Century) 开单必须有
// State。Company 2 (2990) 不需要。其他公司也不必填。以后要加新公司我会再讲."
// Add a company by adding its CODE to LOCATION_REQUIRED_COMPANY_CODES below —
// that list is the whole rule, and there is nothing else to change.
//
// Companies are identified by CODE, never by a hardcoded id, matching
// order-rules.ts' per-company deposit threshold (the established shape for a
// per-company rule here) — the bigint ids differ between staging and prod.
// ----------------------------------------------------------------------------
import type { SaveProblem } from '../shared/so-save-problems';

/**
 * The companies whose Sales Orders must resolve a stock location before they
 * may be created. HOUZS is `companies.code` for company 1 (Houzs Century) —
 * the company whose book the AutoCount write-back feeds.
 *
 * TO ADD A COMPANY: put its `companies.code` in this array. Nothing else.
 */
export const LOCATION_REQUIRED_COMPANY_CODES: readonly string[] = ['HOUZS'];

/**
 * Does this company's order need a stock location?
 *
 * AN UNKNOWN / ABSENT COMPANY CODE IS NOT GATED, deliberately — same reasoning
 * as processingDateThresholdFor's fallback to the looser threshold. A caller
 * that has not been threaded through yet, or a context where the companies
 * master has not resolved, must not silently start refusing orders: under-
 * gating costs one AutoCount refusal that is already visible in the outbox,
 * while over-gating stops the shop floor with no signal at all.
 */
export function companyRequiresStockLocation(companyCode: unknown): boolean {
  const code = String(companyCode ?? '').trim().toUpperCase();
  if (!code) return false;
  return LOCATION_REQUIRED_COMPANY_CODES.includes(code);
}

export type SoLocationFacts = {
  /** Active company code ('HOUZS' | '2990' | ...) — see the note above on an
   *  absent one. */
  companyCode: unknown;
  /** The header's `sales_location` — the warehouse label the State derived, or
   *  an explicit one the caller sent. Blank / null = no location. */
  salesLocation: string | null | undefined;
  /** The order's `customer_state`, used ONLY to tell the two causes apart. */
  customerState: string | null | undefined;
};

/**
 * The one reason this order may not be created, or null when it may.
 *
 * Returns a `SaveProblem` so the routes report it through the SAME aggregated
 * `validation_failed` + `problems[]` contract as the Processing-Date and
 * confirm gates — every SO surface already renders that shape.
 */
export function soLocationProblem(facts: SoLocationFacts): SaveProblem | null {
  if (!companyRequiresStockLocation(facts.companyCode)) return null;
  if (String(facts.salesLocation ?? '').trim() !== '') return null;

  const state = String(facts.customerState ?? '').trim();
  if (!state) {
    return {
      code: 'so_state_required',
      message:
        'Pick the delivery State — it decides which warehouse this order ships from, '
        + 'and an order with no warehouse cannot be created.',
      field: 'State',
    };
  }
  return {
    code: 'so_state_unmapped',
    message:
      `${state} has no warehouse mapped, so this order has no stock location. `
      + 'Ask an administrator to map that State to a warehouse, then save again.',
    field: 'Sales Location',
  };
}

/**
 * IO wrapper for the DRAFT -> live status transition, which holds a doc number
 * rather than a request body. Reads the header the create already wrote.
 *
 * The company read is skipped entirely for a company the rule does not cover,
 * so 2990's transitions pay no extra query.
 */
export async function soLocationProblemForDoc(
  sb: any,
  docNo: string,
  companyCode: unknown,
): Promise<SaveProblem | null> {
  if (!companyRequiresStockLocation(companyCode)) return null;
  const { data } = await sb
    .from('mfg_sales_orders')
    .select('sales_location, customer_state')
    .eq('doc_no', docNo)
    .maybeSingle();
  const h = (data ?? {}) as { sales_location?: string | null; customer_state?: string | null };
  return soLocationProblem({
    companyCode,
    salesLocation: h.sales_location ?? null,
    customerState: h.customer_state ?? null,
  });
}
