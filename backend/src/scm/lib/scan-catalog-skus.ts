// The SKUs the slip scan may offer the model. Same rule as the SO picker
// (mfg-products.ts list) and validateItemCodes: a SKU under an inactive Model
// is inactive (BUG-50), even while its own status reads ACTIVE. Offering one
// lets the model pick a code the create then refuses on both attempts.

import { MFG_PRODUCT_CATEGORIES } from '../shared/product-categories';

export type ScanCatalogRow = {
  code: string;
  name: string;
  category: string;
  base_model: string | null;
  model?: { active?: boolean | null } | Array<{ active?: boolean | null }> | null;
};

export type CatalogSku = { code: string; name: string; category: string; baseModel: string | null };

export function scanCatalogSkus(rows: ScanCatalogRow[] | null): CatalogSku[] {
  return (rows ?? [])
    .filter((p) => (Array.isArray(p.model) ? p.model[0] : p.model)?.active !== false)
    .map((p) => ({ code: p.code, name: p.name, category: p.category, baseModel: p.base_model ?? null }));
}

/* The order the scan prompt lists SKU sections in: every product category, the
   SERVICE fees last. It printed only five, so a Dining / Carpet / Sofa Accessory
   SKU was never offered to the model (HC-0258). */
export const SCAN_CATALOG_CATEGORY_ORDER: readonly string[] = [
  ...MFG_PRODUCT_CATEGORIES.filter((c) => c !== 'SERVICE'),
  'SERVICE',
];
