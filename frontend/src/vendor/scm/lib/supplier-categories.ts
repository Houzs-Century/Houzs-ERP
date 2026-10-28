// ----------------------------------------------------------------------------
// Supply Category helpers (owner spec 2026-06-12).
//
// A supplier can supply MULTIPLE categories (e.g. sofa + bedframe). Storage
// stays the existing `suppliers.category` text column — values are comma-
// joined ("Sofa, Bedframe"), parsed on read. NO migration.
//
// The category pool itself is a maintained list: MaintenanceConfig.
// supplierCategories (Products → Products Maintenance → Supplier Categories),
// falling back to DEFAULT_SUPPLIER_CATEGORIES when unset/empty. The Suppliers
// list filter chips render from this pool + a synthetic "Mixed / Other" chip.
// ----------------------------------------------------------------------------

import { maintActiveValues, maintValues, type MaintPoolEntry } from '@2990s/shared';

/** Default/fallback pool when the maintained list is empty. */
export const DEFAULT_SUPPLIER_CATEGORIES = [
  'Sofa',
  'Bedframe',
  'Mattress',
  'Accessory',
  'Service',
] as const;

/** Resolve the supply-category pool: maintained list when non-empty,
 *  otherwise the default five.
 *  ACTIVE toggles (owner spec 2026-06-12): entries may be plain strings
 *  (= active) or { value, active } — only ACTIVE values feed the filter
 *  chips + form toggles. Suppliers already carrying an inactive value still
 *  display it (displaySupplierCategories passes unknown values through).
 *  The default-five fallback triggers only when the maintained list has no
 *  entries AT ALL (not when every entry is merely inactive). */
export function resolveSupplierCategoryPool(
  maintained: MaintPoolEntry[] | undefined | null,
): string[] {
  const all = maintValues(maintained).map((v) => v.trim()).filter(Boolean);
  if (all.length === 0) return [...DEFAULT_SUPPLIER_CATEGORIES];
  return maintActiveValues(maintained).map((v) => v.trim()).filter(Boolean);
}

/** Parse the stored comma-joined text into a clean list.
 *  "Sofa, Bedframe" → ['Sofa', 'Bedframe']. Null/empty → []. */
export function parseSupplierCategories(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Join a picked list back into the stored text form. */
export function joinSupplierCategories(values: string[]): string {
  return values.map((v) => v.trim()).filter(Boolean).join(', ');
}

/** Case-insensitive membership test against the pool. Legacy rows may carry
 *  uppercase enum values ('SOFA') — those still match pool entry 'Sofa'. */
function inPool(value: string, pool: string[]): boolean {
  const lc = value.trim().toLowerCase();
  return pool.some((p) => p.trim().toLowerCase() === lc);
}

/** Does this supplier's stored category text match the given pool chip?
 *  Matches when the parsed list INCLUDES the value (case-insensitive) —
 *  a sofa+bedframe supplier appears under BOTH Sofa and Bedframe. */
export function supplierMatchesCategory(
  text: string | null | undefined,
  chipValue: string,
): boolean {
  const lc = chipValue.trim().toLowerCase();
  return parseSupplierCategories(text).some((v) => v.toLowerCase() === lc);
}

/** "Mixed / Other" chip: ≥2 categories OR any value not in the pool.
 *  (Legacy single 'MIXED' rows land here via the not-in-pool branch.) */
export function supplierIsMixedOrOther(
  text: string | null | undefined,
  pool: string[],
): boolean {
  const list = parseSupplierCategories(text);
  if (list.length === 0) return false;
  if (list.length >= 2) return true;
  return !inPool(list[0]!, pool);
}

/** Display form for the SUPPLY CATEGORY column / info cell: every parsed
 *  value joined with ", ". Values that case-insensitively match a pool entry
 *  render with the pool's casing (legacy 'SOFA' → 'Sofa'); legacy 'MIXED'
 *  renders as 'Mixed / Other'. Empty → '—' is the caller's concern. */
export function displaySupplierCategories(
  text: string | null | undefined,
  pool: string[],
): string {
  return parseSupplierCategories(text)
    .map((v) => {
      const hit = pool.find((p) => p.trim().toLowerCase() === v.toLowerCase());
      if (hit) return hit;
      if (v.toUpperCase() === 'MIXED') return 'Mixed / Other';
      return v;
    })
    .join(', ');
}

/** Toggle a value in a comma-joined stored text — used by the checkbox /
 *  chip-toggle pickers on the supplier create + edit forms. Toggling a pool
 *  value that matches a legacy-cased entry (e.g. 'SOFA' vs pool 'Sofa')
 *  removes the legacy entry rather than duplicating it. */
export function toggleSupplierCategory(
  text: string | null | undefined,
  value: string,
): string {
  const list = parseSupplierCategories(text);
  const lc = value.trim().toLowerCase();
  const without = list.filter((v) => v.toLowerCase() !== lc);
  if (without.length !== list.length) return joinSupplierCategories(without);
  return joinSupplierCategories([...list, value]);
}
