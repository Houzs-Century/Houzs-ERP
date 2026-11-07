// A driver's or helper's warehouse, picked in the row (owner 2026-11-07): the warehouse
// they work from, so a Penang crew is told apart from a Klang Valley one.
import { groupWarehouses, type WarehouseLite } from "./lorryModel";

export function CrewWarehouseCell({ value, warehouses, onChange, label }: {
  value: string | null; warehouses: WarehouseLite[]; onChange: (id: string | null) => void; label: string;
}) {
  return (
    <select value={value ?? ""} aria-label={label} onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.value || null)}
      className="min-h-[32px] max-w-[190px] rounded-md border border-border bg-surface px-2 text-[12px] text-ink">
      <option value="">Not set</option>
      {groupWarehouses(warehouses).map((g) => (
        <optgroup key={g.region} label={g.region}>{g.items.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</optgroup>
      ))}
    </select>
  );
}
