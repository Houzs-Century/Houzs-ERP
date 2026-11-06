/* The rules of a batch combo write, kept pure so they can be tested without a
 * database. Combos are append-only: every change is a new row, and a combo at
 * one Price is the newest row of its tuple. */

export type HeightPrices = Record<string, number | null>;

/** The row that holds a tuple's current prices: newest effective date, then newest
 *  creation, the same order the list reads. */
export function newestComboRow<T extends { effective_from: string; created_at: string }>(rows: readonly T[]): T | null {
  let best: T | null = null;
  for (const r of rows) {
    if (!best) { best = r; continue; }
    if (r.effective_from > best.effective_from) best = r;
    else if (r.effective_from === best.effective_from && r.created_at > best.created_at) best = r;
  }
  return best;
}

export type MergedPrices = {
  prices: HeightPrices;
  /** Any cell ends up different from what the row holds. */
  changed: boolean;
  /** Heights that held a price and lose it. */
  removed: string[];
};

/** Apply `changes` over `current`. A height not named keeps its price, and null
 *  takes the price away, so a blank Excel cell can never clear one. */
export function mergeComboPrices(current: HeightPrices | null, changes: HeightPrices): MergedPrices {
  const prices: HeightPrices = { ...(current ?? {}) };
  const removed: string[] = [];
  let changed = false;
  for (const [height, next] of Object.entries(changes)) {
    const had = prices[height] ?? null;
    if (had === next) continue;
    if (next === null) removed.push(height);
    prices[height] = next;
    changed = true;
  }
  return { prices, changed, removed };
}

/** The selling grid after heights lose their price: comboChargedPrices would keep
 *  charging a selling entry that outlives its cost. */
export function clearHeights(grid: HeightPrices | null, heights: readonly string[]): HeightPrices {
  const out: HeightPrices = { ...(grid ?? {}) };
  for (const h of heights) if (h in out) out[h] = null;
  return out;
}

export const hasAnyPrice = (grid: HeightPrices | null | undefined): boolean =>
  Object.values(grid ?? {}).some((v) => v !== null && v !== undefined);
