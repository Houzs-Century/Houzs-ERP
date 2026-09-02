// ----------------------------------------------------------------------------
// so-list-mrp-enrichment — the SO-list per-doc fields that DEPEND on the global
// MRP allocation, assembled in ONE pure step so the list handler and the
// deferred enrichment endpoint cannot disagree.
//
// WHY THIS EXISTS. Opening the Sales Orders list ran a full `computeMrp` on the
// critical path (backend/src/scm/routes/mfg-sales-orders.ts), and that engine
// paginates the company's whole `mfg_products` / `inventory_balances` /
// `purchase_order_items` / `mfg_sales_order_items` tables — the dominant cost of
// the list load. It was believed to exist ONLY for the READY-side "PO No."
// source chips, but its result (`mrpLineCoverage`) also feeds the readiness
// verdict the list rolls up, and that verdict drives FOUR frontend-visible
// fields, not one:
//
//   source_po_union / source_po_adj  the READY-side source-PO chips
//                                    (unionSoLineChips, READY arm)
//   stock_remark                     desktop StockRemarkPill column
//   is_main_ready                    mobile readiness badge
//   planning_state                   mobile planning badge (derivePlanningState,
//                                    via readiness.isShipReady)
//
// So the list can render IMMEDIATELY with the stored-status fallbacks (the
// behaviour every one of these fields had before the 2026-08-17 MRP union
// landed — `liveState: null` means "the stored value stands", see
// so-line-effective-stock.ts), and this module recomputes the four with the
// live coverage a beat later. This function is the SHARED derivation both the
// endpoint (with coverage) and the tests use; feeding it the same inputs the
// old inline list path fed its helpers reproduces the old answer exactly.
//
// PURE. No database access — every read the endpoint needs is done in the route
// and handed in. That keeps the parity provable in a unit test.
// ----------------------------------------------------------------------------

import { readinessLinesByDoc } from './so-line-effective-stock';
import { attachLineCategories } from './so-readiness-category';
import { summariseReadiness } from './so-readiness';
import { unionSoLineChips, type ReadySourceChip } from './source-po-trace';
import { derivePlanningState } from '../routes/delivery-planning';

/** The MRP-dependent slice of one SO-list row, keyed by doc_no. Every field
 *  here is a value the list used to compute inline from `computeMrp`; the list
 *  now emits a stored-status placeholder for each and this overlay heals it. */
export type SoListMrpEnrichment = {
  /** READY-arm source-PO union (the SHIPPED arm stays inline on the list and is
   *  merged with this on the client — set union, so order-free). */
  sourcePoReady: string[];
  /** True when a READY chip resolved to a stock ADJUSTMENT rather than a PO. */
  sourcePoAdj: boolean;
  /** Desktop StockRemarkPill label (empty string when nothing is ready). */
  stockRemark: string;
  /** Mobile readiness badge input (summariseReadiness.isMainReady). */
  isMainReady: boolean;
  /** Mobile planning badge (derivePlanningState). */
  planningState: string;
};

/* C16 GUARD twin — see MRP_DERIVED_LIST_FIELD_MAP in
   `frontend/src/lib/soListEnrichment.ts`. This is the payload-key set the
   endpoint returns; `assembleSoListMrpEnrichment` populates EXACTLY these, and
   `backend/tests/soListMrpEnrichment.test.ts` pins that. So the endpoint's shape
   cannot gain or lose an MRP-derived field without the guard failing — which is
   how a field that heals on desktop but stays stored-only on mobile (or the
   reverse) is caught in CI instead of in production. Order matches the frontend
   map's values. */
export const SO_LIST_MRP_ENRICHMENT_KEYS = [
  'sourcePoReady',
  'sourcePoAdj',
  'stockRemark',
  'isMainReady',
  'planningState',
] as const satisfies readonly (keyof SoListMrpEnrichment)[];

/* Exhaustive both ways at COMPILE time: a key added to SoListMrpEnrichment
   without being listed above (or vice-versa) is a type error here. */
type _KeysCoverPayload = keyof SoListMrpEnrichment extends (typeof SO_LIST_MRP_ENRICHMENT_KEYS)[number] ? true : never;
const _keysCoverPayload: _KeysCoverPayload = true;
void _keysCoverPayload;

/** One SO line, exactly the columns readiness + the chip union read. */
export type EnrichmentItem = {
  id: string;
  doc_no: string;
  item_group: string | null;
  item_code: string | null;
  stock_status: string | null;
  cancelled?: boolean | null;
};

/** The per-doc header inputs `derivePlanningState` needs that are NOT
 *  MRP-derived (status, the manual delivery_state override, and the effective
 *  delivery date). Read once from the base table by the route. */
export type EnrichmentHeader = {
  status: string | null;
  storedOverride: string | null;
  effectiveDD: string | null;
};

/**
 * Assemble the four MRP-dependent list fields per doc_no. PURE — the caller has
 * already run `computeMrp` and every DB read; this only combines them through
 * the SAME shared helpers the list handler used inline.
 *
 * `coverage` is `mrpLineCoverage(mrp)`'s output (or `null` when MRP failed — the
 * readiness then falls back to stored status, identical to the list's fail-soft
 * path). `readyByItem` is `soLineReadySourcePos(...)`'s output.
 */
export function assembleSoListMrpEnrichment(input: {
  docNos: string[];
  items: EnrichmentItem[];
  coverage: Map<string, { source: string }> | null;
  /** normalised (normCategory) catalog category per code, as the list builds it
   *  for its Branding pill and reuses for readiness. */
  categoryByCode: ReadonlyMap<string, string>;
  readyByItem: Map<string, ReadySourceChip[]>;
  fullyShippedItemIds: Set<string>;
  headers: Map<string, EnrichmentHeader>;
  delivered: Map<string, number>;
  remaining: Map<string, number>;
  today: string;
  /** doc_nos whose order has a processing date — the promotion gate
   *  readinessLinesByDoc enforces. `null` = caller cannot say (strict: the
   *  live-'stock' promotion is then off for every line). */
  processedDocs: ReadonlySet<string> | null;
}): Map<string, SoListMrpEnrichment> {
  const {
    docNos, items, coverage, categoryByCode, readyByItem,
    fullyShippedItemIds, headers, delivered, remaining, today, processedDocs,
  } = input;

  // READY-arm source-PO union per doc — the SHIPPED map is intentionally empty:
  // the list keeps the shipped arm inline. Union(shipped-only, ready-only) over
  // a doc equals the old combined union (set union is associative), and the adj
  // flags OR back together on the client. This is the exact old READY answer.
  const readyUnion = unionSoLineChips(
    items.map((it) => ({ id: it.id, docNo: it.doc_no })),
    new Map(),
    readyByItem,
    fullyShippedItemIds,
  );

  // Readiness — the SAME two calls the list makes, but with the LIVE coverage so
  // the label reflects goods the stored status has not caught up to yet.
  const linesByDoc = readinessLinesByDoc(items, coverage, processedDocs);
  attachLineCategories(linesByDoc.values(), categoryByCode);

  const out = new Map<string, SoListMrpEnrichment>();
  for (const docNo of docNos) {
    const lines = linesByDoc.get(docNo) ?? [];
    const readiness = summariseReadiness(lines);
    const hdr = headers.get(docNo);
    const planningState = derivePlanningState({
      storedOverride: hdr?.storedOverride ?? null,
      status: hdr?.status ?? null,
      readiness: { isShipReady: readiness.isShipReady },
      delivered: delivered.get(docNo) ?? 0,
      remaining: remaining.get(docNo) ?? 0,
      effectiveDD: hdr?.effectiveDD ?? null,
      today,
    });
    const ru = readyUnion.get(docNo);
    out.set(docNo, {
      sourcePoReady: ru?.pos ?? [],
      sourcePoAdj: ru?.adj ?? false,
      stockRemark: readiness.stockRemark,
      isMainReady: readiness.isMainReady,
      planningState,
    });
  }
  return out;
}
