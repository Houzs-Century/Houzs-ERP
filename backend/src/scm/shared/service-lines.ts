// ----------------------------------------------------------------------------
// service-lines — pure builders that turn server-computed charges into
// SERVICE SKU line specs (P2 of the SO all-charges-as-SKU-lines spec,
// docs/specs/2026-06-04-so-sku-lines-and-sync-spec.md §4.1 + §4.2).
//
// The MONEY is computed elsewhere (computeSoDeliveryFee for delivery,
// the addons table for dispose/lift) — these builders only decide how the
// amounts decompose into lines (which SKU, qty, unit price, description).
// Pure + shared so the API and tests run the same decomposition.
//
// All amounts here are SEN (the SO ledger unit). The addons table is
// whole-MYR (POS retail convention) — computeAddonServiceLines does the
// ×100 at this boundary.
// ----------------------------------------------------------------------------

import type { SoDeliveryFeeResult } from './pricing';
import {
  SVC_DELIVERY,
  SVC_DELIVERY_CROSS,
  SVC_DELIVERY_ADD,
  SVC_DISPOSE_MATTRESS,
  SVC_DISPOSE_BEDFRAME,
  SVC_LIFT_CARRY,
  SVC_ADDON,
  MAX_LIFT_TIER_FLOOR,
  svcLiftCarryTierSku,
  svcLiftCarryTierName,
} from './service-sku';

/** One SERVICE line to append to a Sales Order. */
export interface ServiceLineSpec {
  itemCode:     string;
  description:  string;
  /** Dynamic per-order detail (cross-order source SO, lift floors×items math).
   *  Lands in mfg_sales_order_lines.remark — Loo 2026-06-10: the description
   *  stays the stable SKU wording; order-specific context belongs in the
   *  Remark column (and prints as its own "Remark:" note line). */
  remark?:      string | null;
  qty:          number;
  /** SEN per unit. */
  unitPriceSen: number;
  /** qty × unitPriceSen — convenience for callers summing the batch. */
  totalSen:     number;
}

/** POS handoff addon selection (mirrors the legacy submitOrder shape —
 *  Handover.tsx form.addons, filtered to selected entries). */
export interface AddonSelectionInput {
  id:           string;
  qty?:         number;
  floorsCount?: number;
  itemsCount?:  number;
}

/** The addons-table row fields the builder needs (whole-MYR prices). */
export interface AddonRowInput {
  id:            string;
  kind:          'qty' | 'floors_items' | 'flat' | string;
  /** Whole MYR. */
  price:         number;
  /** Whole MYR per floor·item (lift). */
  perFloorItem?: number | null;
  label?:        string | null;
  enabled?:      boolean | null;
  /** Migration 0160 — per-add-on SERVICE SKU. Wins over the legacy
   *  ADDON_ID_TO_SERVICE_SKU map; NULL/blank falls through to it, then to
   *  the generic SVC-ADDON. */
  serviceSku?:   string | null;
}

/** POS addon id → dedicated SERVICE SKU code. Migration 0157 (Loo
 *  2026-06-06): an id WITHOUT a dedicated mapping is no longer skipped — it
 *  books under the generic SVC-ADDON SKU with the add-on's label as the line
 *  description, so an admin-created handover add-on charges + prints with
 *  zero code change. (The old silent skip was how 'assemble' could sit in
 *  the frontend list yet never become a line.) */
export const ADDON_ID_TO_SERVICE_SKU: Record<string, string> = {
  'dispose-mattress': SVC_DISPOSE_MATTRESS,
  'dispose-bedframe': SVC_DISPOSE_BEDFRAME,
  'lift':             SVC_LIFT_CARRY,
};

/* Sanity ceilings — a crafted payload must not be able to overflow
   qty × unitPriceSen into precision-loss territory. Generous vs reality
   (no Malaysian walk-up exceeds 50 floors; no order carries 99 pieces). */
export const MAX_LIFT_FLOORS = 50;
export const MAX_LIFT_ITEMS = 99;
export const MAX_ADDON_QTY = 99;

/** Lift pricing rule (matches the shared addonPrice / POS computeAddonTotal):
 *  the first 2 floors are free — chargeable units = max(0, floors − 2) × items.
 *  Inputs are clamped to the sanity ceilings above. */
export const liftChargeableUnits = (floorsCount: number, itemsCount: number): number =>
  Math.max(0, Math.min(MAX_LIFT_FLOORS, Math.floor(floorsCount)) - 2) *
  Math.max(0, Math.min(MAX_LIFT_ITEMS, Math.floor(itemsCount)));

/**
 * Decompose a server-computed delivery fee into SERVICE lines (§4.1).
 *   · base       → SVC-DELIVERY, or SVC-DELIVERY-CROSS on a cross-order
 *                  follow-up (the base IS the reduced cross rate then; the
 *                  REMARK carries the source SO for the audit trail —
 *                  Loo 2026-06-10, description stays the stable SKU wording)
 *   · crossCategory (same-order multi-category surcharge) → SVC-DELIVERY-CROSS
 *   · additional (operator free-form)                     → SVC-DELIVERY-ADD
 * Zero components produce no line; Σ lines === fee.total always.
 */
/** What the OPERATOR owns on the existing SVC-DELIVERY* lines, recovered before
 *  a rebuild discards them (2026-08-19). Two things and only two:
 *
 *  · the free-form additional fee — recovered from the GROSS side (unit × qty,
 *    falling back to total for pre-discount rows). With discounts surviving,
 *    total_sen is NET, and recovering the net as the next gross would compound
 *    the reduction on every save (50 → 30 → 10 across three edits);
 *  · per-line DISCOUNTS, keyed by item_code. The line PATCH accepts a bounded
 *    discount on any line, delivery included — but the rebuild used to write
 *    discount_sen: 0 over it, so the one sanctioned way to REDUCE a delivery
 *    fee was silently undone by the very next derivation ("250 → 125 nuked the
 *    line to 0"). Typing a lower unit price never could hold — the fee is
 *    derived, one truth (owner 2026-08-07) — so the discount is the operator's
 *    reduction, expressed like every other price cut on an SO.
 *
 *  The caller clamps each recovered discount to the REBUILT line's own total
 *  (a fee line can never go negative), and a component that disappears on
 *  rebuild drops its discount rather than migrating it to money it never
 *  named. */
export function recoverOperatorDeliveryState(
  deliveryLines: Array<{ item_code: string; total_sen: number | null; unit_price_sen?: number | null; discount_sen?: number | null; qty?: number | null }>,
): { additionalSen: number; discountByCode: Map<string, number> } {
  const additionalSen = deliveryLines
    .filter((l) => l.item_code === SVC_DELIVERY_ADD)
    .reduce((s, l) => s + (l.unit_price_sen != null
      ? Number(l.unit_price_sen) * Math.max(1, Number(l.qty ?? 1))
      : Number(l.total_sen ?? 0)), 0);
  const discountByCode = new Map<string, number>();
  for (const l of deliveryLines) {
    const d = Math.max(0, Number(l.discount_sen ?? 0));
    if (d > 0) discountByCode.set(l.item_code, (discountByCode.get(l.item_code) ?? 0) + d);
  }
  return { additionalSen, discountByCode };
}

export function buildDeliveryFeeServiceLines(
  fee: SoDeliveryFeeResult,
  crossCategorySourceDocNo?: string | null,
): ServiceLineSpec[] {
  const lines: ServiceLineSpec[] = [];
  const push = (itemCode: string, description: string, amountSen: number, remark?: string) => {
    if (amountSen <= 0) return;
    lines.push({ itemCode, description, remark: remark || null, qty: 1, unitPriceSen: amountSen, totalSen: amountSen });
  };
  if (fee.isFollowup) {
    const src = (crossCategorySourceDocNo ?? '').trim();
    push(
      SVC_DELIVERY_CROSS,
      'Cross-category delivery',
      fee.base,
      src ? `Follow-up of ${src}` : undefined,
    );
  } else {
    push(SVC_DELIVERY, fee.isSpecial ? 'Delivery fee (special model)' : 'Delivery fee', fee.base);
  }
  push(SVC_DELIVERY_CROSS, 'Cross-category delivery', fee.crossCategory);
  push(SVC_DELIVERY_ADD, 'Additional delivery fee', fee.additional);
  return lines;
}

/**
 * Re-price POS handover addons server-side and decompose into SERVICE lines
 * (§4.2 + D6). The client's amounts are never trusted — prices come from the
 * addons table rows the caller just loaded.
 *   · qty kind (dispose-*)  → qty × price
 *   · floors_items (lift)   → per-floor TIER SKU (Loo 2026-06-10): floors
 *                             1..MAX_LIFT_TIER_FLOOR book SVC-LIFT-CARRY-F{n}
 *                             with qty = items and unit = max(floors−2,0) ×
 *                             per_floor_item — so floors 1–2 still produce a
 *                             visible RM0 line (the free band shows on the
 *                             SO). Floors above the ceiling, or a custom
 *                             floors_items addon with its own serviceSku,
 *                             keep the legacy single-SKU decomposition
 *                             (qty = chargeable units × per_floor_item).
 *                             The REMARK spells out "X floors × Y items" so
 *                             the math is auditable on the printed SO (D6 as
 *                             amended 2026-06-10).
 * Disabled / unknown / zero-amount selections are skipped silently (except
 * the lift free band above, which books at RM0 by design).
 */
export function computeAddonServiceLines(
  selections: AddonSelectionInput[],
  addonRows: AddonRowInput[],
): ServiceLineSpec[] {
  const rowById = new Map(addonRows.map((r) => [r.id, r]));
  /* One line per addon id — first selection wins. The POS form is a dict
     keyed by id so real clients can't duplicate; a crafted payload repeating
     an id must not book the charge twice. */
  const seen = new Set<string>();
  const lines: ServiceLineSpec[] = [];
  for (const sel of selections) {
    if (seen.has(sel.id)) continue;
    seen.add(sel.id);
    const row = rowById.get(sel.id);
    if (!row) continue;                       // unknown to the addons catalog
    if (row.enabled === false) continue;      // operator disabled it since
    // Per-row SERVICE SKU first (0160), legacy hardcoded map next, generic
    // SVC-ADDON otherwise (0157).
    const itemCode =
      (row.serviceSku ?? '').trim() || ADDON_ID_TO_SERVICE_SKU[sel.id] || SVC_ADDON;
    const label = (row.label ?? '').trim() || sel.id;
    if (row.kind === 'floors_items') {
      const floors = Math.max(0, Math.floor(sel.floorsCount ?? 0));
      const items  = Math.max(0, Math.min(MAX_LIFT_ITEMS, Math.floor(sel.itemsCount ?? 0)));
      const rateSen = Math.round(Number(row.perFloorItem ?? 0) * 100);
      const remark = `${floors} ${floors === 1 ? 'floor' : 'floors'} × ${items} ${items === 1 ? 'item' : 'items'} (first 2 floors free)`;
      if (itemCode === SVC_LIFT_CARRY && floors >= 1 && floors <= MAX_LIFT_TIER_FLOOR) {
        // Per-floor tier SKU (Loo 2026-06-10). qty = pieces carried; the
        // floor is the SKU. Floors 1–2 book at RM0 on purpose — the free
        // band must SHOW on the SO, not vanish.
        if (items <= 0 || rateSen <= 0) continue;
        const unitSen = Math.max(0, floors - 2) * rateSen;
        lines.push({
          itemCode: svcLiftCarryTierSku(floors),
          description: svcLiftCarryTierName(floors),
          remark,
          qty: items,
          unitPriceSen: unitSen,
          totalSen: items * unitSen,
        });
        continue;
      }
      // Legacy decomposition — floors above the tier ceiling, or a custom
      // floors_items addon with its own serviceSku (whose tier SKUs don't
      // exist in the catalog; minting one here would 409 the order).
      const units = liftChargeableUnits(floors, items);
      if (units <= 0 || rateSen <= 0) continue;
      lines.push({
        itemCode,
        description: label,
        remark,
        qty: units,
        unitPriceSen: rateSen,
        totalSen: units * rateSen,
      });
    } else {
      // 'qty' (and a defensive 'flat' fallback: qty=1). Clamped to the
      // sanity ceiling so qty × unitPriceSen can't blow up.
      const qty = row.kind === 'qty' ? Math.min(MAX_ADDON_QTY, Math.max(1, Math.floor(sel.qty ?? 1))) : 1;
      const unitSen = Math.round(Number(row.price ?? 0) * 100);
      if (unitSen <= 0) continue;
      lines.push({
        itemCode,
        description: label,
        qty,
        unitPriceSen: unitSen,
        totalSen: qty * unitSen,
      });
    }
  }
  return lines;
}
