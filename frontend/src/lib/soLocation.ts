
export type SoLocationSource = {
  warehouse_name?: string | null;
  sales_location?: string | null;
};

export type SoLocation = {
  label: string | null;
  isWarehouse: boolean;
};

const trimmed = (v: string | null | undefined): string | null => {
  const s = (v ?? "").trim();
  return s === "" ? null : s;
};

export const resolveSoLocation = (
  row: SoLocationSource | null | undefined
): SoLocation => {
  const warehouse = trimmed(row?.warehouse_name);
  if (warehouse) return { label: warehouse, isWarehouse: true };
  return { label: trimmed(row?.sales_location), isWarehouse: false };
};
