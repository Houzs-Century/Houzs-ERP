// The names a filter row needs: people for "Created by / Salesperson — is
// <person>", warehouses for "Warehouse is <warehouse>", and the labels a row
// prints for an applied uuid. People come from the COMPANY-SCOPED pickable
// roster (the list every salesperson picker uses) and resolve through the
// display roster so someone who has left still reads as a name. Warehouses come
// from the company-scoped warehouse list, inactive ones included — an old order
// can sit in a warehouse that has since been closed.
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
