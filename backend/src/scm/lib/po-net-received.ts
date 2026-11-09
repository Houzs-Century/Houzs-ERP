/** What one GRN line still counts as received against its PO line: accepted,
 *  less units sent back on a return the supplier will REPLACE. Units returned
 *  with no replacement (returned_closed_qty, HC-0221) stay counted, so the PO
 *  line does not re-open for goods nobody is sending. Clamped at 0. */
export function grnLineNetReceived(r: {
  qty_accepted: number | null;
  returned_qty: number | null;
  returned_closed_qty: number | null;
}): number {
  const reopened = Number(r.returned_qty ?? 0) - Number(r.returned_closed_qty ?? 0);
  return Math.max(0, Number(r.qty_accepted ?? 0) - Math.max(0, reopened));
}
