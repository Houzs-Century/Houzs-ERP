// ----------------------------------------------------------------------------
// HC-0153 (Sim 2026-10-23, "Why item has been deactive still can choose for
// create PO?"): a SKU deactivated in SKU Master stayed pickable on the PO
// because the Item Code dropdown lists the supplier's bindings, and
// supplier_material_bindings has no status of its own. The dropdown now drops
// those; this is the server half, the same requireActive rule the SO create
// path enforces (validate-item-codes.ts).
//
// Only a NEW pick is refused, and only of an mfg_product:
//   - an unknown code still passes — a PO may carry a one-off code the
//     catalogue does not hold (fabric / raw lines, or a supplier with no
//     bindings), so existence is not this gate's business;
//   - a line linked to an SO line passes — its code must equal the SO line's
//     (soLinkItemMismatch), and a confirmed order for a since-retired SKU still
//     has to be bought;
//   - an edit that keeps the stored code passes — the caller only asks when
//     the code moves, so a legacy line stays editable.
// ----------------------------------------------------------------------------

import { validateItemCodes, unknownItemCodeResponse } from './validate-item-codes';

export type PoPickLine = {
  materialKind?: unknown;
  itemCode?: unknown;
  soItemId?: unknown;
};

export async function poInactivePickRefusal(
  sb: any,
  companyId: number | null,
  lines: readonly PoPickLine[],
): Promise<ReturnType<typeof unknownItemCodeResponse> | null> {
  const codes = lines
    .filter((l) => (l.materialKind ?? 'mfg_product') === 'mfg_product' && !l.soItemId)
    .map((l) => String(l.itemCode ?? ''));
  const check = await validateItemCodes(sb, codes, companyId, { requireActive: true });
  if (check.ok || check.inactive.length === 0) return null;
  return unknownItemCodeResponse([], check.inactive);
}
