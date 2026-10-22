// ----------------------------------------------------------------------------
// supplier-sku-helpers — derive a per-SKU `supplier_sku` from a Model-level
// supplier code.
//
// Context (Commander 2026-05-27): the Model-first supplier-mapping flow
// (PR #206 / #209) lets commander type ONE supplier code at the Model row,
// then fans the binding out across every ACTIVE SKU under that Model. The
// initial implementation wrote the SAME literal code into each binding's
// `supplier_sku` column — so 16 BOOQIT SKUs ended up with `supplier_sku =
// "5539"`. Commander's spec:
//
//   > 我填写了 5539 — 为什么不是 5539-1A(LHF) 这样? 然后又可以给我修改.
//
// New rule: per-SKU supplier_sku = `${baseCode}-${suffix}` where suffix is
// derived from the SKU itself. Sofa → compartment ("1A(LHF)"); bedframe /
// mattress → size_code ("K", "Q"); accessory / service → no suffix (the
// base code alone is the supplier's SKU). Fallback: extract the trailing
// segment of `code` after the first '-'.
//
// Pure functions — UI-only helper, no I/O. Mirror exists nowhere on the
// server because the write path goes through /bindings/batch which just
// persists whatever supplier_sku the client computed.
// ----------------------------------------------------------------------------

import type { MfgProductRow } from './mfg-products-queries';
import { isSingleSkuCategory } from '../../shared/product-categories';

/**
 * Derive the per-SKU suffix appended after the Model-level supplier code.
 *
 *   Sofa SKU      → fall back to code suffix (compartment, e.g. "1A(LHF)")
 *   Bedframe SKU  → mfg_products.size_code (e.g. "K") OR code suffix
 *   Mattress SKU  → mfg_products.size_code (e.g. "K") OR code suffix
 *   Accessory     → "" (commander's spec — no suffix)
 *   Service       → "" (no suffix)
 *
 * Code-suffix fallback rules:
 *   "BOOQIT-1A(LHF)" → "1A(LHF)"
 *   "1005-(K)"       → "(K)"
 *   "1003"           → ""  (no dash → leave bare)
 *
 * Returns the empty string when no meaningful suffix can be derived; the
 * dialog should then write the baseCode verbatim rather than appending
 * a dangling "-".
 */
export function suffixForSku(p: Pick<MfgProductRow, 'code' | 'category' | 'size_code'>): string {
  // Single-SKU categories (Accessory, Sofa Accessory, Service, ...) — no per-SKU
  // suffix, the supplier code IS the SKU. "BC06-MF" is a whole model code, not
  // a sofa compartment.
  if (isSingleSkuCategory(p.category)) return '';

  // BEDFRAME / MATTRESS — prefer the canonical size_code if the API row
  // surfaces it. Falls through to code parsing for legacy rows where
  // size_code wasn't backfilled.
  if ((p.category === 'BEDFRAME' || p.category === 'MATTRESS') && p.size_code) {
    return p.size_code.trim();
  }

  // SOFA (or any row missing size_code) — parse the trailing segment after
  // the first '-' from the SKU code. Sofa codes follow the
  // '{model_code}-{compartment}' default; bedframe codes follow
  // '{model_code}-({size})'. Either way, everything after the first '-' is
  // the per-SKU bit we want to mirror into the supplier SKU.
  const code = p.code ?? '';
  const dashAt = code.indexOf('-');
  if (dashAt < 0) return '';
  return code.slice(dashAt + 1).trim();
}

/**
 * Compose the final supplier_sku written into a binding row. Joins baseCode
 * with the SKU-derived suffix using a single '-' separator; returns the
 * baseCode verbatim when there's no suffix (accessory / service / orphan
 * SKU). baseCode is trimmed; empty baseCode returns ''.
 */
export function composeSupplierSku(
  baseCode: string,
  p: Pick<MfgProductRow, 'code' | 'category' | 'size_code'>,
): string {
  const base = baseCode.trim();
  if (!base) return '';
  const suffix = suffixForSku(p);
  if (!suffix) return base;
  return `${base}-${suffix}`;
}

/**
 * Detect whether a binding's existing supplier_sku looks like it lacks a
 * per-SKU suffix — i.e. the supplier_sku exactly equals the bare
 * model-level code with no '-' separator. Used to surface the
 * "Auto-suffix supplier_sku" cleanup button on the SKU Mappings table
 * after the literal-"5539" bug in PR #206/#209.
 *
 * We can't perfectly detect "missing suffix" because the supplier might
 * legitimately use a code without a dash (e.g. "5539"). So the heuristic
 * is: same supplier_sku appears across ≥2 bindings under the same
 * supplier, AND the supplier_sku itself contains no '-'. The caller (the
 * SKU Mappings table) handles the grouping.
 */
export function looksAmbiguous(supplierSku: string | null | undefined): boolean {
  if (!supplierSku) return false;
  return !supplierSku.includes('-');
}
