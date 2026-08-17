// ----------------------------------------------------------------------------
// grn-consumption-flags — has_children / fully_invoiced / fully_returned, from a
// GRN's own lines.
//
// Lived inside routes/grns.ts until 2026-08-17. It moved because it is the
// CANONICAL definition and four other route files say so in prose — each carries
// a comment reading "mirrors computeGrnFlags in routes/grns.ts"
// (mfg-purchase-orders, mfg-sales-orders, delivery-orders-mfg,
// purchase-invoices), and migration 0267 names it twice. A definition that five
// places defer to should not be a private function halfway down a 3,600-line
// router, and the file-size ratchet asks for exactly this split.
//
// Pure: no client, no io. That is the point — the mirrors above are SQL and
// per-route predicates that must agree with it, so it has to be testable on its
// own rather than only through a route.
//
// THE RULE. A line with qty_accepted = 0 is treated as already satisfied — there
// is nothing on it to consume — which is why `accepted` is filtered first and why
// a GRN with no accepted lines is neither fully invoiced nor fully returned
// (`accepted.length > 0`). Without that, an all-zero receipt would read as
// "fully consumed" and drop out of the outstanding list with nothing billed.
// ----------------------------------------------------------------------------

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
