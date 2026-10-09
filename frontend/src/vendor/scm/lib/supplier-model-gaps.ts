// Codes a supplier is missing under Models it already supplies (BUG-97).
//
// Ticking a new compartment on a Model creates its SKU (product-models PATCH)
// but binds it to no supplier, and the supplier's SKU Pricing tab lists bound
// codes only. So a purchaser who adds 9028-2B(LHF) finds no row to price on any
// of the five suppliers that already map 9028. This lists those codes, with the
// supplier code each would get, so the tab can offer to map them.

import type { BindingRow, NewBinding } from './suppliers-queries';
import type { MfgProductRow } from './mfg-products-queries';
import { suffixForSku } from './supplier-sku-helpers';

export type ModelSkuGap = {
  product: MfgProductRow;
  supplierSku: string;
  sibling: BindingRow;
};

/* The supplier's own code for a sibling SKU, with the sibling's variant swapped
   for the new one: "AMN-SF9028 SOFA 1A(LHF)" -> "AMN-SF9028 SOFA 2B(LHF)",
   "5530-1A(LHF)" -> "5530-2B(LHF)". Suppliers write their codes in their own
   shapes, so the shape is copied, not rebuilt. When the sibling's code does not
   end in its variant there is no shape to copy, and the internal code is used,
   the same default the single add-binding form falls back to. */
export function supplierSkuFromSibling(
  sibling: Pick<BindingRow, 'supplier_sku'>,
  siblingProduct: Pick<MfgProductRow, 'code' | 'category' | 'size_code'>,
  product: Pick<MfgProductRow, 'code' | 'category' | 'size_code'>,
): string {
  const oldSuffix = suffixForSku(siblingProduct);
  const newSuffix = suffixForSku(product);
  const sku = sibling.supplier_sku;
  if (oldSuffix && newSuffix && sku.endsWith(oldSuffix) && sku.length > oldSuffix.length) {
    return sku.slice(0, sku.length - oldSuffix.length) + newSuffix;
  }
  return product.code;
}

export function findModelSkuGaps(
  bindings: BindingRow[],
  products: MfgProductRow[],
): ModelSkuGap[] {
  const productByCode = new Map(products.map((p) => [p.code, p]));
  const bound = new Set<string>();
  const siblingByModel = new Map<string, { binding: BindingRow; product: MfgProductRow }>();
  for (const b of bindings) {
    if (b.material_kind !== 'mfg_product') continue;
    bound.add(b.item_code);
    const p = productByCode.get(b.item_code);
    if (!p?.model_id) continue;
    const prev = siblingByModel.get(p.model_id);
    // Prefer a sibling whose code carries its variant, so the shape can be copied.
    const carries = (x: { binding: BindingRow; product: MfgProductRow }) => {
      const s = suffixForSku(x.product);
      return Boolean(s) && x.binding.supplier_sku.endsWith(s);
    };
    if (!prev || (!carries(prev) && carries({ binding: b, product: p }))) {
      siblingByModel.set(p.model_id, { binding: b, product: p });
    }
  }

  const gaps: ModelSkuGap[] = [];
  for (const p of products) {
    if (!p.model_id || p.status !== 'ACTIVE' || p.one_shot) continue;
    if (bound.has(p.code)) continue;
    const sib = siblingByModel.get(p.model_id);
    if (!sib) continue;
    gaps.push({
      product: p,
      supplierSku: supplierSkuFromSibling(sib.binding, sib.product, p),
      sibling: sib.binding,
    });
  }
  return gaps.sort((a, b) => a.product.code.localeCompare(b.product.code));
}

/* No price: a compartment's cost is its own, so the row lands empty for the
   purchaser to fill in the table. Lead time, MOQ, currency and the Main flag
   follow the sibling so the new code behaves like the rest of the Model. */
export function gapToNewBinding(g: ModelSkuGap): NewBinding {
  return {
    materialKind: 'mfg_product',
    itemCode: g.product.code,
    materialName: g.product.name || g.product.code,
    supplierSku: g.supplierSku,
    currency: g.sibling.currency,
    leadTimeDays: g.sibling.lead_time_days,
    moq: g.sibling.moq,
    isMainSupplier: g.sibling.is_main_supplier,
  };
}
