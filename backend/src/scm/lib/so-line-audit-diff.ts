// ----------------------------------------------------------------------------
// so-line-audit-diff — what changed on a Sales Order LINE, for the audit trail.
//
// Owner 2026-08-12, after 2990-SO-2608-017. The UPDATE_LINE handler used to diff
// a HAND-MAINTAINED list of fields (qty / prices / code / group / description /
// uom / remark / cancelled). `variants` was never on that list, and neither were
// the spec columns the same handler writes. So an edit that changed ONLY a
// line's specification produced an EMPTY diff, and the handler's
// `if (changes.length > 0)` guard skipped the audit write entirely.
//
// That is what happened: LEG 6" was added to two sofa lines at a price that did
// not move (leg_price_sen 0). The write landed, the supplier's already-raised PO
// went stale against it, and the SO's History timeline showed nothing — not a
// vague row, nothing. The single most damaging edit the system allows was the
// one edit it did not record.
//
// THE RULE HERE: the diff is derived from the `updates` object that is ABOUT TO
// BE PERSISTED, not from a parallel list someone has to remember to extend. A
// column added to the handler is audited by construction. A column this module
// has no label for is still audited, under its raw column name — unlabelled but
// recorded beats silently dropped, which is the whole point.
//
// (Same failure shape as the amendment apply white-list, PR #1409: a hand-copy
// whose comment said it MIRRORED another list, which it had stopped doing.)
// ----------------------------------------------------------------------------

import type { FieldChange } from './so-audit';
import { buildVariantSummary } from '../shared/variant-summary';

/** Money columns that are PURE functions of qty / unit price / discount / cost —
 *  all of which are reported in their own right. Listing them too would put five
 *  redundant rows on the timeline for every price edit and bury the field that
 *  actually moved. */
const DERIVED_FROM_REPORTED = new Set([
  'total_centi', 'total_inc_centi', 'balance_centi', 'line_cost_centi', 'line_margin_centi',
]);

/** snake column → the camel label the timeline renderer already knows. LABELS
 *  ONLY: a column missing from this map is still emitted, under its column name.
 *  Do not turn this into an allow-list — that is the bug this module exists to
 *  have removed. */
const LABEL: Record<string, string> = {
  qty: 'qty',
  unit_price_centi: 'unitPriceCenti',
  discount_centi: 'discountCenti',
  unit_cost_centi: 'unitCostCenti',
  item_code: 'itemCode',
  item_group: 'itemGroup',
  description: 'description',
  description2: 'description2',
  uom: 'uom',
  remark: 'remark',
  cancelled: 'cancelled',
  line_delivery_date: 'lineDeliveryDate',
  line_delivery_date_overridden: 'lineDeliveryDateOverridden',
  warehouse_id: 'warehouseId',
  divan_price_sen: 'divanPriceSen',
  leg_price_sen: 'legPriceSen',
  special_order_price_sen: 'specialOrderPriceSen',
  custom_specials: 'customSpecials',
};

/** Loose scalar comparison — null and '' are the same, 5 and '5' are the same.
 *  Avoids noisy diffs from JSON round-tripping through the client. */
function scalarChanged(from: unknown, to: unknown): boolean {
  const a = from == null ? '' : String(from);
  const b = to == null ? '' : String(to);
  return a !== b;
}

/**
 * Field-level changes between the stored line row and the update about to be
 * written. Empty array = nothing moved (the caller should then write no audit
 * row at all).
 *
 * `prevRow` is the snake_case row as read from the DB; `updates` is the
 * snake_case object being handed to `.update()`.
 */
export function soLineFieldChanges(
  prevRow: Record<string, unknown>,
  updates: Record<string, unknown>,
): FieldChange[] {
  const out: FieldChange[] = [];
  const push = (field: string, from: unknown, to: unknown) => {
    out.push({ field, from: from ?? null, to: to ?? null });
  };

  for (const [col, toVal] of Object.entries(updates)) {
    if (DERIVED_FROM_REPORTED.has(col)) continue;
    if (col === 'variants') continue;   // handled below, as a readable spec diff
    if (scalarChanged(prevRow[col], toVal)) push(LABEL[col] ?? col, prevRow[col], toVal);
  }

  /* `variants` is a jsonb blob. Dumping it from→to would put two walls of JSON
     on the timeline and still not say what changed, so render both sides through
     the SAME summariser the document lines use: the row reads
     "EZ-002 / SEAT 24" → "EZ-002 / SEAT 24 / LEG 6\"". buildVariantSummary is
     also what the persisted description2 stores, so the audit and the line can
     never tell different stories about one edit.

     When the summary is UNCHANGED but the object is not, fall back to a
     key-level diff: the summary covers the PHYSICAL attributes, and a change
     outside them (buildKey, cellIndex, an addon note) is still a change to the
     line and must not vanish just because it does not print. */
  if (updates['variants'] !== undefined) {
    const group = String((updates['item_group'] ?? prevRow['item_group']) ?? '');
    const before = (prevRow['variants'] ?? null) as Record<string, unknown> | null;
    const after = (updates['variants'] ?? null) as Record<string, unknown> | null;
    const beforeSummary = buildVariantSummary(group, before) || '';
    const afterSummary = buildVariantSummary(group, after) || '';
    if (beforeSummary !== afterSummary) {
      push('spec', beforeSummary || null, afterSummary || null);
    } else if (JSON.stringify(before ?? null) !== JSON.stringify(after ?? null)) {
      const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort();
      for (const k of keys) {
        const a = (before ?? {})[k];
        const b = (after ?? {})[k];
        if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) push(`variants.${k}`, a, b);
      }
    }
  }

  return out;
}
