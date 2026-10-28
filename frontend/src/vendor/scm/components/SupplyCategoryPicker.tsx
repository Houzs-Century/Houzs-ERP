// ----------------------------------------------------------------------------
// SupplyCategoryPicker — multi-select chip toggles for a supplier's Supply
// Category (owner spec 2026-06-12).
//
// A supplier can supply MULTIPLE categories; storage stays the existing
// suppliers.category text column, comma-joined ("Sofa, Bedframe") — see
// lib/supplier-categories.ts. The chip pool is the maintained list
// MaintenanceConfig.supplierCategories (Products → Maintenance → Products
// Maintenance → Supplier Categories), falling back to the default five.
//
// Used by the New Supplier drawer (Suppliers.tsx) and the Supplier Info
// edit form (SupplierDetail.tsx).
// ----------------------------------------------------------------------------

import type { CSSProperties } from 'react';
import { maintActiveValues } from '@2990s/shared';
import { useMaintenanceConfig } from '../lib/mfg-products-queries';
import {
  parseSupplierCategories,
  resolveSupplierCategoryPool,
  toggleSupplierCategory,
} from '../lib/supplier-categories';

/** Resolve the Supply Category pool from the master maintenance config,
 *  falling back to the default five when unset/empty. */
export function useSupplierCategoryPool(): string[] {
  const resolved = useMaintenanceConfig('master');
  return resolveSupplierCategoryPool(maintActiveValues(resolved.data?.data?.supplierCategories));
}

const chipStyle = (active: boolean): CSSProperties => ({
  fontFamily: 'var(--font-button)',
  fontSize: 'var(--fs-12)',
  fontWeight: 600,
  letterSpacing: '0.02em',
  padding: '4px var(--space-3)',
  borderRadius: 'var(--radius-pill)',
  border: active ? '1px solid var(--c-ink)' : '1px solid var(--line)',
  background: active ? 'var(--c-ink)' : 'var(--c-paper)',
  color: active ? 'var(--c-cream)' : 'var(--c-ink)',
  cursor: 'pointer',
});

export const SupplyCategoryPicker = ({
  value,
  onChange,
  labelClassName,
  fieldClassName,
}: {
  /** The stored comma-joined text ("Sofa, Bedframe"). */
  value: string;
  onChange: (next: string) => void;
  labelClassName?: string;
  fieldClassName?: string;
}) => {
  const pool = useSupplierCategoryPool();
  const picked = parseSupplierCategories(value);
  const pickedLc = picked.map((v) => v.toLowerCase());
  // Legacy / out-of-pool values still stored on the row (e.g. old uppercase
  // enum 'MIXED') — surface them as active chips so they can be toggled OFF;
  // they are never offered for fresh selection.
  const extras = picked.filter(
    (v) => !pool.some((p) => p.trim().toLowerCase() === v.toLowerCase()),
  );

  return (
    <label className={fieldClassName} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span className={labelClassName}>Supply Category</span>
      <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
        {pool.map((p) => {
          const active = pickedLc.includes(p.trim().toLowerCase());
          return (
            <button
              key={p}
              type="button"
              style={chipStyle(active)}
              onClick={() => onChange(toggleSupplierCategory(value, p))}
            >
              {p}
            </button>
          );
        })}
        {extras.map((v) => (
          <button
            key={`extra-${v}`}
            type="button"
            style={chipStyle(true)}
            title="Not in the maintained pool — click to remove"
            onClick={() => onChange(toggleSupplierCategory(value, v))}
          >
            {v}
          </button>
        ))}
      </span>
      <span style={{ fontSize: 'var(--fs-10)', color: 'var(--fg-muted)' }}>
        Pick every category this supplier supplies. Pool is maintained under
        Products → Maintenance → Supplier Categories.
      </span>
    </label>
  );
};
