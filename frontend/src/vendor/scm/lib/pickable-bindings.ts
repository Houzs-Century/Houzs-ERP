import type { BindingRow } from './suppliers-queries';

/* HC-0153: a supplier binding outlives its SKU — supplier_material_bindings has
   no status of its own, so a SKU deactivated in SKU Master stayed in the PO /
   PCO Item Code dropdown. The catalogue list (GET /mfg-products) is already
   ACTIVE-only with inactive Models dropped, so a binding is pickable only when
   its code is in it. This also decides which binding a typed Supplier SKU
   adopts: DIGLANT binds AK-SOLITUDE MATT (Q) to both the retired AKEMI and the
   live HAPPI SLEEP SKU, and the first match was the retired one. Only the
   picker is narrowed: price / cost lookups keep the full binding list so a
   legacy line on a now-inactive SKU still prices. */
export function pickableBindings(
  bindings: readonly BindingRow[],
  activeSkus: ReadonlyArray<{ code: string }>,
): BindingRow[] {
  const active = new Set(activeSkus.map((p) => p.code));
  return bindings.filter((b) => active.has(b.item_code));
}
