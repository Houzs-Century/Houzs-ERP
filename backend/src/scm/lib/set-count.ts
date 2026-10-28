// ---------------------------------------------------------------------------
// set-count.ts — derive an order's "SET COUNT" for capacity packing. PURE,
// unit-tested. Fleet Module A1.
//
// The owner's primary capacity unit is the SET: a bed set = one frame + one
// mattress. Ten sets fill a lorry (the default ceiling). This module turns an
// SO's line items into that count so the packer can fill lorries by sets, with a
// revenue fallback for orders that carry no counted furniture (accessories /
// service only).
//
// The rule, deliberately simple and defensible:
//   - A frame pairs with a mattress into ONE set. N frames + N mattresses = N
//     sets. An unpaired frame OR an unpaired mattress still occupies a slot, so
//     the counted beds = MAX(totalFrameQty, totalMattressQty).
//   - A sofa is its own bulky slot: + totalSofaQty.
//   - Accessories / service / others do NOT count toward the set ceiling — an
//     order made only of those has hasFurniture=false and the packer uses its
//     revenue instead.
//
// Category comes in already resolved (BEDFRAME / MATTRESS / SOFA / ...), exactly
// as delivery-planning.ts resolves it (mfg_products.category -> normCategory,
// with the line's item_group as the fallback). Cancelled lines are excluded.
// ---------------------------------------------------------------------------

export type SetLineCategory =
  | 'BEDFRAME'
  | 'MATTRESS'
  | 'SOFA'
  | 'ACCESSORY'
  | 'SERVICE'
  | 'OTHERS';

export interface SetLine {
  category: SetLineCategory | string;
  /** Ordered quantity for the line. Non-finite / missing counts as 0. */
  qty?: number | string | null;
  cancelled?: boolean | null;
}

export interface SetCountResult {
  /** The capacity unit count: max(frames, mattresses) + sofas. */
  sets: number;
  /** True when the order carries ANY counted furniture (frame/mattress/sofa).
   *  False => the packer falls back to the revenue ceiling for this order. */
  hasFurniture: boolean;
  frames: number;
  mattresses: number;
  sofas: number;
}

function qtyOf(v: number | string | null | undefined): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // Furniture ships in whole units; round to the nearest whole to be safe.
  return Math.round(n);
}

/**
 * Count an order's sets from its resolved line items. PURE.
 *
 * sets = max(Σ frame qty, Σ mattress qty) + Σ sofa qty.
 * hasFurniture = any of frame/mattress/sofa qty > 0.
 */
export function deriveSetCount(lines: readonly SetLine[]): SetCountResult {
  let frames = 0;
  let mattresses = 0;
  let sofas = 0;
  for (const line of lines) {
    if (line?.cancelled) continue;
    const q = qtyOf(line?.qty);
    if (q === 0) continue;
    const cat = String(line?.category ?? '').toUpperCase();
    if (cat === 'BEDFRAME') frames += q;
    else if (cat === 'MATTRESS') mattresses += q;
    else if (cat === 'SOFA') sofas += q;
  }
  const sets = Math.max(frames, mattresses) + sofas;
  return { sets, hasFurniture: sets > 0, frames, mattresses, sofas };
}
