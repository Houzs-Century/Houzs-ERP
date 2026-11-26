
export type GrnConsumptionLine = {
  qty_accepted?: number | null;
  invoiced_qty?: number | null;
  returned_qty?: number | null;
};

export type GrnConsumptionFlags = {
  has_children: boolean;
  fully_invoiced: boolean;
  fully_returned: boolean;
};

export function computeGrnFlags(items: GrnConsumptionLine[]): GrnConsumptionFlags {
  const accepted = items.filter((r) => (r.qty_accepted ?? 0) > 0);
  const hasChildren = items.some((r) => (r.invoiced_qty ?? 0) > 0 || (r.returned_qty ?? 0) > 0);
  const fullyInvoiced = accepted.length > 0 && accepted.every((r) => (r.invoiced_qty ?? 0) >= (r.qty_accepted ?? 0));
  const fullyReturned = accepted.length > 0 && accepted.every((r) => (r.returned_qty ?? 0) >= (r.qty_accepted ?? 0));
  return { has_children: hasChildren, fully_invoiced: fullyInvoiced, fully_returned: fullyReturned };
}
