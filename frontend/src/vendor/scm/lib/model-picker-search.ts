import type { MfgProductRow } from './mfg-products-queries';
import type { ProductModelRow } from './product-models-queries';

type SkuFields = Pick<MfgProductRow, 'code' | 'name' | 'description' | 'barcode'>;

function skuMatches(sku: SkuFields, q: string): boolean {
  return (
    sku.code.toLowerCase().includes(q) ||
    sku.name.toLowerCase().includes(q) ||
    (sku.description ?? '').toLowerCase().includes(q) ||
    (sku.barcode ?? '').toLowerCase().includes(q)
  );
}

/** BUG-30: purchasers search by the SKU they see on a PO, not by the Model
 *  it sits under, so a Model row also matches when any of its SKUs does. */
export function modelMatchesSearch(
  model: Pick<ProductModelRow, 'model_code' | 'name' | 'branding'>,
  skus: SkuFields[],
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (
    model.model_code.toLowerCase().includes(q) ||
    model.name.toLowerCase().includes(q) ||
    (model.branding ?? '').toLowerCase().includes(q)
  ) return true;
  return skus.some((s) => skuMatches(s, q));
}

/** SKUs with no Model can only be mapped through the per-SKU picker; count the
 *  ones matching the search so the Model picker can point there. */
export function countModelessMatches(
  products: Array<SkuFields & Pick<MfgProductRow, 'model_id'>>,
  query: string,
): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  return products.filter((p) => !p.model_id && skuMatches(p, q)).length;
}
