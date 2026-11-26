
import type { SofaPriceTier } from './sofa-combo-pricing';

/** Map free text → canonical tier, or null when unrecognisable.
 *  Accepts: PRICE_1 / PRICE 1 / PRICE1 / P1 / 1  (and the 2 / 3 / 4 variants). */
export function normalizeSofaTier(raw: unknown): SofaPriceTier | null {
  if (raw == null) return null;
  const s = String(raw).trim().toUpperCase().replace(/[\s_-]+/g, '');
  if (s === 'PRICE1' || s === 'P1' || s === '1') return 'PRICE_1';
  if (s === 'PRICE2' || s === 'P2' || s === '2') return 'PRICE_2';
  if (s === 'PRICE3' || s === 'P3' || s === '3') return 'PRICE_3';
  if (s === 'PRICE4' || s === 'P4' || s === '4') return 'PRICE_4';
  return null;
}
