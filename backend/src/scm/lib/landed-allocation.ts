// ----------------------------------------------------------------------------
// landed-allocation.ts — fold a SERVICE-line charge ("平摊", e.g. TRANSPORTATION
// / freight) on a GRN into the FIFO lot cost of its GOODS lines.
// Ported verbatim from 2990 apps/api/src/lib/landed-allocation.ts (migration 0191).
//
// The owner adds the freight as a SERVICE line (item_group='service', no
// supplier — a pure description + amount, like the SO "charges"). That charge is
// ALLOCATED across the goods lines and folded into each one's per-unit MYR lot
// cost, so inventory carries the TRUE landed cost.
//
// ALLOCATION BASIS (choosable, grns.allocation_method):
//   · QTY   (default) — lineBasis = qty
//   · VALUE           — lineBasis = qty × baseUnitCostMyr   (goods value in MYR)
//   · CBM             — lineBasis = qty × unit_m3_milli      (volume)
//
// chargePool (MYR sen) = Σ over SERVICE lines of toMyrSen(line amount, grnRate).
// Each goods line's allocated charge = round(chargePool × lineBasis / Σbasis),
// with the LAST goods line absorbing the rounding remainder so
// Σ allocated === chargePool EXACTLY — no sen created or lost.
//
// NO-OP GUARANTEE: chargePool === 0 (no service lines) ⇒ allocated 0 everywhere
// ⇒ landed unit cost === base unit cost (byte-for-byte).
// DIVIDE-BY-ZERO GUARD: Σbasis === 0 (e.g. CBM with all unit_m3 = 0) ⇒ fall back
// to QTY; if QTY Σ is also 0 (no positive-qty goods lines) the pool simply has
// nowhere to land and every allocation is 0.
// ----------------------------------------------------------------------------

import { isServiceLine } from '../shared';
import { toMyrSen } from './fx';

export type AllocationMethod = 'QTY' | 'VALUE' | 'CBM';

/** Normalise an incoming allocation_method to the enum; default QTY. */
export function normalizeAllocationMethod(raw: unknown): AllocationMethod {
  const v = String(raw ?? '').trim().toUpperCase();
  return v === 'VALUE' || v === 'CBM' ? v : 'QTY';
}

/** Minimal shape the allocator needs off each GRN line. */
export interface AllocLine {
  id: string;
  itemGroup: string | null | undefined;
  materialCode: string | null | undefined;
  /** received/accepted qty driving inventory + allocation. */
  qty: number;
  /** line amount in the GRN's OWN currency (unit_price_centi × qty − discount,
   *  or the SERVICE line's charge amount). For goods lines we allocate ONTO the
   *  base MYR cost; for service lines this is the charge to pool. */
  amountCenti: number;
  /** per-unit base cost in the GRN currency (unit_price_centi). */
  unitPriceCenti: number;
  /** product volume m³ × 1000 (mfg_products.unit_m3_milli); 0 when unknown. */
  unitM3Milli: number;
}

export interface AllocatedGoodsLine {
  id: string;
  /** allocated freight for this line, MYR sen (Σ === chargePool exactly). */
  allocatedChargeCenti: number;
  /** base per-unit cost in MYR (unit_price × grnRate). */
  baseUnitCostMyr: number;
  /** landed per-unit cost in MYR = baseUnitCostMyr + round(allocated / qty). */
  landedUnitCostMyr: number;
  qty: number;
}

export interface AllocationResult {
  /** total freight pooled from SERVICE lines, MYR sen. */
  chargePoolMyr: number;
  /** the basis actually used (may fall back to QTY when the chosen basis Σ=0). */
  effectiveMethod: AllocationMethod;
  /** per goods-line allocation + landed cost, keyed in input order. */
  goods: AllocatedGoodsLine[];
}

/**
 * Allocate the SERVICE-line charge pool across the goods lines for one GRN.
 * `grnRate` = MYR per 1 unit of the GRN currency (1 for MYR); converts both the
 * base goods cost and the service charge to MYR. Pure — no I/O.
 */
export function allocateLandedCharges(
  lines: AllocLine[],
  method: AllocationMethod,
  grnRate: unknown,
): AllocationResult {
  const goodsLines = lines.filter((l) => !isServiceLine({ itemGroup: l.itemGroup, itemCode: l.materialCode }));
  const serviceLines = lines.filter((l) => isServiceLine({ itemGroup: l.itemGroup, itemCode: l.materialCode }));

  // Charge pool (MYR) = Σ service-line amounts converted at the GRN rate.
  const chargePoolMyr = serviceLines.reduce(
    (s, l) => s + toMyrSen(Number(l.amountCenti ?? 0), grnRate),
    0,
  );

  // Base MYR per-unit cost per goods line: round(unit_price × rate).
  const base = goodsLines.map((l) => ({
    line: l,
    qty: Math.max(0, Number(l.qty ?? 0)),
    baseUnitCostMyr: toMyrSen(Number(l.unitPriceCenti ?? 0), grnRate),
  }));

  // Pick the basis per line; fall back to QTY if the chosen basis sums to 0
  // (never divide by zero — e.g. CBM with every unit_m3 = 0).
  const basisFor = (m: AllocationMethod, b: (typeof base)[number]): number => {
    if (m === 'VALUE') return b.qty * b.baseUnitCostMyr;
    if (m === 'CBM') return b.qty * Math.max(0, Number(b.line.unitM3Milli ?? 0));
    return b.qty; // QTY
  };
  let effectiveMethod: AllocationMethod = method;
  let sumBasis = base.reduce((s, b) => s + basisFor(effectiveMethod, b), 0);
  if (sumBasis <= 0 && effectiveMethod !== 'QTY') {
    effectiveMethod = 'QTY';
    sumBasis = base.reduce((s, b) => s + basisFor(effectiveMethod, b), 0);
  }

  // Allocate. Running-remainder method: each line gets round(pool × basis / Σ),
  // the LAST goods line absorbs whatever is left so Σ allocated === pool exactly.
  const goods: AllocatedGoodsLine[] = [];
  let allocatedSoFar = 0;
  // The remainder must land on the last line with qty > 0. A trailing qty=0
  // goods line would fold it into a per-unit charge of 0 (round(alloc/0)→0) and
  // the freight would vanish from every lot instead of summing to the pool.
  let lastPositiveIdx = -1;
  for (let k = base.length - 1; k >= 0; k -= 1) { if (base[k]!.qty > 0) { lastPositiveIdx = k; break; } }
  for (let i = 0; i < base.length; i += 1) {
    const b = base[i]!;
    const isLast = i === lastPositiveIdx;
    let alloc: number;
    if (chargePoolMyr === 0 || sumBasis <= 0) {
      // No pool, or nowhere to land it → no allocation anywhere (no-op).
      alloc = 0;
    } else if (isLast) {
      // Last line takes the remainder so the column sums to the pool exactly.
      alloc = chargePoolMyr - allocatedSoFar;
    } else {
      alloc = Math.round((chargePoolMyr * basisFor(effectiveMethod, b)) / sumBasis);
      allocatedSoFar += alloc;
    }
    // Per-unit landed cost: fold the allocated charge in per unit.
    const perUnitCharge = b.qty > 0 ? Math.round(alloc / b.qty) : 0;
    goods.push({
      id: b.line.id,
      allocatedChargeCenti: alloc,
      baseUnitCostMyr: b.baseUnitCostMyr,
      landedUnitCostMyr: b.baseUnitCostMyr + perUnitCharge,
      qty: b.qty,
    });
  }

  return { chargePoolMyr, effectiveMethod, goods };
}
