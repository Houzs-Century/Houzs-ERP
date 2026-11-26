
export type SetLineCategory =
  | 'BEDFRAME'
  | 'MATTRESS'
  | 'SOFA'
  | 'ACCESSORY'
  | 'SERVICE'
  | 'OTHERS';

export interface SetLine {
  category: SetLineCategory | string;
  qty?: number | string | null;
  cancelled?: boolean | null;
}

export interface SetCountResult {
  sets: number;
  hasFurniture: boolean;
  frames: number;
  mattresses: number;
  sofas: number;
}

function qtyOf(v: number | string | null | undefined): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
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
