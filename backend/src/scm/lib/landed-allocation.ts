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
  itemCode: string | null | undefined;
  qty: number;
  amountSen: number;
  unitPriceSen: number;
  unitM3Milli: number;
}

export interface AllocatedGoodsLine {
  id: string;
  allocatedChargeSen: number;
  baseUnitCostMyr: number;
  landedUnitCostMyr: number;
  qty: number;
}

export interface AllocationResult {
  chargePoolMyr: number;
  effectiveMethod: AllocationMethod;
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
  const goodsLines = lines.filter((l) => !isServiceLine({ itemGroup: l.itemGroup, itemCode: l.itemCode }));
  const serviceLines = lines.filter((l) => isServiceLine({ itemGroup: l.itemGroup, itemCode: l.itemCode }));

  const chargePoolMyr = serviceLines.reduce(
    (s, l) => s + toMyrSen(Number(l.amountSen ?? 0), grnRate),
    0,
  );

  const base = goodsLines.map((l) => ({
    line: l,
    qty: Math.max(0, Number(l.qty ?? 0)),
    baseUnitCostMyr: toMyrSen(Number(l.unitPriceSen ?? 0), grnRate),
  }));

  const basisFor = (m: AllocationMethod, b: (typeof base)[number]): number => {
    if (m === 'VALUE') return b.qty * b.baseUnitCostMyr;
    if (m === 'CBM') return b.qty * Math.max(0, Number(b.line.unitM3Milli ?? 0));
    return b.qty;
  };
  let effectiveMethod: AllocationMethod = method;
  let sumBasis = base.reduce((s, b) => s + basisFor(effectiveMethod, b), 0);
  if (sumBasis <= 0 && effectiveMethod !== 'QTY') {
    effectiveMethod = 'QTY';
    sumBasis = base.reduce((s, b) => s + basisFor(effectiveMethod, b), 0);
  }

  const goods: AllocatedGoodsLine[] = [];
  let allocatedSoFar = 0;
  let lastPositiveIdx = -1;
  for (let k = base.length - 1; k >= 0; k -= 1) { if (base[k]!.qty > 0) { lastPositiveIdx = k; break; } }
  for (let i = 0; i < base.length; i += 1) {
    const b = base[i]!;
    const isLast = i === lastPositiveIdx;
    let alloc: number;
    if (chargePoolMyr === 0 || sumBasis <= 0) {
      alloc = 0;
    } else if (isLast) {
      alloc = chargePoolMyr - allocatedSoFar;
    } else {
      alloc = Math.round((chargePoolMyr * basisFor(effectiveMethod, b)) / sumBasis);
      allocatedSoFar += alloc;
    }
    const perUnitCharge = b.qty > 0 ? Math.round(alloc / b.qty) : 0;
    goods.push({
      id: b.line.id,
      allocatedChargeSen: alloc,
      baseUnitCostMyr: b.baseUnitCostMyr,
      landedUnitCostMyr: b.baseUnitCostMyr + perUnitCharge,
      qty: b.qty,
    });
  }

  return { chargePoolMyr, effectiveMethod, goods };
}
