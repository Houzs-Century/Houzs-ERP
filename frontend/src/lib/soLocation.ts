/* The SO Location column, resolved once for desktop and mobile.

   `sales_location` is free text with no FK — it is a snapshot taken at create
   time and rows exist holding a CITY ("Johor Bahru") instead of a warehouse,
   which matches no warehouse downstream. `warehouse_name` is the real relation,
   read from the SO's primary line `warehouse_id`. Mobile already preferred it
   and desktop did not, so one SO rendered two different locations. Prefer the
   relation everywhere, and tell the caller when it fell back so a guess is
   never styled like a fact. */

export type SoLocationSource = {
  warehouse_name?: string | null;
  sales_location?: string | null;
};

export type SoLocation = {
  label: string | null;
  /* false = the label is unverified free text, not a resolved warehouse. */
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
