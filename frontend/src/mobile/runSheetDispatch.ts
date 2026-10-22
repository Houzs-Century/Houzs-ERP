/*
 * Run-sheet "dispatched" test — which board stops belong on the driver run-sheet.
 *
 * Owner 2026-10-22: the driver run-sheet's day buckets list only stops that are
 * actually going out — a real (cut) delivery order, OR a named driver assigned.
 * An order that merely carries today's customer delivery date, with no DO and no
 * driver, is NOT on anyone's run yet; it stays on the desktop Delivery Planning
 * board until it is scheduled, and is left off the run-sheet.
 *
 * Why the two arms (DO *or* driver), not one:
 *  - Delivery (SO) stops get a DO when they are scheduled; a cut DO counts even
 *    before a driver is picked (the 24 "DO cut, driver pending" jobs still show).
 *  - SETUP / DISMANTLE and manual DP legs carry NO DO at all — their crew comes
 *    straight from the project / trip — so the driver-name arm is the only thing
 *    that keeps them on the sheet.
 * A real driver only ever sees stops crewed to them, so every stop they see is
 * dispatched by this rule; the filter changes only the whole-board (admin) view.
 *
 * The board feed already drops DRAFT / CANCELLED DOs before they reach a row
 * (delivery-planning route), so any delivery_orders entry here is a committed DO.
 */
export interface DispatchStop {
  delivery_orders?: { id?: string | null }[] | null;
  crew?: { driver?: string | null } | null;
}

export function isDispatched(o: DispatchStop): boolean {
  const hasDo = (o.delivery_orders ?? []).some((d) => !!d && !!d.id);
  const hasDriver = !!o.crew?.driver && o.crew.driver.trim().length > 0;
  return hasDo || hasDriver;
}
