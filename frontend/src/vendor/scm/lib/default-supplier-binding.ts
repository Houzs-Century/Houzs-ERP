import type { SupplierStatus } from './suppliers-queries';

type MaterialBinding = { is_main_supplier: boolean; supplier: { id: string; status: SupplierStatus } };

/** The supplier binding a new PO adopts when the buyer picks an item before any
 *  supplier: the only supplier that carries it, else its one main supplier.
 *  Several (or no) main suppliers is a real choice, so nothing is adopted.
 *  A main supplier that is not ACTIVE is never adopted: the supplier picker does
 *  not offer it. Callers only ask while the supplier is still empty, so a
 *  supplier the buyer already chose is never overwritten. */
export function defaultSupplierBinding<T extends MaterialBinding>(bindings: readonly T[]): T | null {
  if (bindings.length === 1) return bindings[0] ?? null;
  const mains = bindings.filter((b) => b.is_main_supplier && b.supplier.status === 'ACTIVE');
  return mains.length === 1 ? mains[0] ?? null : null;
}
