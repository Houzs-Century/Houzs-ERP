// ----------------------------------------------------------------------------
// sofa-tier — recognise a sofa price TIER from free text on a CSV import.
//
// A sofa carries prices per (size × tier), tier ∈ PRICE_1 | PRICE_2 | PRICE_3.
// The SKU export writes the canonical `PRICE_2`, but an operator may hand-edit
// the price_tier column to "P2", "Price 2", or "2". This maps the common forms
// to the canonical tier and returns null for anything it can't recognise — so
// the importer can REJECT a mislabelled row instead of silently filing its
// prices under the wrong tier (or dropping them). Pure — shared by the backend
// import dialog and the API batch-import gate so both speak the same rule.
// ----------------------------------------------------------------------------

import type { SofaPriceTier } from './sofa-combo-pricing';

/** Map free text → canonical tier, or null when unrecognisable.
 *  Accepts: PRICE_1 / PRICE 1 / PRICE1 / P1 / 1  (and the 2 / 3 variants). */
export function normalizeSofaTier(raw: unknown): SofaPriceTier | null {
  if (raw == null) return null;
  const s = String(raw).trim().toUpperCase().replace(/[\s_-]+/g, '');
  if (s === 'PRICE1' || s === 'P1' || s === '1') return 'PRICE_1';
  if (s === 'PRICE2' || s === 'P2' || s === '2') return 'PRICE_2';
  if (s === 'PRICE3' || s === 'P3' || s === '3') return 'PRICE_3';
  return null;
}
