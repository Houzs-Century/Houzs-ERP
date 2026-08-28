// ----------------------------------------------------------------------------
// so-create-warehouse-default — the reads that feed chooseCreateWarehouseDefault
// (lib/so-warehouse.ts) at SO create.
//
// The DECISION lives there, pure and pinned; this file only gathers its
// inputs: the trimmed explicit Location, that Location resolved against the
// ACTIVE company's warehouse master, the State mapping, and the creating
// operator's own store (scm.staff.showroom_warehouse_id) — verified against
// the same company-scoped master, because scm.staff is ONE SHARED table
// (staff.ts) and an unverified id could bind a Houzs order to a 2990 showroom.
//
// The warehouse master is read AT MOST ONCE per create, lazily — only when an
// explicit Location needs resolving or the store fallback is reachable — and
// a FAILED read is logged and yields an empty master rather than being
// silently discarded: the fallback simply does not fire, which is the exact
// pre-2026-08-25 behaviour (lines default NULL and the [null-warehouse]
// signal names them).
// ----------------------------------------------------------------------------

import {
  chooseCreateWarehouseDefault,
  warehouseIdFromSalesLocation,
  type WarehouseRow,
} from './so-warehouse';
import { warehouseLabel } from './warehouse-label';

export type CreateWarehouseDefaults = {
  /** body.salesLocation, trimmed; null when the caller sent none/blank. The
   *  header chain must use THIS, not the raw body value — a caller sending ''
   *  must not pin an empty-string Location past both fallbacks while the
   *  lines fall through to the store. */
  explicitSalesLocation: string | null;
  /** The per-line default (chooseCreateWarehouseDefault's verdict). */
  defaultWarehouseId: string | null;
  /** The store's display label (warehouseLabel: code, else name) — non-null
   *  exactly when the store decided, so the header's sales_location can fall
   *  back to the same place the lines were bound to. */
  operatorStoreLabel: string | null;
};

export async function resolveCreateWarehouseDefaults(i: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the untyped supabase client this SCM tree passes around
  sb: any;
  /** The caller's company-scoping wrapper (scopeToCompany bound to a ctx). */
  scope: <Q>(q: Q) => Q;
  bodySalesLocation: unknown;
  /** Thunk so the State read (deriveWarehouseIdFromState, which lives in the
   *  route and needs its ctx) is only paid when no explicit Location resolved. */
  stateWarehouseIdOf: () => Promise<string | null>;
  /** The creating operator's scm.staff row (or null) — showroom_warehouse_id
   *  is dual-read snake/camel here, the pg-driver camelCase trap. */
  callerStaff: unknown;
}): Promise<CreateWarehouseDefaults> {
  const staffRec = (i.callerStaff ?? null) as Record<string, unknown> | null;
  const staffShowroomWarehouseId =
    ((staffRec?.showroomWarehouseId ?? staffRec?.showroom_warehouse_id) as
      | string | null | undefined) ?? null;
  const explicitSalesLocation =
    typeof i.bodySalesLocation === 'string' && i.bodySalesLocation.trim() !== ''
      ? i.bodySalesLocation.trim()
      : null;

  let master: WarehouseRow[] | null = null;
  const loadMaster = async (): Promise<WarehouseRow[]> => {
    if (master) return master;
    const { data, error } = await i.scope(i.sb.from('warehouses').select('id, code, name'));
    if (error) {
      /* eslint-disable-next-line no-console */
      console.error('[so-create] warehouse master read failed — store/location default disabled for this create:', error.message ?? error);
    }
    master = (data ?? []) as WarehouseRow[];
    return master;
  };

  const salesLocationWarehouseId = explicitSalesLocation
    ? warehouseIdFromSalesLocation(explicitSalesLocation, await loadMaster())
    : null;
  const stateWarehouseId = salesLocationWarehouseId ? null : await i.stateWarehouseIdOf();

  let operatorStore: { id: string; label: string } | null = null;
  if (!salesLocationWarehouseId && !stateWarehouseId && !explicitSalesLocation
      && staffShowroomWarehouseId) {
    const hit = (await loadMaster()).find((w) => w.id === staffShowroomWarehouseId);
    const label = hit ? warehouseLabel(hit) : null;
    if (hit && label) operatorStore = { id: hit.id, label };
  }

  const verdict = chooseCreateWarehouseDefault({
    explicitSalesLocation,
    salesLocationWarehouseId,
    stateWarehouseId,
    operatorStoreWarehouseId: operatorStore?.id ?? null,
  });
  return {
    explicitSalesLocation,
    defaultWarehouseId: verdict.warehouseId,
    operatorStoreLabel: verdict.usedOperatorStore ? operatorStore?.label ?? null : null,
  };
}
