/*
 * Run-sheet "dispatched" test — which board stops belong on the driver run-sheet.
 *
 * Owner 2026-10-25 (tightened from 2026-10-22; delivery-date basis 2026-10-31).
 * A DELIVERY (SO) stop joins a driver's run-sheet when it is dispatched:
 *   1. a cut delivery order exists,
 *   2. a driver is assigned, and
 *   3. the order has a Delivery Date at all — the amended date if set, else the
 *      original customer delivery date (NOT the sales-exemption-expiry date and
 *      NOT the processing date).
 * An order with a DO but no driver yet ("DO cut, driver pending") is NOT on the
 * sheet — it stays on the desktop Delivery Planning board until a driver is put
 * on it (owner: 有司机信息才放进去). An order with no Delivery Date at all has no
 * day to belong to, so it is not on the sheet either.
 *
 * WHICH DAY a stop shows on is decided elsewhere, by runDateOf (the trip date, or
 * the order's effective delivery date — amended-aware) in MobileDeliveryPlanning;
 * this test only decides whether the stop is dispatched at all.
 *
 * WHY NO DO-DATE MATCH ANY MORE (owner 2026-10-31). This used to also require the
 * DO's OWN date to equal the order's Delivery Date. But the DO's date is its
 * document date (do_date = AutoCount DocDate), set when the DO was cut and NOT
 * moved when the order is rescheduled — a reschedule writes only the SO's
 * amended_delivery_date. So a rescheduled bill with a cut DO and a driver silently
 * dropped off the driver's phone (UMAR FARHAN: 6 bills due that day, 4 shown),
 * while still showing on the SO list and the desktop board. The day a stop is due
 * is already the amended-aware runDateOf, so the document-date match added nothing
 * but that bug, and it is gone.
 *
 * SETUP / DISMANTLE and manual DP / service legs carry NO DO at all — their crew
 * comes straight from the project / trip — so for them a named driver is the
 * only gate (the DO rule cannot apply to a job that never has a DO). That is what
 * keeps a crewed Dismantle on the sheet.
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
  // The order's Delivery Date — amended wins, else the original customer date.
  amended_delivery_date?: string | null;
  customer_delivery_date?: string | null;
}

export function isDispatched(o: DispatchStop): boolean {
  const hasDriver = (o.crew?.driver ?? "").trim().length > 0;
  // Non-delivery legs (Setup / Dismantle, service, manual DP) never carry a DO;
  // a named driver is the only thing that puts them on the sheet.
  if ((o.row_type ?? "so") !== "so") return hasDriver;
  // A delivery stop needs a cut DO, a driver, and a Delivery Date to sit on
  // (owner 2026-10-31). Which day it shows is runDateOf's job, not this test's —
  // so the DO's own document date is deliberately not compared here.
  const hasDo = (o.delivery_orders ?? []).some((d) => !!d.id);
  if (!hasDo || !hasDriver) return false;
  const deliveryDate = (o.amended_delivery_date ?? o.customer_delivery_date ?? "").slice(0, 10);
  return deliveryDate !== "";
}
