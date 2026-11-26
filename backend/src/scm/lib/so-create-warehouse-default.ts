
import {
  chooseCreateWarehouseDefault,
  warehouseIdFromSalesLocation,
  type WarehouseRow,
} from './so-warehouse';
import { warehouseLabel } from './warehouse-label';

export type CreateWarehouseDefaults = {
  explicitSalesLocation: string | null;
  defaultWarehouseId: string | null;
  operatorStoreLabel: string | null;
};

export async function resolveCreateWarehouseDefaults(i: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the untyped supabase client this SCM tree passes around
  sb: any;
  scope: <Q>(q: Q) => Q;
  bodySalesLocation: unknown;
  stateWarehouseIdOf: () => Promise<string | null>;
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
