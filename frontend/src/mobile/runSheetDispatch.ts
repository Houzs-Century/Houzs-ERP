/*
 * Run-sheet "dispatched" test — which board stops belong on the driver run-sheet.
 *
 * Owner 2026-10-25 (tightened from 2026-10-22). A DELIVERY (SO) stop joins a
 * driver's run-sheet only when it is FULLY dispatched:
 *   1. a cut delivery order exists,
 *   2. that DO's own date matches the order's DELIVERY DATE — the amended date
 *      if set, else the original customer delivery date; NOT the sales-exemption
 *      -expiry date and NOT the processing date, and
 *   3. a driver is assigned.
 * An order with a DO but no driver yet ("DO cut, driver pending") is NOT on the
 * sheet — it stays on the desktop Delivery Planning board until a driver is put
 * on it (owner: 有司机信息才放进去). A DO whose own date disagrees with the
 * order's Delivery Date is a stale / mismatched document and does not count.
 *
 * SETUP / DISMANTLE and manual DP / service legs carry NO DO at all — their crew
 * comes straight from the project / trip — so for them a named driver is the
 * only gate (the DO + date rule cannot apply to a job that never has a DO). That
 * is what keeps a crewed Dismantle on the sheet.
 *
 * A real driver only ever sees stops crewed to them, so every stop they see is
 * dispatched by this rule; the filter changes only the whole-board (admin
 * preview) view. The board feed already drops DRAFT / CANCELLED DOs before they
 * reach a row, so any delivery_orders entry here is a committed DO.
 */
export interface DispatchStop {
  // Row kind: 'so' = a Sales-Order delivery; anything else (project / dp / assr)
  // is a non-delivery leg that never carries a DO. Absent → treated as a
  // delivery (the strictest arm), so a mislabelled row is never let through on
  // the weaker crew-only gate.
  row_type?: string | null;
  delivery_orders?: { id?: string | null }[] | null;
  crew?: { driver?: string | null } | null;
  // The latest DO's own document date (= its delivery date), from the feed.
  do_date?: string | null;
  // The order's Delivery Date — amended wins, else the original customer date.
  amended_delivery_date?: string | null;
  customer_delivery_date?: string | null;
}

export function isDispatched(o: DispatchStop): boolean {
  const hasDriver = (o.crew?.driver ?? "").trim().length > 0;
  // Non-delivery legs (Setup / Dismantle, service, manual DP) never carry a DO;
  // a named driver is the only thing that puts them on the sheet.
  if ((o.row_type ?? "so") !== "so") return hasDriver;
  // A delivery stop needs a cut DO AND a driver AND a DO date that matches the
  // order's Delivery Date (owner 2026-10-25).
  const hasDo = (o.delivery_orders ?? []).some((d) => !!d.id);
  if (!hasDo || !hasDriver) return false;
  const deliveryDate = (o.amended_delivery_date ?? o.customer_delivery_date ?? "").slice(0, 10);
  const doDate = (o.do_date ?? "").slice(0, 10);
  return deliveryDate !== "" && doDate === deliveryDate;
}
