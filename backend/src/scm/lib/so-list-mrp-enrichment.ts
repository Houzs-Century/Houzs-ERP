
import { readinessLinesByDoc } from './so-line-effective-stock';
import { attachLineCategories } from './so-readiness-category';
import { summariseReadiness } from './so-readiness';
import { unionSoLineChips, type ReadySourceChip } from './source-po-trace';
import { derivePlanningState } from '../routes/delivery-planning';

/** The MRP-dependent slice of one SO-list row, keyed by doc_no. Every field
 *  here is a value the list used to compute inline from `computeMrp`; the list
 *  now emits a stored-status placeholder for each and this overlay heals it. */
export type SoListMrpEnrichment = {
  sourcePoReady: string[];
  sourcePoAdj: boolean;
  stockRemark: string;
  isMainReady: boolean;
  planningState: string;
};

export const SO_LIST_MRP_ENRICHMENT_KEYS = [
  'sourcePoReady',
  'sourcePoAdj',
  'stockRemark',
  'isMainReady',
  'planningState',
] as const satisfies readonly (keyof SoListMrpEnrichment)[];

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
  warehouse_id?: string | null;
};

/** The per-doc header inputs `derivePlanningState` needs that are NOT
 *  MRP-derived (status, the manual delivery_state override, the effective
 *  delivery date and the sales exemption expiry). Read once from the base table by the route. */
export type EnrichmentHeader = {
  status: string | null;
  storedOverride: string | null;
  effectiveDD: string | null;
  amendedDD: string | null;
  salesExemptionExpiry: string | null;
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
  categoryByCode: ReadonlyMap<string, string>;
  readyByItem: Map<string, ReadySourceChip[]>;
  fullyShippedItemIds: Set<string>;
  headers: Map<string, EnrichmentHeader>;
  delivered: Map<string, number>;
  remaining: Map<string, number>;
  today: string;
  processedDocs: ReadonlySet<string> | null;
  /** Display / showroom / service warehouse ids (owner ruling 2026-09-08) — a
   *  line standing in one of these is never rolled up as READY. REQUIRED and
   *  `| null` rather than optional: a caller that cannot load the warehouse
   *  master types the null and says so. */
  nonSellingWarehouseIds: ReadonlySet<string> | null;
}): Map<string, SoListMrpEnrichment> {
  const {
    docNos, items, coverage, categoryByCode, readyByItem,
    fullyShippedItemIds, headers, delivered, remaining, today, processedDocs,
    nonSellingWarehouseIds,
  } = input;

  const readyUnion = unionSoLineChips(
    items.map((it) => ({ id: it.id, docNo: it.doc_no })),
    new Map(),
    readyByItem,
    fullyShippedItemIds,
  );

  const linesByDoc = readinessLinesByDoc(items, coverage, processedDocs, nonSellingWarehouseIds);
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
      amendedDD: hdr?.amendedDD ?? null,
      salesExemptionExpiry: hdr?.salesExemptionExpiry ?? null,
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
