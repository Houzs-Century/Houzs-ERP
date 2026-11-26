import { useMemo } from "react";
import { usePickableStaff } from "../../vendor/scm/lib/admin-queries";
import { useWarehouses } from "../../vendor/scm/lib/inventory-queries";
import { useStaffLookup } from "../../hooks/useStaffLookup";
import { soFilterField, type SoFilterLabels, type SoListFilter } from "../../vendor/shared/so-list-filter-model";

export interface SoFilterOption {
  id: string;
  name: string;
}

export interface SoFilterLookups {
  people: SoFilterOption[];
  warehouses: SoFilterOption[];
  labels: SoFilterLabels;
}

export function useSoFilterLookups(rows: readonly SoListFilter[]): SoFilterLookups {
  const include = rows.filter((r) => r.op === "is" && soFilterField(r.field)?.kind === "person").map((r) => r.value);
  const pickable = usePickableStaff({ include });
  const warehousesQ = useWarehouses({ includeInactive: true });
  const { byId } = useStaffLookup();
  const people = useMemo(
    () =>
      (pickable.data ?? [])
        .map((s) => ({ id: s.id, name: (s.name || s.staffCode || "").trim() }))
        .filter((p) => p.name)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [pickable.data],
  );
  const warehouses = useMemo(
    () =>
      (warehousesQ.data ?? [])
        .map((w) => ({ id: w.id, name: (w.name || w.code || "").trim() }))
        .filter((w) => w.name)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [warehousesQ.data],
  );
  return {
    people,
    warehouses,
    labels: {
      staff: (id) => byId.get(id) || people.find((p) => p.id === id)?.name || "",
      warehouse: (id) => warehouses.find((w) => w.id === id)?.name || "",
    },
  };
}
