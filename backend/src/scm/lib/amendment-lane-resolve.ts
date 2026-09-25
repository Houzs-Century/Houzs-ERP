// amendment-lane-resolve — the ONE place that turns a submitted SO amendment
// payload into its lane split, reading what the pure rule cannot know:
//
//   an EXISTING line's item_code + item_group, from the order's own rows;
//   an ADDED line's catalogue category, from mfg_products in the order's company
//   (docs/bugs/0895 — a bare service code such as TRANSPORTATION CHARGES has no
//   row of its own yet, so the category is the only thing that says "service").
//
// It exists because two routes now need the same answer: the submit route
// (routes/mfg-sales-orders.ts POST /:docNo/amendments), which stores the lane,
// and the lane PREVIEW (routes/so-amendment-lane-preview.ts), which shows the
// requester where the request will go BEFORE they submit — owner 2026-09-15,
// option B of 「可以给我选项选择approver?」. A preview computed by a second copy
// of this logic would be the drift the lane table was built to prevent: the
// requester would be told one desk and the row would land on another.
//
// `null` means a read FAILED. The caller refuses rather than classifying on
// nothing — an empty identity reads as "not a service", which is the mis-route
// this module's inputs exist to stop.

import { splitAmendmentByLane, type LaneSplit, type AmendmentLane } from '../shared/amendment-lane';
import { catalogCategoriesByCode } from './validate-item-codes';
import { amendmentLinePriceOnly, type NoopCheckLine, type StoredLine } from './amendment-noop-lines';

/** A submitted line, from the caller's payload — the same shape the no-op drop
 *  reads, because the price-lane carve-out compares the SAME requested fields
 *  against the stored line that no-op detection does. */
export type LaneResolvableLine = NoopCheckLine;

/** The stored SO line, read once: its identity (item_code / item_group) answers
 *  service-vs-product, and its money/spec fields let amendmentLinePriceOnly tell
 *  a price-only change from a spec one. */
type StoredLineRow = StoredLine & { item_group: string | null };

export async function resolveAmendmentLaneSplit<L extends LaneResolvableLine>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SCM PostgREST client is untyped at every call site in this tree.
  sb: any,
  docNo: string,
  companyId: number | null | undefined,
  headerChanges: Record<string, string | null>,
  lines: L[],
  /** True only on a PRICE_LANE_COMPANY_CODES company. Required so the
   *  price carve-out is never a silent default — the caller reads the ACTIVE
   *  company code and decides. */
  priceLaneEnabled: boolean,
): Promise<LaneSplit<L> | null> {
  const referencedIds = [...new Set(lines
    .map((l) => l.salesOrderItemId)
    .filter((x): x is string => typeof x === 'string' && x.length > 0))];
  const storedById = new Map<string, StoredLineRow>();
  if (referencedIds.length > 0) {
    const { data, error } = await sb.from('mfg_sales_order_items')
      .select('id, item_code, item_group, qty, unit_price_sen, variants, remark, discount_sen')
      .eq('doc_no', docNo).in('id', referencedIds);
    if (error) return null;
    for (const r of (data ?? []) as StoredLineRow[]) storedById.set(r.id, r);
  }
  const addedCategory = await catalogCategoriesByCode(
    sb, lines.filter((l) => !l.salesOrderItemId).map((l) => l.newItemCode), companyId,
  );
  if (!addedCategory) return null;
  return splitAmendmentByLane(
    headerChanges,
    lines,
    (l) => {
      if (l.salesOrderItemId) {
        const stored = storedById.get(l.salesOrderItemId);
        return stored ? { itemCode: stored.item_code, itemGroup: stored.item_group } : {};
      }
      return { itemCode: l.newItemCode, category: addedCategory.get((l.newItemCode ?? '').trim()) ?? null };
    },
    (l) => {
      // Price-only is a property of a CHANGE to an EXISTING line: an ADD has no
      // stored line to compare against, so it is never price-only (it is a whole
      // new LINE that a service/product classification already placed).
      const stored = l.salesOrderItemId ? storedById.get(l.salesOrderItemId) : undefined;
      return stored ? amendmentLinePriceOnly(l, stored) : false;
    },
    priceLaneEnabled,
  );
}

/** The preview's answer: which lanes, and how much of the request each takes.
 *  Counts, not the lines themselves — the client already holds the lines. */
export type LaneSplitSummary = {
  lanes: AmendmentLane[];
  perLane: Record<AmendmentLane, { lineCount: number; headerKeys: string[] }>;
};

export function summarizeLaneSplit<L>(split: LaneSplit<L>): LaneSplitSummary {
  const one = (lane: AmendmentLane) => ({
    lineCount: split.perLane[lane].lines.length,
    headerKeys: [...split.perLane[lane].headerKeys],
  });
  return { lanes: [...split.lanes], perLane: { LINES: one('LINES'), DELIVERY: one('DELIVERY'), PRICE: one('PRICE') } };
}
