// ----------------------------------------------------------------------------
// newSkuPosActive — whether a NEW SKU starts on the 2990 POS tablet.
//
// pos_active is the POS's own shelf flag: GET /pos-pools/mfg-catalog lists only
// pos_active SKUs, and 2990's Modular "Show in POS" switch writes it (PATCH
// /mfg-products/:id posActive). The order and purchase side never reads it —
// validateItemCodes, the SO picker and POs go by status and the Model's active —
// so a hidden SKU is still priced in the SKU Master, sold here and bought.
//
// 2990's owner (2026-10-24): a new SKU must stay off the tablet until someone
// switches it on in Modular. That switch is offered for the single-SKU
// categories (every category but SOFA / BEDFRAME / MATTRESS, whose SKUs are
// variants their Model's options already gate), so those start hidden in
// company 2. Every other company keeps the column default.
// ----------------------------------------------------------------------------

import { C2990 } from './mirror-map';
import { isSingleSkuCategory } from '../shared/product-categories';

export function newSkuPosActive(companyId: number, category: string | null): boolean {
  return !(companyId === C2990 && isSingleSkuCategory(category));
}
