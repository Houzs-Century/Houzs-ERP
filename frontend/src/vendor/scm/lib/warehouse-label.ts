
export type WarehouseLabelSource = {
  code?: string | null;
  name?: string | null;
};

const trimmed = (v: string | null | undefined): string | null => {
  const s = (v ?? '').trim();
  return s === '' ? null : s;
};

export const warehouseLabel = (
  w: WarehouseLabelSource | null | undefined,
): string | null => {
  if (!w) return null;
  return trimmed(w.code) ?? trimmed(w.name);
};
