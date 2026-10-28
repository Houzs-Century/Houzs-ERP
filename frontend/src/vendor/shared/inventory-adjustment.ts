// Vendored VERBATIM from packages/shared/src/inventory-adjustment.ts — the
// stock-movements wave (StockAdjustmentNew INCREASE Save gate). Pure (no I/O,
// no supabase); its only dependency is ./so-variant-rule, also vendored.
//
// ----------------------------------------------------------------------------
// inventory-adjustment — shared validation for a manual stock ADJUSTMENT that
// INCREASES stock (a "found / recount up" correction behaves like a tiny GRN:
// the new stock must carry the same variant attributes + batch that a real
// receipt would, or it lands in the wrong bucket and — for sofa — can never be
// allocated to an order (sofa allocation only sees lots with a batch_no).
//
// Used by BOTH the frontend Save gate (apps/backend StockAdjustmentNew) and the
// backend POST /inventory/adjustments 422 gate, so the operator sees the SAME
// plain-language reason at both points (per the unified-validation rule). Pure —
// no I/O. Decrease adjustments don't use this: they pick an EXISTING stock bucket
// (variant + batch) from the picker, so their attributes are inherently valid;
// their only gate is "qty <= available", which is DB-side.
// ----------------------------------------------------------------------------

import { missingVariantAxes } from './so-variant-rule';

/** Sofa is colour-matched and shipped as a batched set — its stock is invisible
 *  to the allocator without a batch_no. */
export function isSofaItemGroup(itemGroup: string | null | undefined): boolean {
  return (itemGroup ?? '').toLowerCase() === 'sofa';
}

/**
 * Plain-language reasons an INCREASE adjustment can't be saved yet — [] when OK.
 *   • Sofa / Bedframe must carry their category variant attributes (same axes a
 *     GRN requires) so the found stock matches the order lines that need them.
 *   • Sofa additionally needs a Batch Number, or the stock can never be
 *     allocated to a sales order later.
 */
export function adjustmentIncreaseErrors(
  itemGroup: string | null | undefined,
  variants: Record<string, unknown> | null | undefined,
  batchNo: string | null | undefined,
  /* The SKU. A DIVAN ONLY / adjustable / bunk frame has no divan base, so it
     has no Divan Height, Leg Height or Gap to state — the same exemption the
     order forms apply, which this gate silently lacked while itemCode was an
     optional parameter nobody here passed. */
  itemCode: string | null,
): string[] {
  const errors: string[] = [];

  const missing = missingVariantAxes(itemGroup, variants, itemCode);
  if (missing.length > 0) {
    const labels = missing.map((m) => m.label).join(', ');
    const cat = (itemGroup ?? '').toLowerCase();
    errors.push(`Fill the ${labels} for this ${cat || 'item'} so the found stock matches the right orders.`);
  }

  if (isSofaItemGroup(itemGroup) && !(batchNo ?? '').trim()) {
    errors.push('Sofa stock needs a Batch Number, otherwise it can never be allocated to an order later.');
  }

  return errors;
}
