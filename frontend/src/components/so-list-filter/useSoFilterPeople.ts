// People for the "Created by / Salesperson — is <person>" rows, and the name a
// row prints. Options come from the COMPANY-SCOPED pickable roster (the same
// list every salesperson picker uses); names resolve through the display roster
// so a row naming someone who has since left still reads as a name.
import { useMemo } from "react";
import { usePickableStaff } from "../../vendor/scm/lib/admin-queries";
import { useStaffLookup } from "../../hooks/useStaffLookup";
import { soFilterField, type SoListFilter } from "../../vendor/shared/so-list-filter-model";
import type { SoFilterPerson } from "./SoFilterValueEditor";

export function useSoFilterPeople(rows: readonly SoListFilter[]): {
  people: SoFilterPerson[];
  nameOf: (staffId: string) => string;
} {
  const include = rows.filter((r) => r.op === "is" && soFilterField(r.field)?.kind === "person").map((r) => r.value);
  const pickable = usePickableStaff({ include });
  const { byId } = useStaffLookup();
  const people = useMemo(
    () =>
      (pickable.data ?? [])
        .map((s) => ({ id: s.id, name: (s.name || s.staffCode || "").trim() }))
        .filter((p) => p.name)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [pickable.data],
  );
  const nameOf = (id: string) => byId.get(id) || people.find((p) => p.id === id)?.name || "";
  return { people, nameOf };
}
