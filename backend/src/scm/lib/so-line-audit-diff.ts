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
import { buildVariantSummary, withoutFabricSupplierCode } from '../shared/variant-summary';

const DERIVED_FROM_REPORTED = new Set([
  'total_sen', 'total_inc_sen', 'balance_sen', 'line_cost_sen', 'line_margin_sen',
]);

const LABEL: Record<string, string> = {
  qty: 'qty',
  unit_price_sen: 'unitPriceSen',
  discount_sen: 'discountSen',
  unit_cost_sen: 'unitCostSen',
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
    if (col === 'variants') continue;
    if (scalarChanged(prevRow[col], toVal)) push(LABEL[col] ?? col, prevRow[col], toVal);
  }

  if (updates['variants'] !== undefined) {
    const group = String((updates['item_group'] ?? prevRow['item_group']) ?? '');
    const before = stampless(prevRow['variants']);
    const after = stampless(updates['variants']);
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

const stampless = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' ? withoutFabricSupplierCode(v as Record<string, unknown>) : null;
